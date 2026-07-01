# CLAUDE.md

This file give Claude Code (claude.ai/code) guide for work with code in this repo.

## Repository state: mid-rework (v2)

This `@aprimediet/minion`, **pi coding agent extension** give subagent
delegation. Now **rework v1 → v2**. Working tree
have **no source files** — all v1 code delete on disk, live only in git history
(`HEAD`). One true artifact = v2 design:

- **`docs/v2.0/design.md`** — spec for what build. Read first; it source
  of truth for scope, architecture, module boundaries.

When build, **port reference code from two place**:
1. pi SDK canonical example: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (`index.ts`/`agents.ts` this rework copy).
2. v1 minion in git history: `git show HEAD:subagent.ts`, `git show HEAD:agents.ts`, `git show HEAD:agents/<name>.md`, etc.

## What v2 is (and is not)

v2 = **lean delegation only**. Per `docs/v2.0/design.md`:
- **In scope:** one `subagent` tool, three mode — single / parallel / chain — run each subagent as isolated `pi --mode json` subprocess; markdown agent defs; few workflow prompts; rich TUI render.
- **Out of scope (remove from v1):** persistent kanban `task` board, `~/.pi/projects/<id>/` workspace, deterministic project IDs / marker files, session-start resume, `todo_write` (pull to `@aprimediet/todo` in v1.1.0), v1 multi-level model-resolution chain.

No bring back removed subsystems unless design doc update. Four open
design question (O1–O4: model-config depth, bundled agent set, prompt-injection hook,
package naming) sit at end of design doc, not yet settle.

## Planned architecture (target module layout)

Rework main goal = **cleaner architecture**: split example ~1015-line
monolith `index.ts` into single-responsibility modules with acyclic dep graph
(`index → modes/render/agents/config/schema`; `modes → runner`; `render`/`runner → schema`):

- `schema.ts` — TypeBox `SubagentParams` + `UsageStats` / `SingleResult` / `SubagentDetails` types (one source of truth for shapes).
- `runner.ts` — run one subprocess: spawn, NDJSON-stream parse, usage accumulate, abort, temp prompt file. No TUI imports.
- `modes.ts` — single / parallel / chain orchestration + concurrency limiter. Own limits `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `PER_TASK_OUTPUT_CAP=50KB`.
- `render.ts` — all `@earendil-works/pi-tui` render (`renderCall`/`renderResult` + format helpers).
- `agents.ts` — agent discovery + frontmatter parse.
- `config.ts` — per-agent `model`/`tools` overrides from `~/.pi/agent/settings.json` `agents` key, override frontmatter (see design §6).
- `index.ts` — thin entry, wire above into one `pi.registerTool(...)`.

## How subagents execute (the core mechanic)

Each subagent = real child process — `pi --mode json -p --no-session` plus `--model`,
`--tools`, `--append-system-prompt <tmpfile>` (agent system prompt write to
0600 temp file). Parse stdout as **line-delimited JSON**: `message_end` events carry
assistant `Message` + usage; `tool_result_end` events carry tool output. Abort →
`SIGTERM`, then `SIGKILL` after 5s. Subprocess isolation = whole point — give each
subagent fresh context window.

## Agent definitions

Agents = markdown files with YAML frontmatter (`name`, `description`, `tools` as CSV,
`model`) and body = system prompt. Discovery scopes: `user`
(`<agentDir>/agents`), `project` (nearest `.pi/agents`), or `both`. **Security model:**
default scope = `user`; project-local agents = repo-controlled, must gate behind
`ctx.ui.confirm` when `ctx.hasUI` and `confirmProjectAgents !== false`.

## Commands & workflow

This pi extension — **no build, lint, or test step**, no `tsconfig.json`
(pi runtime handle TypeScript/ESM). To work with it:

- **Try locally, no install:** `pi -e ./index.ts`
- **Install from npm:** `pi install npm:@aprimediet/minion`
- **In-session commands:** workflow prompts `/implement`, `/scout-and-plan`, `/implement-and-review`. Bundled agents auto-load from the extension's `agents/` folder — no install step needed.
- **Packaging dry-run (from v1 scripts):** `npm run pack:dry`

**No test infrastructure** — coverage zero, no test framework configured.

## Conventions (pi extension)

- **ESM only**, all files `.ts`, imports use explicit `.ts` extensions (e.g. `import { ... } from "./agents.ts"`). No `require()`, no barrel exports.
- **No third-party runtime deps** — only pi peer packages (`@earendil-works/pi-coding-agent`, `-agent-core`, `-ai`, `-tui`) + `typebox` for runtime validation.
- **SDK registration patterns:** tools via `pi.registerTool({ name, label, description, parameters, execute, renderCall?, renderResult? })`; commands via `pi.registerCommand`; events via `pi.on(...)`; flags via `pi.registerFlag`. `execute` return `AgentToolResult` (`{ content, details?, isError? }`) and get `(toolCallId, params, signal, onUpdate, ctx)`.
- **Atomic file writes:** use `withFileMutationQueue` (write `.tmp`, then `rename`).
- **Fail non-fatally:** catch and degrade; never crash host pi session.
- **Manifest:** `package.json` `pi` field declare `extensions` and `prompts`; `files` allowlist control what publishes.

## Git note

Working tree show every v1 file as deleted — that intended start point for
rework, not accident. Recreate v2 files fresh per design doc, not
revert deletions wholesale.