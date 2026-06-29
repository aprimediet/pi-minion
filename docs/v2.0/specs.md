# minion v2 — Implementation Spec (Build Prompt)

**Audience:** a coding agent implementing minion v2 from scratch in this directory.
**Source of truth for *what*:** [`./design.md`](./design.md). This file specifies *how* —
the build order and the **mandatory test discipline**. Read `design.md` first.

**Reference code to port from (do not reinvent):**
- pi example: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts` and `agents.ts`.
- v1 minion (git history): `git show HEAD:subagent.ts`, `git show HEAD:agents.ts`, `git show HEAD:agents/<name>.md`.
- Test/harness template: sibling `../todo/` (`config.ts`, `*.test.ts`, `vitest.config.ts`, `tsconfig.json`).

## 0. MANDATORY DISCIPLINE — red → green TDD

**Non-negotiable. Every line of production code is preceded by a failing test.** For each
unit of behavior:

1. **RED** — write the test(s) first. Run `npm test`. **Confirm it fails** for the right
   reason (assertion/missing export — not a typo or import error).
2. **GREEN** — write the *minimum* code to make the failing test pass. Run `npm test`.
   Confirm green.
3. **REFACTOR** — clean up names/duplication with tests staying green.

Rules:
- Never write or expand production code without a failing test that demands it.
- One behavior per cycle; keep cycles small. Commit (or checkpoint) per green cycle.
- Do not weaken a test to make it pass. Do not delete tests to go green.
- If a behavior is genuinely untestable (e.g. terminal escape codes in TUI render), isolate
  the *pure* part, test that, and keep the untestable shell as thin as possible — and say so
  in a comment.
- Work the packages in dependency order (WP1→WP9). A later package's tests may use earlier
  modules as real collaborators; the one exception is `modes` (WP6), which uses an **injected
  fake runner**, never a real subprocess.

## 1. Locked decisions (from design O1–O4)

- **Overrides** live in `~/.pi/agent/settings.json` under `"agents"`:
  `{ "agents": { "<name>": { "model"?: string, "tools"?: string /* CSV */ } } }`.
  Effective value = **settings override ?? frontmatter ?? built-in default**. Applies to
  `model` and `tools`.
- **Bundled agents (4):** `scout`, `planner`, `reviewer`, `worker`.
- **Roster discovery:** lazy `list` mode on the tool. No event hooks. No standing prompt text.
- **Package:** `@aprimediet/minion` `2.0.0`. **No `minion.json`.**

## 2. Target module layout

```
minion/
├── schema.ts     # TypeBox params + TS result/detail/override types  (no internal deps)
├── agents.ts     # discovery + frontmatter parse                     (→ schema)
├── config.ts     # settings.json "agents" overrides + resolution     (→ schema, agents)
├── runner.ts     # buildPiArgs + accumulateEvent (pure) + spawn      (→ schema, config)
├── modes.ts      # single/parallel/chain + concurrency; injected runner (→ schema)
├── render.ts     # renderCall/renderResult + pure format helpers      (→ schema)
├── index.ts      # wire all; register tool + /minion command          (→ all)
├── agents/*.md   # scout, planner, reviewer, worker
├── prompts/*.md  # implement, scout-and-plan, implement-and-review
├── package.json  tsconfig.json  vitest.config.ts  README.md
└── *.test.ts     # one alongside each module
```

Dependency graph is acyclic: `schema` ← everything; `index` → all; `modes` depends only on
`schema` (runner injected).

## 3. Conventions

- ESM only; all imports use explicit `.ts` extensions (`import { x } from "./schema.ts"`).
- No third-party runtime deps — only pi peer packages + `typebox`. Test-only dev deps: `vitest`, `@types/node`.
- Fail-soft: catch I/O errors and degrade (return `{}` / empty), never crash the host session.
- Atomic writes via `withFileMutationQueue` (write `.tmp`, rename). Temp prompt files mode `0600`, cleaned in `finally`.
- Constants (in `modes.ts`): `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`, `PER_TASK_OUTPUT_CAP = 50 * 1024`.

---

## Work Package 0 — Harness (do this first; verify red/green works)

Create, **mirroring `../todo`**:
- `package.json` — `"type":"module"`, `scripts: { "test":"vitest run", "test:watch":"vitest", "pack:dry":"npm pack --dry-run" }`, `devDependencies: { "vitest":"^1.6.0", "@types/node":"^20.0.0" }`, `engines.node >= 20`, peer deps (`@earendil-works/pi-coding-agent`,`-agent-core`,`-ai`,`-tui`,`typebox`), `pi: { extensions:["./index.ts"], prompts:["./prompts"] }`, `files: ["*.ts","agents/**","prompts/**","README.md","LICENSE"]`, name `@aprimediet/minion` v`2.0.0`.
- `tsconfig.json` — copy `../todo/tsconfig.json` (ES2022, ESNext, `moduleResolution:"Bundler"`, `allowImportingTsExtensions:true`, `strict`, `verbatimModuleSyntax`, `isolatedModules`, `noEmit`).
- `vitest.config.ts` — copy `../todo/vitest.config.ts` (globals, node env, `include:["*.test.ts"]`, `sequence.concurrent:false`, `testTimeout:15_000`, v8 coverage).
- Run `npm install`.

**Smoke cycle:** write `smoke.test.ts` asserting `1+1===2`; `npm test` → green; delete it.
Confirms the toolchain runs `.ts` tests. Only then proceed.

Test imports everywhere: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`
Filesystem tests use temp dirs: `fs.mkdtempSync(path.join(os.tmpdir(), "minion-<unit>-"))`, removed in `afterEach`.

---

## WP1 — `schema.ts` (types + TypeBox params)

**RED** (`schema.test.ts`): validate the compiled TypeBox schema with `typebox`'s `Value`/checker:
- `SubagentParams` accepts each shape: `{agent,task}`, `{tasks:[...]}`, `{chain:[...]}`, `{list:true}`, with optional `agentScope`,`confirmProjectAgents`,`cwd`.
- `agentScope` rejects values outside `user|project|both`; default is `"user"`.
- `TaskItem`/`ChainItem` require `agent` + `task`, allow optional `cwd`.

**GREEN:** export TypeBox `SubagentParams`, `TaskItem`, `ChainItem`, `AgentScopeSchema`
(`StringEnum(["user","project","both"])` from `@earendil-works/pi-ai`, default `"user"`),
plus the new `list?: boolean`. Export TS types: `UsageStats`, `SingleResult`,
`SubagentDetails` (port shapes from the example), and `AgentOverride { model?: string; tools?: string }`.

## WP2 — `render.ts` pure helpers

Render to TUI is a thin shell; the **pure** helpers carry the logic and are fully tested.

**RED** (`render.test.ts`):
- `formatTokens(n)`: `999→"999"`, `1500→"1.5k"`, `12000→"12k"`, `2_000_000→"2.0M"`.
- `formatUsageStats(usage, model?)`: includes `↑/↓/R/W`, `$cost` (4dp), `ctx:`, `N turns`, trailing model; omits zero fields.
- `truncateParallelOutput(s)`: returns input unchanged when `≤ 50KB`; otherwise byte-capped at 50KB with a `[Output truncated: …]` note and never exceeds the cap.
- `getFinalOutput(messages)`: last assistant text; `""` when none.
- `getDisplayItems(messages)`: ordered `text`/`toolCall` items from assistant content.
- `isFailedResult(r)`: true when `exitCode!==0` or `stopReason ∈ {error,aborted}`.

**GREEN:** port these from the example verbatim where possible. Then add `renderCall` /
`renderResult` using `@earendil-works/pi-tui` (`Container`,`Text`,`Markdown`,`Spacer`) — **no
unit test required** for the Component-returning shell; keep it a thin mapping over the
tested helpers (note this in a comment per §0).

## WP3 — `agents.ts` (discovery)

**RED** (`agents.test.ts`, temp dirs):
- `loadAgentsFromDir(dir)`: parses `*.md` frontmatter (`name`,`description`,`tools` CSV→`string[]`,`model`), body→`systemPrompt`; **skips** files missing `name`/`description`; ignores non-`.md`.
- `findNearestProjectAgentsDir(cwd)`: walks up to nearest `.pi/agents` (`CONFIG_DIR_NAME`), else `null`.
- `discoverAgents(cwd, scope)`: `user` reads `<agentDir>/agents`; `project` reads project dir; `both` merges with **project overriding user by name**; returns `{ agents, projectAgentsDir }`.
- `formatAgentList(agents, max)`: `"name (source): desc; …"` with `+N more` remainder.

**GREEN:** port from the example `agents.ts` (uses `getAgentDir`, `CONFIG_DIR_NAME`,
`parseFrontmatter` from `@earendil-works/pi-coding-agent`). Make the user-agents base dir
injectable (param default `getAgentDir()`) so tests are hermetic.

## WP4 — `config.ts` (settings overrides + resolution)

**RED** (`config.test.ts`, temp settings file):
- `readAgentOverrides(settingsPath)`: returns `settings.agents` object; `{}` when file missing/invalid/!`.agents` (no throw).
- `resolveAgentRuntime(agent, overrides)`: returns effective `{ model?, tools? }` where
  `model = overrides[name]?.model ?? frontmatter.model`,
  `tools = parseCsv(overrides[name]?.tools) ?? frontmatter.tools` (settings wins, frontmatter fallback, else undefined).
- CSV parsing trims and drops empties; `"read, write , bash"` → `["read","write","bash"]`.

**GREEN:** mirror `../todo/config.ts` direct-read pattern. `settingsPath` param defaults to
`path.join(getAgentDir(), "settings.json")`. Export `readAgentOverrides`,
`resolveAgentRuntime`, `defaultSettingsPath()`.

## WP5 — `runner.ts` (pure parse + spawn shell)

Split pure logic (tested) from the subprocess (one integration test).

**RED** (`runner.test.ts`):
- `buildPiArgs({ model?, tools?, promptPath?, task })`: always `["--mode","json","-p","--no-session"]`; appends `--model m` iff model; `--tools a,b` iff tools; `--append-system-prompt <path>` iff promptPath; final positional `Task: <task>`. Assert exact array for representative inputs.
- `accumulateEvent(state, event)` (pure reducer over parsed JSON lines): on `message_end`+assistant → pushes message, increments `turns`, sums usage (input/output/cacheRead/cacheWrite/cost.total/contextTokens=totalTokens), captures `model`/`stopReason`/`errorMessage`; on `tool_result_end` → pushes message. Unknown/garbage event → unchanged state.
- `parseNdjson(chunk, carry)`: splits on `\n`, returns `{ events, carry }` keeping a trailing partial line in `carry`.

**GREEN (pure):** implement the three pure functions. `runSingleAgent(...)` composes them:
`writePromptToTempFile` (0600, `withFileMutationQueue`, cleaned in `finally`), `getPiInvocation`
(port from example), `spawn(stdio:["ignore","pipe","pipe"])`, stream → `parseNdjson` →
`accumulateEvent`, `onUpdate` per update, abort → `SIGTERM` then `SIGKILL` after 5s. Unknown
agent → synthetic failed `SingleResult` listing available names.

**Integration RED/GREEN** (`runner.integration.test.ts`, `testTimeout` ok at 15s): point
`getPiInvocation` at a tiny stub script (a `.mjs`/`.cjs` written to a temp dir) that prints two
NDJSON lines (one assistant `message_end` with usage, then exits 0). Assert the returned
`SingleResult` has the accumulated usage, `exitCode 0`, and `getFinalOutput` text. This proves
the spawn+stream wiring without a real model call.

## WP6 — `modes.ts` (orchestration, injected runner)

`modes` never spawns. It receives `runAgent: RunAgentFn` and orchestrates. **All tests inject a
fake runner** returning canned `SingleResult`s (sync/throwing/delayed).

**RED** (`modes.test.ts`):
- `mapWithConcurrencyLimit(items, limit, fn)`: preserves order; never exceeds `limit` in flight (track a counter in the fake); returns all results.
- `runSingle`: calls runner once; wraps into `SubagentDetails{mode:"single"}`; `isError` set when the result failed.
- `runParallel`: rejects `> MAX_PARALLEL_TASKS` with an error result; runs with `MAX_CONCURRENCY`; truncates each visible output via `truncateParallelOutput`; summary `"N/M succeeded"`.
- `runChain`: substitutes `{previous}` with prior step's `getFinalOutput`; **stops at first failure** returning `"Chain stopped at step K (agent): …"`; success returns last step's output; sets `step` index per result.
- `decideMode(params)`: exactly one of single/parallel/chain/list — `0` or `≥2` provided → invalid-args result.

**GREEN:** implement orchestrators + `mapWithConcurrencyLimit` + `decideMode`. Export a
`RunAgentFn` type. No TUI, no `child_process` imports here.

## WP7 — tool assembly + `list` mode + `index.ts`

**RED** (`index.test.ts`, mock `pi: ExtensionAPI` with `vi.fn()` for `registerTool`/`registerCommand`; fake `ctx` with `cwd`,`hasUI`,`ui.confirm`):
- Registers a tool named `subagent` and a `/minion` command.
- `list` mode: `execute({list:true})` returns the roster text from `formatAgentList(discoverAgents(...))` and **does not** call the runner.
- Project-agent gate: with `agentScope:"both"`/`"project"` and a requested project agent, `hasUI` true, `confirmProjectAgents !== false` → calls `ctx.ui.confirm`; on `false` → canceled result, runner not called. (Inject the runner/discovery so this is hermetic.)
- Dispatch: single/parallel/chain params route to the matching `modes` function.

**GREEN:** `export default function (pi: ExtensionAPI)`. Build the `ToolDefinition`
(`name:"subagent"`, `label`, short `description` that **tells the model to call
`{list:true}` first**, `promptGuidelines`, `parameters: SubagentParams`,
`renderCall`/`renderResult` from `render.ts`). `execute` = discover → `decideMode` → confirm
gate → resolve each agent's runtime via `config.resolveAgentRuntime` → call `modes` with the
real runner (`runner.runSingleAgent`). Register `/minion install-agents [--project]` (copies
bundled `agents/*.md` into `~/.pi/agent/agents` or `.pi/agents`, idempotent, skips existing)
and `/minion list`. **No `before_agent_start` hook.**

## WP8 — bundled `agents/*.md` and `prompts/*.md`

Not TDD-unit-tested, but **gated by a manifest test** (`bundled.test.ts`):
- Every file in `agents/` parses via `loadAgentsFromDir` and yields a valid `AgentConfig`; the set of names is exactly `{scout, planner, reviewer, worker}`.
- Each expected `prompts/*.md` exists with frontmatter `description`.

Author content by porting the example's four agent prompts (`scout`,`planner`,`reviewer`,`worker`)
and three workflow prompts (`implement` = scout→planner→worker; `scout-and-plan` = scout→planner;
`implement-and-review` = worker→reviewer→worker), each instructing a `subagent` `chain` call
with `{previous}` and `$@` for user input.

## WP9 — packaging finalize

- Ensure `package.json` `files` excludes tests and includes `agents/**`,`prompts/**`. **No `minion.json`.**
- `npm run pack:dry` → confirm only intended files ship.
- Write `README.md`: install, the three modes + `list`, the `settings.json` `"agents"` override format, `/minion install-agents`, and the v2 breaking-change note (task board / project workspace / resume / todo removed; todos → `@aprimediet/todo`).

---

## End-to-end verification

1. `npm test` — all green; `npm test -- <file>` runs a single file; coverage via `vitest run --coverage`.
2. `npm test` shows pure logic (schema, render helpers, agents, config, runner parse, modes) covered without spawning real `pi`; exactly one runner integration test spawns a stub.
3. Manual smoke in pi: `pi -e ./index.ts`, then in-session: `subagent({list:true})` shows the 4 agents; a single delegation (`scout` find something) returns output; `/implement <task>` runs the chain.
4. `pi -e ./index.ts` with a `~/.pi/agent/settings.json` containing `{"agents":{"scout":{"model":"<m>"}}}` → the scout subprocess is invoked with `--model <m>` (verify via the spawned args / a debug log), proving settings override frontmatter.

## Definition of done

- [ ] WP0–WP9 complete; every production module has a colocated `*.test.ts` written **before** it.
- [ ] `npm test` green; no test weakened/skipped to pass.
- [ ] No `child_process`/TUI imports in `modes.ts`; `modes` tested only with injected fakes.
- [ ] 4 agents + 3 prompts present and manifest-validated; no `minion.json`.
- [ ] `pack:dry` clean; README documents the `settings.json` `agents` override and the breaking change.
- [ ] Manual pi smoke (list, single, chain, settings override) passes.
