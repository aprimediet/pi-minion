<!-- prettier-ignore -->
<div align="center">

# minion

*Subagent delegation extension for the pi coding agent*

\[!\[npm version\](https://img.shields.io/npm/v/@aprimediet/minion?style=flat-square)\](https://www.npmjs.com/package/@aprimediet/minion)
\[!\[Node.js\](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)\](https://nodejs.org)
\[!\[TypeScript\](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)\](https://www.typescriptlang.org)
\[!\[License\](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)\](LICENSE)

⭐ If you like this project, star it on GitHub!

\[Features\](#features) • \[Installation\](#installation) • \[Usage\](#usage) • \[Agents\](#agents) • \[Architecture\](#architecture)

</div>

## Features

- **Three delegation modes** — delegate tasks in `single`, `parallel`, or `chain` mode
- **Three-scope agent discovery** — find agents from bundled, user, and project scopes
- **Streaming updates** — live progress feedback as agents work
- **Abort support** — cancel running agents with `AbortController`
- **Dependency injection** — fully testable with injectable `spawn`, `execPath`, etc.
- **Usage tracking** — tracks tokens, cost, and context usage per agent invocation

## Installation

Add minion as a pi extension:

```bash
# Copy the extension directory into your pi extensions folder
cp -r minion ~/.pi/extensions/minion
```

Or install the published package:

```bash
npm install -g @aprimediet/minion
```

## Usage

### Delegation Tool

Delegate tasks to sub-agents using the `delegation` tool. Supports three modes:

**Single mode** — run one agent with a task:

```json
{
  "agent": "worker",
  "task": "Implement the login feature"
}
```

**Parallel mode** — run multiple agents concurrently:

```json
{
  "tasks": [
    { "agent": "worker", "task": "Write the login API" },
    { "agent": "worker", "task": "Write the login UI" }
  ]
}
```

**Chain mode** — run agents sequentially, passing output between steps:

```json
{
  "chain": [
    { "agent": "scout", "task": "Scan the codebase" },
    { "agent": "worker", "task": "Implement changes based on {previous}" }
  ]
}
```

### Minion List Tool

List all discoverable sub-agents:

```json
{
  "agentScope": "all"
}
```

### Agent Scopes

| Scope     | Description                                            |
| --------- | ------------------------------------------------------ |
| `bundled` | Built-in agents shipped with minion                     |
| `user`    | Agent definitions in `~/.pi/agents/`                   |
| `project` | Agent definitions in `~/.pi/agents/` relative to cwd   |
| `all`     | All scopes combined (default)                          |

## Agents

Minion ships four built-in agents:

### Explorer

Research external/web context and summarize sources for handoff.

- **Tools:** `read`, `grep`, `find`, `ls`, `bash`, `web_fetch`, `web_extract`, `web_crawl`
- **Model:** `lmstudio/ornith-1.0-9b`

### Scout

Fast codebase scan to produce a compressed context handoff.

- **Tools:** `read`, `grep`, `find`, `ls`, `bash`
- **Model:** `openai-codex/gpt-5.4-mini`

### Worker

General-purpose implementer that outputs code changes and handoff notes.

- **Tools:** `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`
- **Model:** `ollama-cloud/minimax-m3`

### Reviewer

Read-only code review with critical issues, warnings, and suggestions.

- **Tools:** `read`, `grep`, `find`, `ls`, `bash`
- **Model:** `opencode/big-pickle`

## Architecture

### Core Modules

- **`index.ts`** — Extension entry point. Registers `delegation` and `minion_list` tools with pi.
- **`agents.ts`** — Agent discovery across bundled, user, and project scopes. Parses frontmatter `.md` files to extract agent configs (name, description, tools, model, system prompt).
- **`runner.ts`** — Pure helper functions for agent execution. Includes `runSingleAgent`, `runMode`, concurrency utilities, event reduction, and pi invocation resolution.
- **`render.ts`** — TUI rendering helpers for tool call and result display.

### Design Principles

- **Pure helpers** — All core logic is pure and testable with dependency injection
- **Streaming updates** — Agent output is streamed via `onUpdate` callbacks in pi's tool-result shape
- **Abort safety** — `runSingleAgent` checks `signal.aborted` early to avoid hanging promises
- **Graceful errors** — All fs/parse errors in agent discovery are caught; unknown agents return empty results with exit code 1

### Dependency Injection

- `runSingleAgent` accepts injectable `spawn` (defaults to `child_process.spawn`)
- `discoverAgents` accepts optional `bundledDir`/`userDir` overrides
- `runMode` accepts injectable `runSingle` callback
- `getPiInvocation` accepts injectable `execPath`/`argv1`/`existsSync`

## Development

### Prerequisites

- Node.js >= 20
- TypeScript >= 5.9
- Vitest >= 1.6

### Run Tests

```bash
npm test
```

### Build

```bash
npm run build
```

### Scripts

| Script        | Description              |
| ------------- | ------------------------ |
| `npm test`    | Run vitest test suite    |
| `npm test:watch` | Run vitest in watch mode |

## Resources

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [Minion GitHub](https://github.com/aprimediet/pi-minion)
- [Minion Issues](https://github.com/aprimediet/pi-minion/issues)
