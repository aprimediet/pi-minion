# minion v2.1.1 — Model Loading Fix (Revised)

> **Type:** Bugfix release (additive, non-breaking on v2.1.0).
> **Scope:** Fix two bugs where model is not loaded when switching primary agents or editing `settings.json`.

## 1. Bugs

### Bug 1 — `onModelChanged` persists model without provider

When the user changes model via the model selector while in a primary agent (plan/build/etc.),
the change is persisted to `~/.pi/agent/settings.json` under `agents[<name>].model`. The persisted
value is **just the model id** (e.g. `"claude-sonnet-4-5"`) instead of the full `provider/model-id`
format (e.g. `"anthropic/claude-sonnet-4-5"`).

This happens because `onModelChanged` calls `modelId(model)` which only extracts `.id`, ignoring
`.provider`. Model.id in pi is the bare model name; the full ID is `provider + "/" + id`.

### Bug 2 — Format mismatch on reload

Because `onModelChanged` writes just the model name, when `setModelFor` reads it back during
a primary switch:

1. `resolvedModelId = "claude-sonnet-4-5"` (no `/`)
2. `hasProvider = false` → skip `ctx.modelRegistry.find(provider, modelName)`
3. Fallback to `ctx.modelRegistry.getAll().find(m => m.id === id || m.name === id)`
4. **Fragile**: fails when id/name don't match or modelRegistry scope is limited

The user-visible symptom: "model is not loaded from configuration" after switching primaries.

## 2. Correct Flow

```
1. Session start
   ├─ pi resolves default model → ctx.model = Model{ provider:"anthropic", id:"claude-sonnet-4-5" }
   └─ controller.apply("build", ctx)
        └─ setModelFor(build):
             ├─ readOverrides → check settings.json#agents.build.model
             ├─ if found: resolve via modelRegistry → pi.setModel(Model)
             └─ if not: restore snapshot → pi.setModel(snapshot.model) → keep default

2. User changes model to "opencode/big-pickle" (via model selector)
   ├─ model_select event fires
   ├─ controller.onModelChanged(event.model, ctx)
   │    ├─ model.provider = "opencode", model.id = "big-pickle"
   │    ├─ fullId = "opencode/big-pickle"
   │    └─ writeOverride("plan", { model: "opencode/big-pickle" })
   │       → settings.json: { "agents": { "plan": { "model": "opencode/big-pickle" } } }
   └─ model applied by pi internally

3. User Shift+Tab → cycle to build (no model in settings)
   ├─ setModelFor(build):
   │    ├─ resolvedModelId = undefined
   │    └─ restore snapshot → pi.setModel(snapshot.model) → restore to default
   └─ active = build

4. User Shift+Tab → cycle to plan
   ├─ setModelFor(plan):
   │    ├─ resolvedModelId = "opencode/big-pickle"
   │    ├─ split → provider="opencode", modelName="big-pickle"
   │    ├─ modelRegistry.find("opencode", "big-pickle") → Model object
   │    └─ pi.setModel(Model) ✓
   └─ active = plan

5. User changes model to "anthropic/claude-sonnet-4-5" (via model selector)
   ├─ onModelChanged(model, ctx)
   │    └─ writeOverride("plan", { model: "anthropic/claude-sonnet-4-5" })
   │       → settings.json updated: plan.model = "anthropic/claude-sonnet-4-5"
   └─ Next cycle to plan → load "anthropic/claude-sonnet-4-5" ← consistent
```

## 3. Root Cause

`onModelChanged` in `primaries.ts` uses `modelId(m)` which only returns `m.id`:

```ts
function modelId(m: { id: string } | Model<any>): string {
    return (m as { id?: string }).id ?? "";
}

function onModelChanged(model, _ctx) {
    if (!active) return;
    const id = modelId(model);   // returns "claude-sonnet-4-5"
    if (!id) return;
    void writeOverride(active.name, { model: id }, settingsPath);
    // BUG: stores just "claude-sonnet-4-5", provider lost
}
```

`Model<any>` has both `.provider` and `.id`. The full identifier format in pi is
`provider/model-id` (used by `/model` command and `--model` CLI flag).

## 4. Fixes

### 4.1 `primaries.ts` — `onModelChanged` saves `provider/model-id` format

```ts
function modelProvider(m: { id: string } | Model<any>): string {
    return (m as { provider?: string }).provider ?? "";
}

function onModelChanged(
    model: { id: string; provider?: string } | Model<any>,
    _ctx: PrimaryControllerContext,
): void {
    if (!active) return;
    const id = modelId(model);
    if (!id) return;
    // Persist full "provider/model-id" so setModelFor can split with /
    // and resolve via modelRegistry.find. If no provider on the model,
    // fall back to plain id (rare; legacy compat).
    const provider = modelProvider(model);
    const fullId = provider ? `${provider}/${id}` : id;
    void writeOverride(active.name, { model: fullId }, settingsPath);
}
```

Behavior:
- If `model.provider` is set: stores `"<provider>/<id>"` (e.g. `"anthropic/claude-sonnet-4-5"`)
- If `model.provider` is empty/undefined: falls back to plain `id` (rare; legacy compat)

Also update the `PrimaryController.onModelChanged` interface signature to accept
`{ id: string; provider?: string } | Model<any>` so callers can pass partial model shapes
(used by tests and by `model_select` event with the full Model object).

### 4.2 `primaries.test.ts` — update `onModelChanged` tests

Existing test was updated to verify provider/id format:

```ts
it("onModelChanged while a primary is active calls writeAgentOverride with provider/id format", async () => {
    const { pi } = fakePi();
    const writeOverride = vi.fn(async () => true);
    const settingsPath = path.join(tmp, "settings.json");
    const c = createPrimaryController(pi, primaries, {
        defaultName: "build",
        settingsPath,
        readOverrides: vi.fn(() => ({})),
        writeOverride,
    });
    await c.apply("plan", fakeCtx());
    // Model has provider + id → must save "provider/id" format
    c.onModelChanged({ id: "claude-opus-4-5", provider: "anthropic" }, fakeCtx());
    expect(writeOverride).toHaveBeenCalledWith(
        "plan",
        { model: "anthropic/claude-opus-4-5" },
        settingsPath,
    );
});

it("onModelChanged falls back to plain id when model has no provider", async () => {
    const { pi } = fakePi();
    const writeOverride = vi.fn(async () => true);
    const c = createPrimaryController(pi, primaries, {
        defaultName: "build",
        readOverrides: vi.fn(() => ({})),
        writeOverride,
    });
    await c.apply("plan", fakeCtx());
    c.onModelChanged({ id: "claude-opus-4-5" }, fakeCtx()); // no provider
    expect(writeOverride).toHaveBeenCalledWith(
        "plan",
        { model: "claude-opus-4-5" },
        undefined,
    );
});
```

## 5. Files Changed

| File | Change |
|------|--------|
| `primaries.ts` | Fix `onModelChanged` to save `provider/model-id` format; add `modelProvider` helper; update `PrimaryController` interface signature |
| `primaries.test.ts` | Update `onModelChanged` test to verify provider/id format; add new test for no-provider fallback |
| `docs/v2.1.1/design.md` | This document (revised) |

## 6. Test Plan

| # | Test | Coverage |
|---|------|----------|
| 1 | `onModelChanged({id, provider})` → writes `"<provider>/<id>"` | Format with provider |
| 2 | `onModelChanged({id})` (no provider) → writes plain id | Fallback format |
| 3 | `onModelChanged` with no active primary → no-op (regression) | No-op case |
| 4 | All existing tests still pass | Regression |

## 7. Why snapshot restore (not inherit current model)?

When the user switches to a primary that has no model in `settings.json`, two options:

**Option A (current — snapshot restore):**
- Restore `snapshot.model` from session start (the pi default model)
- Pro: predictable; each primary has a known model
- Con: doesn't reflect user's "current" model that may have been changed via selector

**Option B (simpler — inherit current):**
- Don't touch model; keep whatever is current
- Pro: simple; respects user's current model selection
- Con: model "sticks" across primary switches even when switching to a no-config primary

The user explicitly stated: *"kalo ga ada maka ambil default model"* — "if none, take the default model".
This means Option A (snapshot restore) is correct. The session-start model IS the default.

Keep snapshot restore as-is; the fix is the format in `onModelChanged`.

## 8. v2.1.1 v3 — Guard flag: prevent programmatic model loads from overwriting settings.json

### Bug

When `setModelFor` calls `pi.setModel()` to load the model configured in `settings.json`
during a primary switch, pi internally emits a `model_select` event with `source: "set"`.
The handler in `index.ts` forwards that event to `controller.onModelChanged(event.model, ctx)`,
which calls `writeOverride()` and overwrites `settings.json`.

This means: **every primary switch writes to `settings.json`**, conflating programmatic
model loading with user-initiated model changes. The user requirement is clear:

> *"Model yang disimpan ke settings.json hanya berubah kalo user switch model pake /model atau model cycling, paham?"*

Settings.json should ONLY be updated when the user explicitly changes the model (via `/model`
command or model-cycling UI), not during programmatic primary-agent switches.

### Why the `model_select.source` field can't disambiguate

The `ModelSelectEvent` type has:

```ts
export type ModelSelectSource = "set" | "cycle" | "restore";
```

`/model` command probably routes through `pi.setModel()` → emits `source: "set"`.
Programmatic `setModelFor` calls also emit `source: "set"`. So `source` alone cannot
tell us if the change was user-initiated or extension-initiated.

### Fix: identity-matched `_pendingProgrammaticSet` guard

Inside `createPrimaryController`, before any function:

```ts
let _pendingProgrammaticSet: Model<any> | null = null;
```

When `setModelFor` calls `pi.setModel(model)`, it stores the model in `_pendingProgrammaticSet`:

```ts
_pendingProgrammaticSet = model;
try {
    pi.setModel(model);
} finally {
    // Real pi may emit model_select synchronously or asynchronously — the
    // microtask reset handles both. If synchronous, onModelChanged clears the
    // marker inside its own check; if async, the next microtask clears it
    // after the event has been processed.
    queueMicrotask(() => { _pendingProgrammaticSet = null; });
}
```

In `onModelChanged`, check identity:

```ts
const incomingId = (model as { id?: string }).id ?? "";
const incomingProvider = (model as { provider?: string }).provider ?? "";
const pending = _pendingProgrammaticSet;
if (
    pending &&
    (pending as { id?: string }).id === incomingId &&
    (pending as { provider?: string }).provider === incomingProvider
) {
    _pendingProgrammaticSet = null;  // clear so next call persists
    return;  // skip persistence — this was a programmatic set
}
```

Identity matches by `id + provider` string, which works for both:
- Real `Model<any>` objects from `modelRegistry`
- Partial model shapes `{ id, provider }` from tests

### Why an identity match (not a boolean flag)?

A simple boolean guard (set before `pi.setModel()`, unset after) doesn't work because:
- If pi emits `model_select` **synchronously** inside `setModel()` → flag is true → ✓
- If pi emits `model_select` **asynchronously** (microtask after setModel returns) →
  flag is already reset → ✗

The identity-match pattern survives both timings: the marker stays until either the
event handler reads it or the post-setMicrotask fires — whichever happens first.

### Files changed

| File | Change |
|------|--------|
| `primaries.ts` | Add `_pendingProgrammaticSet` identity guard; check in `onModelChanged`; set+microtask-reset in `setModelFor` (both code paths: snapshot restore and override-resolve) |
| `primaries.test.ts` | Add 3 tests: programmatic set doesn't persist, user-initiated DOES persist, guard resets after setModelFor (per-call scoped) |
| `docs/v2.1.1/design.md` | This section (v2.1.1 v3) |

### Test plan

| # | Test | Coverage |
|---|------|----------|
| 1 | `apply("plan")` with deferred model_select callback → `writeOverride` NOT called | Guard suppresses programmatic set |
| 2 | `apply()` + manual `onModelChanged` from user → `writeOverride` IS called | User-initiated persists |
| 3 | `apply()` then manual `onModelChanged` with different model → guard is reset | Per-call scoped, not sticky |

## 9. v2.1.2 — Persistent primary marker (LLM mode awareness)

### The gap

When the user switches from `build` (full tools) → `plan` (read-only), the
`setActiveTools` call removes `edit`/`write`/`bash` immediately. The system prompt
gets re-injected with `plan.md` body on the next `before_agent_start`. But the
**conversation history** still shows the previous turn's `edit`/`write` tool calls
and the LLM-generated response text from build mode.

A "naive" LLM looking at its full input on the next turn sees:

1. System prompt: "You are in PLANNING MODE..."
2. Recent history: "[assistant] called edit on file X, called bash, called write..."

The system prompt wins (it's authoritative), but **explicit anchoring** in the
conversation prevents ambiguity from creeping into long sessions — and gives
humans reading scrollback a visual breadcrumb of when the mode changed.

### Approach (mirrors `examples/extensions/plan-mode`)

pi's `BeforeAgentStartEventResult` and `ContextEvent` together provide a clean
mechanism for persisting mode state in the conversation:

1. **`pi.sendMessage(...)`** injects a custom message with `display: false` so
   it appears in the LLM's context but NOT in the user's scrollback.
2. **`pi.on("context")`** filters stale markers out when the active primary
   changes, so only the current marker remains.

Pattern (the pi-canonical way, from `examples/extensions/plan-mode/index.ts`):

```ts
// On primary switch:
pi.sendMessage({
    customType: "minion-primary-context",
    content: `[MINION PRIMARY: plan]
Read-only mode. Available tools: read, grep, find, ls.
NOT available: edit, write, bash (the LLM cannot call these tools this turn).`,
    display: false,  // LLM sees it; user does not
}, { triggerTurn: false });

// On every LLM call (context event):
pi.on("context", (event) => {
    // Strip stale `minion-primary-context` messages; the latest one (just
    // injected by sendMessage at switch time) survives.
    const filtered = event.messages.filter((m) => {
        const c = (m as { customType?: string }).customType;
        return c !== "minion-primary-context";
    });
    return { messages: filtered };
});
```

Wait — if `context` filters ALL `minion-primary-context` messages, we wipe
the marker every turn. So filtering must be selective: keep the LATEST one
(matching current primary) and drop older ones.

Refined: in `filterContextMessages`, keep only the **last** `minion-primary-context`
message AND only if its `content` contains the current primary's name.
Alternately, the marker contains the primary name explicitly, so we can match
on content prefix.

### Final design

- `apply(name, ctx)` calls `pi.sendMessage(...)` once, fire-and-forget.
  The marker tags `customType: "minion-primary-context"`, embeds the active
  primary name + tool allowlist in content, sets `display: false`.

- The `context` event handler (`filterContextMessages(messages)`) keeps at
  most ONE `minion-primary-context` message: the one matching the current
  active primary. Anything older (from previous switches) is stripped.

This guarantees:
- The LLM sees exactly ONE current-mode marker per turn (clean signal).
- Humans reading scrollback don't see the markers (`display: false`).
- The marker includes the explicit tool allowlist so the LLM doesn't have to
  infer "what tools are active" from previous turns' usage patterns.

### Sample marker content

For `plan` primary:
```
[MINION PRIMARY: plan]
Read-only planning mode. Available tools: read, grep, find, ls.
NOT available: edit, write, bash. The LLM CANNOT call these tools this turn.
```

For `build` primary:
```
[MINION PRIMARY: build]
Implementation mode. All standard tools are available.
```

The "NOT available" phrasing directly addresses the user's concern that the
LLM might still try to use old-mode tools after a switch.

### Edge cases

1. **First session start** — no marker exists. The `context` filter is a no-op.
2. **Switch during in-flight LLM call** — pi serializes LLM calls, so this
   can't happen. The marker only updates between turns.
3. **Plan-mode with disabled tools (not just restricted)** — out of scope for
   v2.1; the simpler "tool list change" model is enough for v2.1.

### Files changed

| File | Change |
|------|--------|
| `primaries.ts` | Add `sendMessage` to `PrimaryControllerPi`; call it in `apply()` with triggerTurn=false; add `filterContextMessages` method on `PrimaryController`; export `PRIMARY_MARKER_CUSTOMTYPE` const for index.ts + tests |
| `index.ts` | Add `pi.on("context", ...)` handler calling `controller.filterContextMessages(event.messages)` |
| `primaries.test.ts` | Update fake Pi to record `sendMessage` calls; add tests for marker content + filter logic |
| `docs/v2.1.1/design.md` | This section (§9) |

### Test plan

| # | Test | Coverage |
|---|------|----------|
| 1 | `apply("plan")` calls `sendMessage` with marker content containing primary name + tool list | Marker injection on switch |
| 2 | `apply("plan")` after `apply("build")` keeps only the plan marker in filtered messages | Switch replaces old marker |
| 3 | `filterContextMessages` drops all `minion-primary-context` messages EXCEPT the current one | Filter is correct |
| 4 | `filterContextMessages` with no active primary drops all markers | No-active fallback |
| 5 | `sendMessage` fails fail-soft (no throw, primary still applied) | Robustness |
| 6 | Existing tests still pass | Regression |
