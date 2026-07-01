# minion v2.1 — Primary Agents

> Status: design. Builds on [v2.0](../v2.0/design.md) (subagent delegation only).

## 1. Why

v2.0 ships **subagent delegation only**: one `subagent` tool that spawns isolated
`pi --mode json` subprocesses (single / parallel / chain), plus four bundled
*subagent* definitions (scout, planner, reviewer, worker). There is no way to switch
the **main** agent's persona.

v2.1 adds **primary agents** — named personas for the *main* loop (not subprocesses)
that the user switches between mid-session. Two are bundled and always loaded:

- **`build`** — full-capability execution mode (default).
- **`plan`** — restricted, read-only planning mode.

This mirrors [opencode's plan/build distinction](https://opencode.ai/docs/agents/):
a planning mode that can't accidentally edit files, and an execution mode that can.
Users can also define their **own** primaries (see §3).

## 2. Feasibility — how pi makes this possible

The pi SDK has **no native primary-agent / mode / persistent-system-prompt API**
(no `registerAgent`, `registerMode`, or `setSystemPrompt`). The available levers are:

- `pi.on("before_agent_start")` → returns `{ systemPrompt }`, applied **per turn**.
- `pi.setModel()` / `ctx.model`, `pi.setActiveTools()`, `pi.setThinkingLevel()` / `pi.getThinkingLevel()` — per-session runtime config.
- `pi.on("model_select")` — fires when the user changes model.
- `pi.registerCommand` / `pi.registerShortcut` / `pi.registerFlag`.
- `ctx.ui.setStatus(...)` — status-line indicator.
- `pi.appendEntry(...)` + `ctx.sessionManager.getEntries()` — persist state across resume.

→ Primary agents are implemented as the **preset pattern**. The canonical
`node_modules/@earendil-works/pi-coding-agent/examples/extensions/preset.ts` is an
almost-complete reference. "Switching" means: store the active primary in module
state, apply its model/tools once via `set*`, and **re-inject its system prompt every
turn** in `before_agent_start` so the swap effectively persists for the whole session.

> **Capability checks to confirm during impl** (design risks):
> - Whether `registerShortcut` can **override a built-in** binding (needed to rebind
>   Shift+Tab — see §6 / O2). If not, this needs an unregister API from the SDK.
> - Exact `pi-tui` `Key` constructors for Shift+Tab and Alt+T (`Key.shiftTab()`,
>   `Key.alt("t")` are assumed; the preset uses `Key.ctrlShift("u")`).

## 3. Agent kinds and the `type` field

v2.1 introduces a `type` frontmatter field on agent definitions:

```yaml
type: primary | subagent   # optional; defaults to "subagent" (v2.0 back-compat)
```

| Kind | Runs as | Context | Switchable | Source |
|------|---------|---------|------------|--------|
| **subagent** (`type: subagent`, or unset) | child `pi` subprocess | isolated, fresh | n/a (invoked per task) | bundled `agents/` + user/project dirs |
| **primary** (`type: primary`) | the **main** loop persona | the live session | yes — only primaries switch in main mode | bundled `primaries/` + **user `~/.pi/agent/agents`** |

**Both kinds live in the same user dir** (`~/.pi/agent/agents`) and are distinguished
by `type`. So a user adds a custom primary by dropping a `*.md` with `type: primary`
into `~/.pi/agent/agents` — no separate location. (Project `.pi/agents` may also hold
primaries; same gating as subagents.)

The two **bundled** primaries (`plan`, `build`) remain bundled-and-always-loaded (not
copied, not installable). A user primary with the same `name` **overrides** the bundled
one; user primaries with new names are **added** to the switch cycle.

Back-compat: existing v2.0 agents have no `type`, default to `subagent`, and behave
exactly as before.

## 4. Bundled definitions

### Bundled primaries — new dir `primaries/` (always loaded)

`primaries/build.md`:
```yaml
---
name: build
type: primary
description: Full-capability execution mode — make focused, correct changes.
# no `tools` → full default toolset
# no `model` → inherit the user's current model (see §5 persistence)
---
```
Body: execution-mode prompt (keep scope tight, read before editing, prefer surgical
edits, run tests/type-checks, stop and explain on unexpected complexity).

`primaries/plan.md`:
```yaml
---
name: plan
type: primary
description: Read-only planning mode — understand deeply, produce a plan, make no changes.
tools: read, grep, find, ls
# no `model` → inherit
---
```
Body: planning-mode prompt (read in full, explore broadly, identify risks/edge cases,
produce a numbered plan + files-to-change, **make no edits**, suggest switching to
`build` to execute).

Prompts adapt `preset.ts`'s `plan` / `implement` instructions.

### Bundled subagents

The four existing bundled subagents (`scout`, `planner`, `reviewer`, `worker`) gain an
explicit `type: subagent` line for clarity (behavior unchanged; the field is optional).

## 5. New module: `primaries.ts`

Single-responsibility, matching the existing module style (acyclic deps; depends on
shared frontmatter parsing, `config.ts`, and node stdlib).

```ts
export interface PrimaryAgent {
  name: string;
  description: string;
  tools?: string[];      // undefined → full default toolset
  model?: string;        // undefined → inherit; may be filled from settings overrides
  systemPrompt: string;
  source: "bundled" | "user" | "project";
  filePath: string;
}

// Bundled primaries/*.md, always loaded. Fail-soft: a broken file is skipped.
export function loadBundledPrimaries(dir?: string): PrimaryAgent[];

// Merge bundled + discovered `type: primary` agents (user/project override bundled
// by name). `discovered` comes from the existing discoverAgents result, filtered by type.
export function resolvePrimaries(
  bundled: PrimaryAgent[],
  discovered: AgentConfig[],
): PrimaryAgent[];

// Holds active-primary state + apply/cycle/inject/restore + model persistence.
export function createPrimaryController(
  pi: ExtensionAPI,
  primaries: PrimaryAgent[],
  opts?: { defaultName?: string },  // default "build"
): PrimaryController;

export interface PrimaryController {
  getActive(): PrimaryAgent | undefined;
  list(): PrimaryAgent[];                                   // cycle order
  apply(name: string, ctx: ExtensionContext): Promise<void>;
  cycle(ctx: ExtensionContext): Promise<void>;              // next primary in list()
  injectSystemPrompt(event: { systemPrompt: string }): { systemPrompt: string } | undefined;
  onModelChanged(model: Model, ctx: ExtensionContext): void; // persist per O3
}
```

Controller behavior:
- `apply(name, ctx)` — snapshot original `{ model, tools, thinkingLevel }` on first
  switch; resolve the primary's model via `config.ts` overrides (`settings.json`
  `agents[name].model`) → frontmatter → **inherit current**; `pi.setActiveTools(tools ?? originalTools)`;
  `pi.setModel(...)` only when a model is resolved (override or frontmatter), else leave
  the user's current model untouched; `ctx.ui.setStatus("minion", "primary:<name>")`.
- `cycle(ctx)` — advance through `list()` (bundled + user primaries, stable order).
- `injectSystemPrompt(event)` — when a primary is active, return
  `{ systemPrompt: `${event.systemPrompt}\n\n${active.systemPrompt}` }` (**append**, not
  replace — preserves pi's base prompt + tool docs); `undefined` when none active.
- `onModelChanged(model, ctx)` — **O3**: when the user changes model while a primary is
  active, persist it via `writeAgentOverride(active.name, { model })` into
  `~/.pi/agent/settings.json` under the `agents` key (v2.0 schema). Next time that
  primary is applied, `apply` reads it back as its model.

Default-active = **`build`**, applied at `session_start` unless a flag or restored
session state overrides it.

`PrimaryAgent` lives in `primaries.ts` (no TypeBox runtime schema needed).

## 6. Wiring in `index.ts`

Extend `buildExtension` in the existing dependency-injection style (add `loadPrimaries`
to `BuildExtensionDeps`, defaulted in `defaultExtension`). Register:

- **Flag:** `pi.registerFlag("agent", { type: "string", description: "Primary agent at startup (plan|build|<custom>)" })`.
- **Slash commands:** `/plan` and `/build` → `controller.apply(...)`. Extend `/minion`
  to accept `plan`/`build`/`<name>`, and add `/minion primaries` (list switchable primaries).
- **Shortcuts (O2):**
  - **Unbind** pi's built-in **Shift+Tab** (thinking-level cycling) and **re-register
    Shift+Tab** → `controller.cycle(ctx)` (switch primary). *(Pending the override-vs-unregister
    capability check in §2.)*
  - **Re-bind thinking-level cycling to Alt+T**: `pi.registerShortcut(Key.alt("t"), …)`
    cycling `pi.getThinkingLevel()` → next of `["off","minimal","low","medium","high","xhigh"]`
    via `pi.setThinkingLevel(...)`.
- **`pi.on("before_agent_start")`** → `controller.injectSystemPrompt(event)`.
- **`pi.on("model_select")`** → `controller.onModelChanged(event.model, ctx)` (O3 persistence).
- **`pi.on("session_start")`** → load bundled primaries + discovered `type: primary`
  agents → `resolvePrimaries`; if `--agent <name>` is set and valid, apply it; else
  restore from session state; else apply default `build`. Set status.
- **`pi.on("turn_start")`** → persist active name via `pi.appendEntry("minion-primary", { name })`;
  restored in `session_start` via `ctx.sessionManager.getEntries()` (survives resume).

The existing `subagent` tool keeps working; it delegates only to `type: subagent` (or
untyped) agents. `/minion list` unchanged. Bundled agents auto-load from the extension's `agents/` folder — no install step needed.

## 7. Changes to existing modules

- **`agents.ts`** — parse the new `type` frontmatter field into `AgentConfig`
  (`type?: "primary" | "subagent"`, default `"subagent"`). `discoverAgents` is unchanged
  except for carrying `type`; callers filter by it.
- **`config.ts`** — add a **writer** (v2.0 only reads):
  `writeAgentOverride(name, patch, settingsPath?)` — atomic read-modify-write of
  `settings.json` (`.tmp` + `rename`, per the atomic-write convention), merging
  `agents[name]` with `patch` (`{ model?, tools? }`). Reuses the v2.0 `agents`-key schema.
- **`schema.ts`** — no change (primaries are not a tool; `SubagentParams` unchanged).

## 8. Packaging

- `package.json` `files` allowlist: add `"primaries/**"` and `"primaries.ts"`.
- No new `pi.prompts` entries (commands registered in code).
- Version → **`2.1.0`** (additive, non-breaking — v2.0 subagent API untouched; `type`
  defaults preserve old agents).

## 9. Testing

`primaries.test.ts` (vitest, matching existing module tests), with a fake `pi`
(recording `setActiveTools` / `setModel` / `setThinkingLevel` / `setStatus` calls):
- `loadBundledPrimaries` parses both bundled files; skips a malformed file fail-soft.
- `resolvePrimaries` merges bundled + user `type: primary`; user overrides bundled by name.
- Controller: `apply("plan")` → `setActiveTools(["read","grep","find","ls"])`;
  `apply("build")` → full tools; `apply` resolves model from settings override when present;
  `cycle` advances through the merged list; `injectSystemPrompt` appends body / returns
  `undefined` when none active; `onModelChanged` calls `writeAgentOverride` with the new model.
- `config.ts`: `writeAgentOverride` round-trips through a temp settings file and is
  read back by `readAgentOverrides`.

## 10. Resolved open questions

- **O1 — Extensibility:** ✅ Yes. Agents carry a `type` field; user primaries live in
  `~/.pi/agent/agents` (`type: primary`) alongside subagents. Bundled `plan`/`build`
  stay bundled-and-always-loaded; user definitions override by name or add new ones.
- **O2 — Keybinds:** ✅ Unregister pi's built-in **Shift+Tab** (thinking cycle), move
  thinking-cycle to **Alt+T**, and use **Shift+Tab** to switch primary agents.
  (Subject to the override/unregister capability check in §2.)
- **O3 — Model:** ✅ Inherit the user's current model by default; when the user changes
  model while a primary is active, persist it to `~/.pi/agent/settings.json` under the
  `agents` key (v2.0 config schema) so it sticks for that primary next session.
