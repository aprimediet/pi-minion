# minion v2.1 — Implementation Spec (Build Prompt)

**Audience:** a coding agent implementing minion **v2.1 (Primary Agents)** on top of the
already-shipped v2.0 in this directory.
**Source of truth for *what*:** [`./design.md`](./design.md). This file specifies *how* —
the build order and the **mandatory test discipline**. Read `design.md` first.

This is **additive on v2.0** — the `subagent` tool, `modes.ts`, `runner.ts`, `render.ts`,
`schema.ts` are untouched except where stated. Do not regress v2.0 behavior.

**Reference code to port from (do not reinvent):**
- pi preset example (the primary-switch pattern, near-complete reference):
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/preset.ts`.
- Existing v2.0 modules in this dir: `agents.ts`, `config.ts`, `index.ts` (DI style), and
  the colocated `*.test.ts` for test conventions; `vitest.config.ts` for the harness.

## 0. MANDATORY DISCIPLINE — red → green TDD

**Non-negotiable. Every line of production code is preceded by a failing test.** Per unit:

1. **RED** — write the test(s) first. `npm test`. **Confirm it fails** for the right reason
   (assertion / missing export — not a typo or import error).
2. **GREEN** — minimum code to pass. `npm test`. Confirm green.
3. **REFACTOR** — clean up with tests green.

Rules:
- Never write/expand production code without a failing test demanding it. One behavior per cycle.
- Do not weaken or delete tests to go green.
- Untestable shells (TUI render, real keypress/IPC) → isolate the **pure** part, test that,
  keep the shell thin, say so in a comment.
- Work packages in dependency order **WP0→WP6**. Later packages may use earlier modules as
  real collaborators; the **`primaries` controller** is always tested with an **injected fake
  `pi`** (recording `set*`/`registerShortcut`/`on` calls), never a real session.

## 1. Locked decisions (from design O1–O3, all resolved)

- **O1 — `type` field + user primaries.** Agents carry frontmatter `type: primary | subagent`
  (optional, **defaults to `subagent`** — v2.0 back-compat). Primaries = bundled `primaries/`
  (always loaded) **+** any `type: primary` agent discovered in `~/.pi/agent/agents` (and
  project `.pi/agents`). User definitions **override bundled by name**; new names are added to
  the cycle. The `subagent` tool delegates **only** to `subagent`-typed (or untyped) agents.
- **O2 — keybinds.** **Shift+Tab → switch primary** (cycle). **Thinking-level cycling moves to
  Alt+T.** Requires unbinding/overriding pi's built-in Shift+Tab — **gated by the WP0 spike**;
  documented fallback if the SDK won't allow it.
- **O3 — model.** Primaries **inherit** the user's current model by default. When the user
  changes model while a primary is active, **persist it** to `~/.pi/agent/settings.json` under
  `"agents"` (v2.0 schema: `{ "agents": { "<name>": { "model"?, "tools"? } } }`). On next apply,
  the primary reads that override as its model.
- **Default-active primary** at session start = **`build`** (unless `--agent` flag or restored
  session state says otherwise).
- **Package** → `@aprimediet/minion` **`2.1.0`** (additive, non-breaking).

## 2. What changes vs v2.0 (module-layout delta)

```
minion/
├── agents.ts        # CHANGED: parse `type` into AgentConfig (default "subagent")
├── config.ts        # CHANGED: add writeAgentOverride(...) writer (v2.0 only read)
├── primaries.ts     # NEW: loadBundledPrimaries + resolvePrimaries + createPrimaryController
├── index.ts         # CHANGED: wire flag, /plan /build, shortcuts, before_agent_start,
│                    #          model_select, session_start, turn_start
├── primaries/*.md   # NEW: build.md, plan.md (always loaded, never installed)
├── agents/*.md      # CHANGED: add `type: subagent` line to the 4 bundled subagents
├── package.json     # CHANGED: files += primaries/**, primaries.ts; version 2.1.0
└── primaries.test.ts  config.test.ts (extend)  agents.test.ts (extend)  index.test.ts (extend)
```

Dependency graph stays acyclic: `primaries → config, agents(types)`; `index → primaries + v2.0 modules`.
`schema.ts`, `runner.ts`, `modes.ts`, `render.ts` unchanged.

## 3. Conventions (carry from v2.0)

- ESM only; explicit `.ts` import extensions. No third-party runtime deps (pi peers + `typebox`).
- **Fail-soft:** catch I/O errors, degrade (skip file / return `{}`), never crash the host session.
- **Atomic writes** via `withFileMutationQueue` (write `.tmp`, rename) — applies to the new
  `writeAgentOverride`.
- Test imports: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`
  Filesystem tests use temp dirs (`fs.mkdtempSync(path.join(os.tmpdir(),"minion-<unit>-"))`,
  removed in `afterEach`).

---

## WP0 — Capability spike (do first; **investigation, not TDD**)

The design flagged two SDK unknowns. Resolve them **before** writing WP4 wiring, and record
the answers in a short comment block at the top of `primaries.ts`.

1. **Shortcut override:** can `pi.registerShortcut(Key.shiftTab(), …)` override pi's built-in
   Shift+Tab (thinking cycle)? Inspect `@earendil-works/pi-coding-agent` types/dist for an
   unregister/override API and how built-in shortcuts are registered.
2. **`Key` constructors:** confirm the exact `pi-tui` `Key` API for **Shift+Tab** and **Alt+T**
   (`Key.shiftTab()`, `Key.alt("t")` are assumed; preset uses `Key.ctrlShift("u")`).
3. **`model_select` event:** confirm the handler payload carries the selected model
   (shape of `ModelSelectEvent`) so `onModelChanged` can read it.

**Decision + fallback (document whichever applies):**
- If Shift+Tab **can** be overridden → bind Shift+Tab=switch-primary, Alt+T=thinking-cycle (the O2 target).
- If it **cannot** → keep thinking on its built-in key, bind **primary-switch to a free key**
  (e.g. `Key.ctrlShift("p")`) and Alt+T optional; note the deviation in `primaries.ts` and README.

No code ships from WP0 except the documented decision; proceed to WP1.

## WP1 — `agents.ts`: parse `type`

**RED** (extend `agents.test.ts`, temp dirs):
- `loadAgentsFromDir` reads frontmatter `type` into `AgentConfig.type` when present
  (`"primary"`/`"subagent"`); **defaults to `"subagent"`** when absent.
- An unrecognized `type` value falls back to `"subagent"` (fail-soft, no throw).
- Existing v2.0 assertions still pass (name/description required; tools CSV; etc.).

**GREEN:** add `type?: "primary" | "subagent"` to `AgentConfig`; parse + normalize in
`loadAgentsFromDir`. `discoverAgents` unchanged besides carrying the field through.

## WP2 — `config.ts`: `writeAgentOverride` (writer)

**RED** (extend `config.test.ts`, temp settings file):
- `writeAgentOverride(name, patch, settingsPath)` merges `patch` (`{ model?, tools? }`) into
  `agents[name]`, preserving other agents and unrelated top-level keys; creates the file/`agents`
  key if missing.
- Round-trip: after `writeAgentOverride("plan", { model: "m" }, p)`, `readAgentOverrides(p)`
  returns `{ plan: { model: "m" } }`.
- Fail-soft: an unwritable path returns `false`/no-throw (does not crash); malformed existing
  JSON is not silently destroyed (abort the write, return `false`).

**GREEN:** implement with `withFileMutationQueue` (atomic `.tmp` + rename). `settingsPath`
defaults to `defaultSettingsPath()`. Export `writeAgentOverride`.

## WP3 — `primaries.ts` (NEW)

Depends on `config.ts` (override resolution + writer) and the `agents.ts` `type` field. The
controller is tested with an **injected fake `pi`**.

**RED** (`primaries.test.ts`):
- `loadBundledPrimaries(dir)` (temp dir of `*.md`): parses each into `PrimaryAgent`
  (`source:"bundled"`); skips a malformed file fail-soft; ignores non-`.md`.
- `resolvePrimaries(bundled, discovered)`: keeps bundled; adds `discovered` filtered to
  `type==="primary"`; a user primary with a bundled name **overrides** it; cycle order is stable
  (bundled first, then user, by name).
- `createPrimaryController(fakePi, primaries, {defaultName:"build"})`:
  - `apply("plan", ctx)` → `fakePi.setActiveTools(["read","grep","find","ls"])`;
    `setStatus("minion","primary:plan")`; no `setModel` when no override/frontmatter model
    (inherit); records original tools on first switch.
  - `apply("build", ctx)` → restores full/original tools.
  - `apply` resolves model from settings override (`readAgentOverrides`) → frontmatter →
    inherit; calls `setModel` only when a model is resolved.
  - `cycle(ctx)` advances through `list()` order (build→plan→…→wrap); `getActive()` reflects it.
  - `injectSystemPrompt({systemPrompt})` → `{ systemPrompt: base + "\n\n" + active.body }` when
    active; `undefined` when none.
  - `onModelChanged(model, ctx)` while a primary is active → calls `writeAgentOverride(active.name,
    { model: <id> }, …)`; no-op when no active primary. (Inject the writer for hermetic test.)

**GREEN:** implement `PrimaryAgent`, `loadBundledPrimaries`, `resolvePrimaries`,
`createPrimaryController` per design §5. Make collaborators injectable (loader dir, `readOverrides`,
`writeOverride`) so tests avoid real FS/session. Port snapshot/apply/cycle mechanics from
`preset.ts` (trimmed: no JSON preset files, no SelectList).

## WP4 — `index.ts` wiring

**RED** (extend `index.test.ts`, mock `pi` with `vi.fn()` for `registerFlag`/`registerCommand`/
`registerShortcut`/`on`; fake `ctx` with `cwd`,`ui.setStatus`,`ui.notify`,`sessionManager.getEntries`,
`model`):
- Registers flag `agent`, commands `plan` + `build` (+ `/minion primaries`), and the
  primary-switch + thinking shortcuts per the WP0 decision.
- `before_agent_start` handler returns the controller's injected prompt (active) / `undefined` (none).
- `session_start`: with `--agent plan` valid → applies plan; with no flag but a restored
  `minion-primary` entry → applies that; otherwise applies default `build`. Sets status.
- `model_select` handler calls `controller.onModelChanged(event.model, ctx)`.
- `turn_start` appends `pi.appendEntry("minion-primary", { name })` when a primary is active.
- v2.0: the `subagent` tool + `/minion list`/`install-agents` still register and behave as before;
  `subagent` delegation excludes `type:"primary"` agents.

**GREEN:** extend `buildExtension` (add `loadPrimaries` to `BuildExtensionDeps`, defaulted in
`defaultExtension`). Wire flag, commands, shortcuts (WP0 keys), and the four `pi.on(...)` handlers
to a `createPrimaryController` instance. Filter discovered agents by `type` so the subagent tool
only sees subagents and the controller only sees primaries.

## WP5 — bundled `primaries/*.md` + subagent `type` + manifest test

**RED** (extend `bundled.test.ts`):
- Every file in `primaries/` parses via `loadBundledPrimaries` to a valid `PrimaryAgent`; the
  set of names is exactly `{plan, build}`; `plan.tools === ["read","grep","find","ls"]`;
  `build.tools` undefined (full set).
- Every file in `agents/` now declares `type: subagent`; the name set is still
  `{scout, planner, reviewer, worker}`.

**GREEN:** author `primaries/build.md` and `primaries/plan.md` per design §4 (adapt `preset.ts`
`implement`/`plan` instruction bodies). Add `type: subagent` to the 4 bundled subagent files.

## WP6 — packaging finalize

- `package.json`: `files` += `"primaries/**"`, `"primaries.ts"`; bump `version` to `2.1.0`.
  (Bundled primaries are **never** copied by `install-agents`.)
- `npm run pack:dry` → confirm `primaries/**` + `primaries.ts` ship and tests don't.
- README: add a **Primary Agents** section — `build`/`plan`, how to switch (Shift+Tab / `/plan`
  `/build` / `--agent`), Alt+T thinking-cycle (or WP0 fallback), defining your own primary
  (`type: primary` in `~/.pi/agent/agents`), and model persistence into `settings.json`.

---

## End-to-end verification

1. `npm test` — all green; v2.0 tests still pass; new pure logic (agents `type`, config writer,
   primaries loader/controller) covered with a fake `pi` (no real session/subprocess).
2. Manual smoke in pi: `pi -e ./index.ts`:
   - status line shows `primary:build` at start.
   - **Shift+Tab** switches to `plan`; attempting an edit is blocked by the read-only toolset;
     **Shift+Tab** back to `build` restores full tools. (`/plan`/`/build` do the same.)
   - **Alt+T** cycles thinking level (or WP0-fallback key).
   - `pi -e ./index.ts --agent plan` starts in plan.
3. Change the model while `plan` is active → confirm `~/.pi/agent/settings.json` now has
   `agents.plan.model`; restart `--agent plan` → that model is applied (verify via model status).
4. Drop a `~/.pi/agent/agents/foo.md` with `type: primary` → it appears in the Shift+Tab cycle and
   `/minion primaries`; a `type: subagent` (or untyped) file does **not** become switchable but is
   still usable via the `subagent` tool.

## Definition of done

- [ ] WP0 decision recorded; WP1–WP6 complete; each changed/new module has tests written **before** code.
- [ ] `npm test` green; no v2.0 regression; no test weakened/skipped.
- [ ] Primaries controller tested only with injected fake `pi` (no real session).
- [ ] `agents.ts` `type` defaults to `subagent`; `subagent` tool excludes primaries.
- [ ] Shift+Tab switches primaries, Alt+T cycles thinking (or documented WP0 fallback).
- [ ] Model change while a primary is active persists to `settings.json` `agents` key.
- [ ] `primaries/{build,plan}.md` present + manifest-validated; bundled subagents declare `type: subagent`.
- [ ] `pack:dry` ships `primaries/**` + `primaries.ts`; version `2.1.0`; README documents primary agents.
