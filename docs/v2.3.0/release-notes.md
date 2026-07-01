# minion v2.3.0 — Pure Delegation Refactor

> **Status:** Shipped (commit `5112e66`, npm `@aprimediet/minion@2.3.0`).
> **Type:** **BREAKING** — major surface-area reduction. All v2.1–v2.2.0 features (primaries, config overrides, schema/modes, workflow prompts, planner/docs-writer agents) are removed.
> **Replaces:** v2.2.0 (`8893173`).
> **Reason:** v2.2.0 had grown into a kitchen-sink extension: primary-agent runtime + model switching + config override files + schema validator + 3 mode drivers + 4 workflow prompts + 6 bundled agents. In practice, users only ever used **subagent delegation** — everything else was dead weight that complicated maintenance, testing, and onboarding. v2.3.0 strips the surface area down to the core: **discover agents, delegate tasks, list what's available**.

## 1. What's in v2.3.0

### 1.1 Public surface (the whole API)

The extension registers **two pi tools** and **zero prompts**:

| Tool | Purpose |
|------|---------|
| `delegation` | Run a sub-agent in one of three modes: `single` (`agent`+`task`), `parallel` (`tasks[]`), or `chain` (`chain[]` with `{previous}` placeholder). |
| `minion_list` | Discover all available sub-agents across bundled, user, and project scopes. |

That's it. No `/init`, no `/implement`, no `/scout-and-plan`, no `/implement-and-review`. No `primaries.ts`, no `config.ts`, no `schema.ts`, no `modes.ts`. All of those are gone.

### 1.2 Bundled agents (4, down from 6)

| Agent | Tools | Purpose |
|-------|-------|---------|
| `scout` | read, grep, find, ls, bash | Fast codebase scan → compressed context handoff |
| `explorer` | read, grep, find, ls, bash, web | Research external/web context → source-cited summary |
| `worker` | read, grep, find, ls, bash, write, edit | General-purpose implementer → code changes + handoff |
| `reviewer` | read, grep, find, ls, bash | Read-only code review → critical / warning / suggestion |

Removed: `planner` (v2.1 primary), `docs-writer` (v2.2.0). Use `worker` for any "make it happen" task, and the model's native writing tools for documentation.

### 1.3 Three-scope agent discovery

`agents.ts` resolves agents from three locations, merged with project > user > bundled precedence:

1. **Bundled** — `agents/*.md` shipped inside the npm package (4 agents above).
2. **User** — `~/.pi/agent/agents/*.md` — installed once, available across all projects.
3. **Project** — `<repo>/agents/*.md` — repo-controlled, requires user confirmation by default (`confirmProjectAgents: true`).

Filter via the `agentScope` parameter (`bundled` | `user` | `project` | `all`, default `all`).

### 1.4 Delegation modes

**Single** — one agent, one task:
```ts
{ agent: "scout", task: "Map the auth subsystem" }
```

**Parallel** — N agents, concurrent execution, independent results:
```ts
{ tasks: [
  { agent: "scout", task: "Map auth" },
  { agent: "reviewer", task: "Audit recent commits" },
] }
```

**Chain** — N agents, sequential, `{previous}` is the prior step's output:
```ts
{ chain: [
  { agent: "scout", task: "Map the codebase" },
  { agent: "worker", task: "Implement {previous}" },
  { agent: "reviewer", task: "Review {previous}" },
] }
```

The tool enforces **exactly one mode** per call — supplying 0 or ≥2 modes returns a validation error with the available agent list.

### 1.5 Testability (3 DI patterns)

The whole extension is unit-tested with 82 passing tests, no real child processes, no real filesystem. The runner is fully testable via three dependency-injection seams:

1. `runSingleAgent` accepts `deps.spawn` (defaults to real `child_process.spawn`).
2. `discoverAgents` takes optional `bundledDir` / `userDir` overrides (resolves from `import.meta.url` in production).
3. `runMode` accepts a `runSingle` callback injection.

`getPiInvocation` also accepts injectable `execPath` / `argv1` / `existsSync` for `pi -e` resolution.

All filesystem and parse errors in agent discovery are caught gracefully — discovery **never throws**, so a malformed project agent file cannot break the extension.

### 1.6 Abort safety

`runSingleAgent` checks `signal.aborted` **immediately before** awaiting the child process promise. Without this early check, an abort that fires during `spawn` would leave the promise hanging forever (the `close` event never fires after kill). Pattern:

```ts
if (signal.aborted) { proc.kill(); reject(...); return; }
```

## 2. What's gone (breaking changes)

### 2.1 Primary agent system (v2.1)

The entire `primaries.ts` runtime is deleted:
- No more `/primary` switching
- No more `Primary: <name> | Model: <id>` persistent status bar
- No more `setModelFor` resolution chain
- No more `snapshot.model` restoration on switch
- No more `minion-primary-context` custom messages

Use the model's built-in session management instead.

### 2.2 Config overrides (v2.2.0)

The `.minion/config.json` override system is gone. To customize per-project:
- **Bundled agents** → not customizable (fork the package)
- **Project agents** → drop a `agents/*.md` in your repo
- **User agents** → drop a `~/.pi/agent/agents/*.md` in your home dir

### 2.3 Schema & modes modules (v2.1)

The `schema.ts` validator and `modes.ts` mode driver are folded into `runner.ts`. Validation now happens inline at the `delegation` tool boundary.

### 2.4 Workflow prompts

The `prompts/` directory is removed entirely:
- `prompts/init.md` (v2.2.0 interactive /init)
- `prompts/implement.md` (v2.1)
- `prompts/scout-and-plan.md` (v2.1)
- `prompts/implement-and-review.md` (v2.1)

If you want `/init` back, see §4.

### 2.5 Bundled agents removed

- `planner` — was a v2.1 primary, uses the model natively now.
- `docs-writer` — was a v2.2.0 add-on, use `worker` for doc generation.

## 3. Migration from v2.2.0

If you relied on any removed feature:

| v2.2.0 feature | v2.3.0 replacement |
|----------------|-------------------|
| `/init` (interactive AGENTS.md + PRD.md generator) | Manually write `AGENTS.md` + `PRD.md` (see §4 for restore path) |
| `/implement` (delegates to planner + worker) | Use `delegation` tool directly with `chain` mode |
| `/scout-and-plan` | `delegation` with `{ agent: "scout", task: "..." }` then model plans natively |
| `/implement-and-review` | `delegation` with `chain: [worker, reviewer]` |
| Primary switching | Session-level model selection in pi itself |
| `.minion/config.json` overrides | Project-scope `agents/*.md` files |
| `planner` agent | Use `worker` for any implementation, model plans natively |
| `docs-writer` agent | Use `worker` with a doc-focused task description |

**No code migration needed for users who only used the basic `subagent` tool** (v2.0) — `delegation` is its direct replacement with three modes instead of one.

## 4. Optional: restore /init

The `prompts/init.md` from v2.2.0 is preserved in git history (commit `739e122`). To restore it:

```bash
git show 739e122:prompts/init.md > prompts/init.md
```

Add to `package.json` `pi.extensions` if needed. Note: the v2.2.0 8-question interview + 4 approval gates pattern is documented in the v2.2.0 design doc (also recoverable from git history).

## 5. Stats

| Metric | v2.2.0 | v2.3.0 | Delta |
|--------|--------|--------|-------|
| Source files (in `files` array) | 30+ | 5 | **−83%** |
| Lines of code (incl. tests) | ~12,000 | ~2,800 | **−77%** |
| Public tools | 1 (subagent) | 2 (delegation, minion_list) | +1 |
| Bundled agents | 6 | 4 | −2 |
| Workflow prompts | 4 | 0 | −4 |
| Tests | ~50 | 82 | +32 |
| Test runtime | — | 1.46s | — |
| `tsc --noEmit` | clean | clean | — |
| Published tarball | — | 10.6 kB | — |

The test count went **up** because the new pure-helper architecture is much more testable — every code path has explicit unit coverage, no integration-heavy tests needed.

## 6. File structure

```
minion/
├── index.ts              # 2 tools: delegation, minion_list
├── agents.ts             # 3-scope discovery (bundled/user/project)
├── runner.ts             # pure helpers + runSingleAgent + runMode
├── render.ts             # TUI render helpers for tool calls/results
├── agents/               # 4 bundled agents
│   ├── explorer.md       # web research
│   ├── scout.md          # codebase scan
│   ├── worker.md         # implementation
│   └── reviewer.md       # read-only code review
├── *.test.ts             # 6 test files, 82 tests
├── package.json          # @aprimediet/minion, 2.3.0
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

No `primaries/`, no `prompts/`, no `templates/`, no `docs/` shipped (release notes live in git, not the tarball).

## 7. Verification

- `npm test` → 82/82 pass (1.46s)
- `npx tsc --noEmit` → exit 0
- `git push origin master` → `8893173..5112e66`
- `npm publish` → `+ @aprimediet/minion@2.3.0`
- `npm view @aprimediet/minion@2.3.0 version` → `2.3.0` (verified post-CDN-propagation)

## 8. Credits

Designed and implemented by Aditya Prima. Breaking-change refactor motivated by the realization that **delegation is the only feature that survived contact with real users**.
