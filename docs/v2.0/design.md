# minion v2 — Design Document

> **Lean subagent-delegation rework of `@aprimediet/minion`.**
> The open questions in the first draft (O1–O4) are now **resolved** (see §12) and folded
> into this document. The executable build plan derived from this design — with mandatory
> red→green TDD — lives in [`./specs.md`](./specs.md). This file is the *what/why*; `specs.md`
> is the *how*.

## 1. Context & motivation

minion v1 (`@aprimediet/minion` 1.1.0) grew into a multi-subsystem extension:
subagent delegation **plus** a persistent kanban board, a `~/.pi/projects/<id>/`
workspace, deterministic project IDs, session-start task resume, and (until 1.1.0) an
in-session `todo_write` tool. The delegation engine alone (`subagent.ts`) reached ~766
lines, and the orchestration, subprocess handling, model resolution, and TUI rendering
were entangled.

v2 is a **complete rework with a deliberately narrow scope: delegation only.** We keep
exactly what the pi example subagent extension does — delegate well-scoped work to
specialized agents running in isolated subprocesses — and we re-architect it into small,
single-responsibility modules. Everything v1 layered on top (task board, project
workspace, resume, todo) is **out of scope** and removed.

The goal: the same capability as the example, but with a module structure that is easy to
read, test, and extend.

## 2. What the example does (analysis)

The example is a single `pi.registerTool({ name: "subagent", … })` with three modes:

| Mode | Params | Behavior |
|------|--------|----------|
| Single | `{ agent, task, cwd? }` | One agent, one task. |
| Parallel | `{ tasks: [{agent, task, cwd?}], … }` | Up to **8** tasks, **4** concurrent; each result capped at **50 KB** for the parent model. |
| Chain | `{ chain: [{agent, task}], … }` | Sequential; `{previous}` in a step's task is replaced with the prior step's final text. Stops at first failure. |

**How a subagent runs (`runSingleAgent`):**
1. Look up the agent by name in the discovered set; unknown name → synthetic failed result listing available agents.
2. Build args: `["--mode","json","-p","--no-session"]`, plus `--model <m>` if the agent declares one and `--tools <a,b>` if it restricts tools.
3. If the agent has a system prompt, write it to a temp file (`mkdtemp` + `withFileMutationQueue`, mode `0600`) and append `--append-system-prompt <file>`.
4. Append the final positional arg `Task: <task>`.
5. Resolve the binary via `getPiInvocation` (re-invokes the current script under the same runtime, falling back to the `pi` command for generic node/bun runtimes).
6. `spawn` with `stdio: ["ignore","pipe","pipe"]`; parse **line-delimited JSON** off stdout. On `message_end` collect the `Message` + accumulate usage (input/output/cacheRead/cacheWrite/cost/contextTokens/turns) and capture `model`/`stopReason`/`errorMessage`; on `tool_result_end` collect the message. Stream partials via `onUpdate`.
7. Abort (`AbortSignal`) → `SIGTERM`, then `SIGKILL` after 5s; mark aborted and throw.
8. Always clean up the temp prompt file/dir in `finally`.

**Agent discovery (`agents.ts`):** reads `*.md` (file or symlink) with YAML frontmatter
(`name`, `description`, `tools` CSV, `model`) and the body as the system prompt. Sources:
user (`<agentDir>/agents`) and project (nearest `.pi/agents` walking up via
`CONFIG_DIR_NAME`). `agentScope` ∈ `user | project | both` controls which load; in `both`
project overrides user by name.

**Security model:** default scope is `user`. Project-local agents (`project`/`both`) are
repo-controlled and gated behind an interactive `ctx.ui.confirm` when `ctx.hasUI` and
`confirmProjectAgents !== false`.

**Rendering:** rich `renderCall`/`renderResult` using `@earendil-works/pi-tui`
(`Container`, `Text`, `Markdown`, `Spacer`) with collapsed/expanded views, per-tool-call
formatting (`$ cmd`, `read ~/p:1-10`, `grep /pat/ in …`), usage stats line, and live
parallel status (`2/3 done, 1 running`).

**What the example deliberately omits:** any persistence, any central model config (model
comes only from agent frontmatter), and any auto-install (agents are symlinked in by hand).

### Strengths to keep
- Subprocess = genuinely isolated context window per subagent.
- The three-mode design (single/parallel/chain) is expressive and matches the bundled workflow prompts.
- NDJSON streaming + `onUpdate` gives good live feedback.
- The `user`/`project`/`both` scope + confirm gate is a sensible trust boundary.

### Weaknesses to fix
- **One 1015-line file** mixes orchestration, subprocess I/O, schema, and ~600 lines of TUI rendering.
- Formatting helpers, usage math, and pi-invocation logic are interleaved with control flow.
- No first-class types module; result/detail shapes are declared inline.

## 3. v2 scope

**In scope (lean delegation):**
- A single `subagent` tool with single / parallel / chain modes (behavior identical to the example), plus a lazy `list` mode for roster discovery (§9).
- Agent discovery from user + project markdown definitions, with the same scope/confirm security model.
- Per-agent `model`/`tools` overrides from pi's `settings.json` (§6).
- A bundled library of agent definitions and a small set of workflow prompts.
- Rich TUI rendering (collapsed/expanded, streaming, usage).

**Out of scope (removed vs v1):**
- Persistent kanban task board (`task` tool, `tasks.ts`).
- `~/.pi/projects/<id>/` workspace, deterministic project IDs, marker files (`project.ts`).
- Session-start task resume and `before_agent_start` resume-prompt injection.
- `todo_write` (already extracted to `@aprimediet/todo` in v1.1.0).
- v1's six-level model-resolution chain.

## 4. Proposed architecture

Split the example's monolith into focused modules. Target ~100–250 lines each.

```
minion/
├── index.ts        # thin entry: wires modules; registers tool + /minion command
├── agents.ts       # discovery + frontmatter parsing (port from example, lightly cleaned)
├── config.ts       # per-agent model/tools overrides from settings.json — see §6
├── schema.ts       # TypeBox params + result/detail TypeScript types
├── runner.ts       # runSingleAgent: spawn, NDJSON parse, usage, abort, temp prompt
├── modes.ts        # single / parallel / chain orchestration + concurrency limiter
├── render.ts       # renderCall / renderResult + formatting helpers
├── agents/*.md     # bundled agent definitions (see §7)
├── prompts/*.md    # workflow prompts (see §8)
├── package.json    # pi manifest + peer deps
└── README.md
```

**Dependency direction (no cycles):**
`index.ts` → { `modes`, `render`, `agents`, `config`, `schema` };
`modes` → `schema` (the runner is **injected**, not imported — §13);
`render` → `schema`; `runner` → { `schema`, `config` }; `config` → { `schema`, `agents` }.
`schema` depends on nothing internal.

### Module responsibilities

- **`schema.ts`** — the single source of truth for shapes. Exports the TypeBox
  `SubagentParams` (with `agent`/`task`/`tasks`/`chain`/`list`/`agentScope`/`confirmProjectAgents`/`cwd`)
  and `TaskItem`/`ChainItem`/`AgentScopeSchema`, plus the TS types `UsageStats`,
  `SingleResult`, `SubagentDetails`, and `AgentOverride`. Removing these from the
  orchestration file is the biggest readability win over the example.

- **`runner.ts`** — everything about running *one* subprocess: `runSingleAgent`,
  `writePromptToTempFile`, `getPiInvocation`, and the pure helpers `buildPiArgs`,
  `parseNdjson`, `accumulateEvent` (split out for unit testing — §13). Pure I/O; no TUI
  imports. Returns a `SingleResult`.

- **`modes.ts`** — the three orchestrators (`runSingle`, `runParallel`, `runChain`), a
  `decideMode` validator, and the `mapWithConcurrencyLimit` helper. Owns the constants
  `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `PER_TASK_OUTPUT_CAP=50KB`. Receives the
  runner as an injected `RunAgentFn`. No subprocess details, no rendering.

- **`render.ts`** — all `@earendil-works/pi-tui` usage: `renderCall`, `renderResult`,
  `formatToolCall`, `formatUsageStats`, `formatTokens`, `getDisplayItems`,
  `getFinalOutput`, `truncateParallelOutput`, `isFailedResult`. Pure presentation over
  `SubagentDetails`.

- **`agents.ts`** — discovery, unchanged in spirit from the example (`discoverAgents`,
  `loadAgentsFromDir`, `findNearestProjectAgentsDir`, `formatAgentList`).

- **`config.ts`** — per-agent overrides from `settings.json` — see §6.

- **`index.ts`** — `export default function (pi: ExtensionAPI)`: assemble the
  `ToolDefinition` from `schema` + `modes` + `render`, register it, and register the
  `/minion` command (§7). **No event hooks** — roster discovery is the tool's lazy `list`
  mode (§9).

## 5. The `subagent` tool — contract

- **name/label:** `subagent` / "Subagent".
- **description:** delegation summary + the three modes + default scope note (mirrors the example, which references `getAgentDir()/agents` and `CONFIG_DIR_NAME/agents`), and a one-line pointer telling the model to call `{ list: true }` first to see available agents (§9).
- **promptGuidelines** (static, via `ToolDefinition`): when to use single vs parallel vs chain; that subagents have isolated context so tasks must be self-contained.
- **parameters (TypeBox):** `agent?`, `task?`, `tasks?`, `chain?`, `list?`, `agentScope?` (default `"user"`), `confirmProjectAgents?` (default `true`), `cwd?`.
- **execute:** discover agents for `ctx.cwd`+scope; require **exactly one** mode (single/parallel/chain/list); for `list`, return the roster without spawning; otherwise gate project agents behind `ctx.ui.confirm` when applicable, resolve each agent's effective model/tools via `config` (§6), and dispatch to `modes`.
- **renderCall/renderResult:** delegate to `render.ts`.

Result/detail shapes (`SingleResult`, `SubagentDetails`) are preserved so the rendering
logic ports over unchanged.

## 6. Per-agent overrides (model + tools) — resolved

Per-agent `model` and `tools` overrides live in pi's existing **`~/.pi/agent/settings.json`**
under a new top-level `"agents"` key (the key is unused by pi core):

```json
{
  "agents": {
    "planner": { "model": "opencode/big-pickle", "tools": "read,write,bash" }
  }
}
```

**Resolution (per field, first hit wins):**
1. `settings.json` → `agents[<name>].model` / `.tools` (override)
2. agent frontmatter `model:` / `tools:` (fallback)
3. otherwise omit the flag (let pi use its own default tool/model set)

`config.ts` exposes `readAgentOverrides(settingsPath?)` and `resolveAgentRuntime(agent, overrides)`,
mirroring the direct-read pattern in sibling `../todo/config.ts` (read + `JSON.parse`, fail-soft
to `{}`). The settings file is read fresh per invocation so edits apply live, and the path is
injectable so tests stay hermetic. **No separate `minion.json` file** — overrides reuse pi's
own settings store.

## 7. Bundled agents & installation — resolved

Ship exactly four agents as `agents/*.md` (frontmatter: `name`, `description`, `tools`,
`model`; body = system prompt), mirroring the example's archetypes:

- `scout` — fast read-only recon (haiku; `read, grep, find, ls`).
- `planner` — read-only implementation planning (sonnet).
- `reviewer` — read-only code review (sonnet/opus).
- `worker` — full-capability implementation (sonnet, default tools).

(More can be added later as separate `.md` files at zero code cost.)

**Installation:** instead of v1's auto-seed on `session_start`, provide an explicit
`/minion install-agents [--project]` command that copies bundled `agents/*.md` into
`~/.pi/agent/agents` only when asked. Explicit, no hidden writes,
idempotent (skips existing files). The README also documents the symlink approach the
example uses.

## 8. Workflow prompts

Ship `prompts/*.md` (registered via package.json `pi.prompts`), each instructing the model
to call `subagent` with a `chain`/`tasks` shape. Carry over the example's three:
- `/implement <q>` — chain: scout → planner → worker.
- `/scout-and-plan <q>` — chain: scout → planner.
- `/implement-and-review <q>` — chain: worker → reviewer → worker.

(v1's parallel `/review` can be added later as a `tasks`-mode prompt — no code change.)

## 9. Roster discovery — lazy `list` mode (resolved)

To let the model learn which subagents exist **without** bloating the start-of-session
system prompt, v2 uses a lazy `list` mode rather than any prompt injection:

- The tool's short, static `description` tells the model to call `subagent({ list: true })`
  before delegating.
- `list` mode returns the roster (`formatAgentList(discoverAgents(...))` — name + source +
  description) and does **not** spawn anything.
- The unknown-agent error result still lists available agents as a safety net.

This injects the roster *exactly when delegation is imminent*, costs zero standing context,
and scales as agents are added. There is **no `before_agent_start` hook** and no other event
hook in v2.

## 10. Packaging

`package.json` mirrors v1's manifest, minus the `@aprimediet/todo` peer dep and any
task/project concerns:

```jsonc
{
  "name": "@aprimediet/minion",
  "version": "2.0.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"], "prompts": ["./prompts"] },
  "files": ["*.ts", "agents/**", "prompts/**", "README.md", "LICENSE"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

ESM + `.ts` imports throughout (matches the example's `import … from "./agents.ts"`).
v2.0.0 is a breaking change — README documents the removal of the task board / project
workspace / resume / todo and points users to `@aprimediet/todo` if they still want todos.

## 11. What we explicitly do NOT build

No `task` tool, no `tasks.ts`, no `project.ts`, no `~/.pi/projects/<id>/` workspace, no
deterministic project IDs / marker files, no session-resume, no `todo_write`, no `minion.json`,
no `before_agent_start` hook / standing roster injection. Delegation is the whole product.

## 12. Resolved decisions (were O1–O4)

- **O1 → §6.** Per-agent overrides read from `~/.pi/agent/settings.json` under `"agents"`, covering both `model` and `tools`; precedence is **settings → frontmatter**. No `minion.json`.
- **O2 → §7.** Exactly four bundled agents: `scout`, `planner`, `reviewer`, `worker`.
- **O3 → §9.** Lazy `list` mode on the tool; no prompt-injection hook.
- **O4 → §10.** Reuse `@aprimediet/minion` at `2.0.0` (breaking change).

## 13. Build plan & testability

The executable, TDD-disciplined build plan is **[`./specs.md`](./specs.md)** (work packages
WP0–WP9, red→green per unit). Two testability-driven refinements of the wiring above:

1. **`modes.ts` takes the runner as an injected `RunAgentFn`** so the orchestration
   (single/parallel/chain, concurrency, `{previous}` substitution, 50 KB truncation,
   exactly-one-mode validation) is unit-tested without spawning real `pi` processes.
2. **`runner.ts` exposes pure `buildPiArgs` / `parseNdjson` / `accumulateEvent`** split from
   the `spawn` shell, so arg-building and NDJSON/usage logic are unit-tested; the real spawn
   gets a single integration test against a stub NDJSON script.

Test harness follows repo convention (vitest `^1.6.0`, `tsconfig.json` + `vitest.config.ts`,
temp-dir filesystem tests), mirroring sibling `../todo`.
