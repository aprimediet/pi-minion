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

Bundled agents (`scout`, `planner`, `reviewer`, `worker`) are **automatically available** after install — no setup command needed. They live in the extension's `agents/` folder and load on every invocation.

Override a bundled agent by name:
- Drop a same-name file into `~/.pi/agent/agents/` (user override)
- Drop a same-name file into `<cwd>/.pi/agents/` (project override, confirmed at first use)
- Override `model` or `tools` via `settings.json#agents.<name>`

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

- `/init` — bootstrap a new project with `AGENTS.md` (conventions) and `PRD.md` (product requirements) via an interactive 8-question interview with 4 approval gates (modeled on the brainstorming skill pattern)
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

## Primary agents (v2.1)

On top of the subagent tool, minion v2.1 ships **primary agents** — named
personas for the *main* loop. Two are bundled and always loaded:

- **`build`** — full-capability execution mode (default at session start).
- **`plan`** — read-only planning mode (no `edit`/`write`/`bash`).

Switch the active primary:

| Way                              | Effect                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| `Shift+Tab`                      | Cycle through bundled + user primaries                           |
| `Alt+T`                          | Cycle thinking level                                             |
| `/plan` / `/build`               | Jump directly to the named primary                               |
| `/minion plan` / `/minion build` | Same, via the `/minion` command                                  |
| `/minion <name>`                 | Switch to a custom primary by name                               |
| `pi -e ./index.ts --agent plan`  | Start the session with `plan` active                             |

`Shift+Tab` is the O2 target per [docs/v2.1/design.md](./docs/v2.1/design.md) §O2,
but pi's built-in `app.thinking.cycle` (`shift+tab` by default) is in
`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` with `restrictOverride=true`,
so a naive `registerShortcut("shift+tab", …)` is silently dropped at
runtime. To free the key for primary cycling, add this to
`~/.pi/agent/keybindings.json`:

```json
{
  "app.thinking.cycle": ["ctrl+shift+tab"]
}
```

That moves thinking-level cycling to `Ctrl+Shift+Tab` (a free key). After
that, the extension's `Shift+Tab` binding wins and the primary cycle
becomes active. `Alt+T` (this extension) remains as a free-thinking-level
alternative. See [docs/v2.1/design.md](./docs/v2.1/design.md) §O2 and the
WP0 decision note in [primaries.ts](./primaries.ts) for the rationale.

### Defining your own primary

A primary is just an agent file with `type: primary` in its frontmatter.
Drop a `*.md` into `~/.pi/agent/agents/` (or `<cwd>/.pi/agents/`):

```markdown
---
name: research
type: primary
description: Read-only research mode — gather notes, propose next steps.
tools: read, grep, find, ls
---

You are in RESEARCH MODE. ...
```

The new file becomes part of the `Shift+Tab` cycle and shows up in
`/minion primaries`. User primaries override bundled ones **by name** (e.g.
a user `~/.pi/agent/agents/build.md` replaces the bundled `build`); new
names append to the cycle.

### Persisting a model choice for a primary

When you change the model while a primary is active, minion writes the
choice to `~/.pi/agent/settings.json` so the next session picks up where
you left off:

```json
{
  "agents": {
    "plan": { "model": "claude-opus-4-5" }
  }
}
```

Resolution for `apply(name)` is `settings.json#agents[name]` → frontmatter
→ inherit the user's current model.

## Breaking change vs v1

`@aprimediet/minion` v2 is a **deliberate scope reduction**:

- ❌ Removed: persistent kanban `task` board
- ❌ Removed: `~/.pi/projects/<id>/` workspace, deterministic project IDs, marker files
- ❌ Removed: session-start task resume
- ❌ Removed: `todo_write` (now a separate package — `@aprimediet/todo` v1.0.0+)
- ❌ Removed: v1's six-level model-resolution chain

What stays: the same delegation engine you already know, but split into small
single-responsibility modules (`schema` / `agents` / `config` / `runner` /
`modes` / `render` / `primaries` / `index`), each unit-tested in isolation.

If you still want todos, install alongside:

```sh
pi install npm:@aprimediet/todo
```

## License

MIT