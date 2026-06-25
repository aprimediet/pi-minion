# @aprimediet/minion

Claude-Code-style **delegation** for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a TodoWrite-style task tracker, a `subagent` (Task) tool that runs work in isolated `pi` subprocesses, a **persistent kanban task board** for cross-session delegation, and a **bundled library of 12 specialized agents** with per-agent model config.

pi is also made **aware of its delegation capability and the agent roster** every turn (injected into the system prompt), and on session start it **surfaces unfinished board tasks and resumes them** by delegating to each task's designated agent.

## Tools & commands

| Kind | Name | What it does |
|---|---|---|
| Tool | `todo_write` | maintain an in-session task list (full-list replace; one `in_progress` at a time) |
| Command | `/todos` | show the current task list |
| Tool | `subagent` | delegate to an agent in an isolated context — **single / parallel / chain**; pass `taskId` to run a board task |
| Tool | `task` | manage the persistent kanban board — `create`/`update`/`list`/`get` cards with a designated agent + structured instruction |
| Command | `/tasks [all\|<id>]` | show the kanban board (or one card's detail) |
| Command | `/minion install-agents [--project]` | (optional) export the bundled agents for editing |
| Prompt | `/implement <x>` | chain: explore → plan → general-purpose |
| Prompt | `/scout-and-plan <x>` | chain: explore → plan (no implementation) |
| Prompt | `/implement-and-review <x>` | chain: general-purpose → code-reviewer → general-purpose |
| Prompt | `/review <x>` | parallel: code-reviewer + silent-failure-hunter + type-design-analyzer |

### `subagent` modes
- **single** — `{ agent, task }`
- **parallel** — `{ tasks: [{agent, task}, …] }` (≤8 total, ≤4 concurrent; output capped at 50 KB/task to the model)
- **chain** — `{ chain: [{agent, task}, …] }` where `task` may contain `{previous}` (the prior step's output)

Each subagent runs as a real `pi --mode json -p --no-session` subprocess (isolated context), streams progress live, and Ctrl+C kills it (SIGTERM→SIGKILL).

## Persistent task board & project storage (clean working tree)

minion keeps a durable **kanban board** so delegated work survives across sessions. The only thing written into your working tree is a single identifier file, `<cwd>/.pi/<project-id>.md`; everything else lives globally under `~/.pi/projects/<project-id>/`:

```
<cwd>/.pi/<project-id>.md     ← the ONLY working-tree artifact (a pointer)
~/.pi/projects/<project-id>/
  project.json                metadata (id, name, paths seen, timestamps)
  tasks/<task-id>.md          kanban cards: status, agent, instruction, acceptance, activity log
  todos/<session>.md          in-session todo snapshots
  delegations/<ts>-*.md        full record of every subagent delegation (task sent + result)
```

This is **shared with `@aprimediet/memory`**: both use the same deterministic project id (`<dir-slug>-<8charPathHash>`, recorded in the marker) and the same marker file, so the two extensions cooperate in one `~/.pi/projects/<id>/` workspace with a single cwd pointer.

**Kanban columns (status):** `backlog → todo → in_progress → blocked → review → done → cancelled`. A card carries a **designated agent** (assignee) and a **structured instruction** (+ acceptance criteria) the subagent can execute directly.

**Delegate a task:** `subagent({ agent, taskId })` loads the card's instruction, marks it `in_progress`, runs, then sets it to `review` (success) or `blocked` (failure) and appends to its activity log — and records the full delegation under `delegations/`.

**Resume on start:** unfinished cards (`todo`/`in_progress`/`blocked`) are injected into the system prompt at session start with an instruction to resume them by delegating to their agent. View anytime with `/tasks`.

## Bundled agents

`general-purpose`, `explore`, `plan`, `code-reviewer`, `code-simplifier`, `silent-failure-hunter`, `type-design-analyzer`, `comment-analyzer`, `pr-test-analyzer`, `debugger`, `test-writer`, `docs-writer`.

They are **bundled in the extension** and work immediately — no copy step. User agents in `~/.pi/agent/agents/` and (with `agentScope:"both"`, trust-gated) project agents in `.pi/agents/` override bundled ones by name.

## Per-agent models

The default model per agent lives in **`~/.pi/agent/minion.json`** (copied from the bundled default on first run — never overwriting an existing file). Edit it, or add a project `.pi/minion.json` to override:

```json
{ "models": { "*": "claude-sonnet-4-6", "explore": "claude-haiku-4-5", "code-reviewer": "claude-opus-4-8" } }
```

Resolution: project per-name → global per-name → project `*` → global `*` → agent frontmatter `model:` → `MINION_DEFAULT_MODEL` / `--default-agent-model` → pi default. Re-read each invocation.

## Install / run

```bash
pi install npm:@aprimediet/minion
pi list

# Quick try without installing
pi -e ./extensions/minion/index.ts
```

## Layout

```
minion/                    # @aprimediet/minion
├── package.json           # pi manifest: extensions + prompts
├── index.ts               # factory: wires tools + /minion + /tasks + model seeding + resume
├── todo.ts                # todo_write + /todos + todos/ snapshots
├── subagent.ts            # subagent tool (subprocess engine) + delegation records + taskId
├── tasks.ts               # persistent kanban board (task tool) + delegation/resume helpers
├── project.ts             # project identity + ~/.pi/projects/<id>/ layout (memory-compatible)
├── agents.ts              # discovery (bundled+user+project) + resolveAgentModel + delegation prompt
├── minion.json            # default per-agent model map (seeded to ~/.pi/agent/)
├── agents/                # 12 bundled agent definitions
└── prompts/               # 4 workflow slash-commands
```

No third-party runtime deps — only the five pi-core packages (peer, bundled by pi).
