# AGENTS.md — @aprimediet/minion

Guide for coding agents working in this repository. Product context (goals, users,
features, success metrics): see [docs/PRD.md](docs/PRD.md).

## Summary

A pi extension that brings structured delegation to the pi coding agent: `todo_write`,
`subagent` (isolated subprocess delegation), a persistent kanban `task` board, and
12 bundled specialized agents with per-agent model configuration.

## Tech Stack

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js (via pi's bundled packages)
- **Package Manager:** npm
- **Peer Dependencies:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`
- **No third-party runtime dependencies** — only pi packages + typebox (for runtime type validation)
- **Build:** TypeScript, compiled/run within pi's environment (no standalone build step)
- **No test framework configured** — no test directory, no vitest/jest config

## Project Structure

```
minion/
├── index.ts               # Extension main: registers tools, commands, event handlers
├── agents.ts              # Agent discovery (bundled + user + project) + model resolution
├── project.ts             # Project identity + ~/.pi/projects/<id>/ layout
├── subagent.ts            # subagent tool engine (subprocess spawn + streaming)
├── tasks.ts               # Kanban board + task tool + delegation records
├── todo.ts                # todo_write tool + in-session checklist
├── minion.json            # Default per-agent model map
├── agents/                # 12 bundled agent definitions (*.md files)
│   ├── general-purpose.md
│   ├── explore.md
│   ├── plan.md
│   ├── code-reviewer.md
│   ├── code-simplifier.md
│   ├── debugger.md
│   ├── test-writer.md
│   ├── docs-writer.md
│   ├── silent-failure-hunter.md
│   ├── type-design-analyzer.md
│   ├── comment-analyzer.md
│   └── pr-test-analyzer.md
├── prompts/               # 4 slash-command chain workflow templates
│   ├── implement.md
│   ├── implement-and-review.md
│   ├── review.md
│   └── scout-and-plan.md
└── package.json           # Pi manifest: extensions + prompts
```

## Commands

- **Install:** `pi install npm:@aprimediet/minion` (or `pi list` to verify)
- **Try without installing:** `pi -e ./extensions/minion/index.ts`
- **Export agents for editing:** `/minion install-agents [--project]`
- **View task board:** `/tasks [all|<id>]`
- **View in-session todos:** `/todos`
- **No standalone build/test/run commands** — this is a pi extension, run inside pi

## Conventions

- **ESM only** — all imports use `import` syntax; no `require()`
- **TypeScript** — all source files are `.ts`, using Node-style imports with `.ts` extension
- **No barrel exports** — each module exports only what it needs to
- **Pi SDK patterns**:
  - Register tools via `pi.registerTool({ name, label, description, parameters, execute, renderCall?, renderResult? })`
  - Register commands via `pi.registerCommand(name, { description, handler })`
  - Listen for events via `pi.on("session_start" | "before_agent_start", handler)`
  - Register flags via `pi.registerFlag(name, { description, type })`
- **Error handling** — catch and log non-fatally (silent on failure); never crash the extension
- **File mutation** — use `withFileMutationQueue` for atomic writes (write to `.tmp`, then `rename`)
- **Filesystem paths** — use `resolveProject(ctx.cwd)` to get all paths; never hardcode
- **Tool descriptions** — keep concise, include promptSnippet and promptGuidelines
- **Async I/O** — prefer `fs.promises.*` for file operations; use `fs.*Sync` for small/sync reads
- **Subprocess management** — subagents run as real `pi` subprocesses; SIGTERM→SIGKILL on abort
- **Agent definitions** — markdown files with YAML frontmatter (`name`, `description`, `tools`, `model`, body as system prompt)

## Boundaries (technical)

- **Do NOT modify** files under `~/.pi/projects/<id>/` directly — this is runtime data managed by minion's tools
- **Do NOT hardcode paths** — always use `resolveProject(ctx.cwd)` or `getAgentDir()`
- **The `.pi/<project-id>.md` marker** is the only working-tree artifact; do not write other files under `.pi/`
- **This workspace is shared with `@aprimediet/memory`** — same project ID, same marker, same `~/.pi/projects/<id>/` directory
- **Do NOT add third-party runtime dependencies** — the package intentionally has no deps beyond pi packages + typebox
- **Do NOT change the deterministic project ID algorithm** (`slug(path.basename(root)) + "-" + sha1(root)[:8]`) — it must stay compatible with @aprimediet/memory

## Known Issues & Gotchas

- No test infrastructure — test coverage is zero. Any new ts files or logic changes should include tests.
- No `tsconfig.json` — works because pi's environment handles TypeScript compilation; standalone TypeScript tooling may not work directly.
- Subagent subprocess output is capped at 50KB per task in parallel mode.
- Agent resolution priority: bundled (lowest) → user (override) → project (highest). User and project agents can shadow bundled ones by name.
- The `/implement` and `/scout-and-plan` prompts use `$@` placeholder which is replaced by the user's input at invocation time.

## Companion Extensions

- **`@aprimediet/memory`** (active, shared workspace) — both extensions use the same project ID and marker file. When working on this project, check memory for durable facts at session start. Save important decisions via `memory_write`.
- **`@aprimediet/minion`** (this project) — active, 0 open tasks. The kanban board and delegation system are managed by minion itself. The project has no persistent tasks.

## Current Focus

The extension is at v1.0.0 with all core features implemented. Recent commits:
- `54c3336` — chore: bump version to 1.0.0
- `1df7630` — Initial commit: pi-minion extension

Next likely areas: test infrastructure, CI setup, issue tracking, enhanced delegation logging.
