# @aprimediet/minion

> Lean subagent delegation for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
> Each subagent runs in an isolated subprocess with its own context window.

## What it does

Adds a single `subagent` tool to your pi session that delegates work to
specialized agents (scout, planner, reviewer, worker) running as isolated
`pi --mode json` subprocesses. Three modes:

- **Single** — one agent, one task
- **Parallel** — up to 8 tasks, 4 concurrent; each result capped at 50 KB
- **Chain** — sequential steps with `{previous}` placeholder; stops at first failure

Plus a lazy `list` mode so the model can discover the roster on demand.

## Install

```sh
pi install npm:@aprimediet/minion
```

Then install the bundled agent definitions:

```text
/minion install-agents
```

(add `--project` to put them in `.pi/agents/` instead of `~/.pi/agent/agents/`).

## Usage

```text
# Discover available agents
subagent({ list: true })

# Single delegation
subagent({ agent: "scout", task: "find auth flow" })

# Parallel fan-out
subagent({ tasks: [{ agent: "scout", task: "auth" }, { agent: "scout", task: "billing" }] })

# Chain: scout → planner → worker
subagent({ chain: [
  { agent: "scout", task: "explore $@" },
  { agent: "planner", task: "plan based on: {previous}" },
  { agent: "worker", task: "implement: {previous}" }
] })
```

Bundled workflow prompts:

- `/implement <query>` — scout → planner → worker
- `/scout-and-plan <query>` — scout → planner
- `/implement-and-review <query>` — worker → reviewer → worker

## Per-agent overrides

Override an agent's `model` or `tools` via pi's existing
`~/.pi/agent/settings.json` under a new top-level `"agents"` key:

```json
{
  "agents": {
    "planner": { "model": "opencode/big-pickle", "tools": "read,write,bash" }
  }
}
```

Resolution per field, first hit wins:

1. `settings.json#agents[name].model` / `.tools`
2. agent frontmatter `model:` / `tools:`
3. otherwise omit the flag

The settings file is read fresh per invocation, so edits apply live.

## Breaking change vs v1

`@aprimediet/minion` v2 is a **deliberate scope reduction**:

- ❌ Removed: persistent kanban `task` board
- ❌ Removed: `~/.pi/projects/<id>/` workspace, deterministic project IDs, marker files
- ❌ Removed: session-start task resume
- ❌ Removed: `todo_write` (now a separate package — `@aprimediet/todo` v1.0.0+)
- ❌ Removed: v1's six-level model-resolution chain

What stays: the same delegation engine you already know, but split into small
single-responsibility modules (`schema` / `agents` / `config` / `runner` /
`modes` / `render` / `index`), each unit-tested in isolation.

If you still want todos, install alongside:

```sh
pi install npm:@aprimediet/todo
```

## License

MIT