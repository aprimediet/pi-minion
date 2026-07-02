# AGENTS.md

## Project Overview

**@aprimediet/minion** is a subagent delegation extension for the [pi coding agent](https://github.com/earendil-works/pi). It lets the LLM discover, list, and delegate tasks to specialized sub-agents (explorer, scout, worker, reviewer) via two pi tools: `delegation` and `minion_list`.

**Stack:** TypeScript (ES2022, ESM), pi-coding-agent peer dependency, vitest for testing, no build step (runs directly as a pi extension).

**Version:** 2.3.1

**Architecture:** 4 source files + 4 bundled agent definitions:
- `index.ts` — Extension entry point, registers 2 tools with pi
- `agents.ts` — Agent discovery across bundled/user/project scopes, parses frontmatter `.md` files
- `runner.ts` — Pure helpers: `runSingleAgent`, `runMode`, concurrency, event reduction, pi invocation
- `render.ts` — TUI rendering helpers for tool call/result display
- `agents/*.md` — 4 bundled agents (explorer, scout, worker, reviewer)

## Setup Commands

- No install needed (pi extension, no `node_modules` build artifacts)
- Run tests: `npm test`
- Run tests in watch mode: `npm run test:watch`

## Development Workflow

- No build step — source files are the extension. Pi loads `index.ts` directly.
- Type-check: `tsc --noEmit` (tsconfig has `noEmit: true`)
- Hot-reload: Not applicable (pi extension, no dev server)
- Package manager: npm (default). `node_modules` is a symlink; do not edit it.

## Testing Instructions

- **Run all tests:** `npm test`
- **Watch mode:** `npm run test:watch`
- **Test file locations:** 6 test files, all `*.test.ts` at root:
  - `agents.test.ts` — agent discovery, frontmatter parsing, scope loading
  - `index.test.ts` — tool registration, delegation dispatch, project agent confirmation
  - `runner.test.ts` — pure helpers (buildAgentArgs, reduceEvent, mapWithConcurrencyLimit, etc.)
  - `run-single.test.ts` — `runSingleAgent` with fake spawn injection
  - `mode-drivers.test.ts` — single/parallel/chain mode dispatch
  - `render.test.ts` — TUI rendering helpers
- **Coverage:** No coverage requirement; tests are self-contained with temp directories
- **Test timeout:** 15 seconds per test
- **Environment:** vitest globals, node environment
- **Key testing patterns:**
  - `runSingleAgent` accepts injectable `deps.spawn` (mock `child_process.spawn`)
  - `discoverAgents` accepts optional `bundledDir`/`userDir` overrides
  - `runMode` accepts injectable `runSingle` callback
  - `getPiInvocation` accepts injectable `execPath`/`argv1`/`existsSync`
  - fs/parse errors in agent discovery are caught gracefully (never throw)
  - AbortController tests must check `signal.aborted` immediately before awaiting the spawn promise

## Code Style

- **Language:** TypeScript, strict mode (`strict: true`, `noImplicitAny: true`, `noImplicitReturns: true`, `noFallthroughCasesInSwitch: true`)
- **Module system:** ESM (`type: "module"` in package.json, `module: "ESNext"`)
- **Module resolution:** Bundler mode
- **Target:** ES2022
- **Linting:** No ESLint configured (no lint script in package.json)
- **Formatting:** No formatter configured (no prettier script)
- **File organization:** One source file per concern (`index.ts`, `agents.ts`, `runner.ts`, `render.ts`), bundled agents as `.md` files under `agents/`
- **Naming conventions:**
  - Functions: camelCase (`runSingleAgent`, `discoverAgents`, `formatAgentList`)
  - Types/Interfaces: PascalCase (`AgentConfig`, `SingleResult`, `ModeParams`)
  - Constants: UPPER_SNAKE_CASE (`MAX_PARALLEL_TASKS`, `PER_TASK_OUTPUT_CAP`)
  - Exports: named exports for helpers, default export for extension entry point
- **Import/export patterns:** Named imports from sibling modules (e.g. `import { discoverAgents } from "./agents.ts"`). Default export for `index.ts` (extension entry point).

## Build and Deployment

- **Build:** None. This is a pi extension — source files are the deliverable.
- **Output:** None (no `dist/` directory generated)
- **Deployment:**
  - Development: Copy extension directory into `~/.pi/extensions/minion`
  - Published package: `@aprimediet/minion` on npm (org owner `aditya.prima`)
  - CI/CD: None configured (no `.github/workflows`)
- **npm publish:** Use `NPM_TOKEN` env var. Do NOT add `always-auth=true` (deprecated).

## Pull Request Guidelines

- Title format: `[minion] <Brief description>`
- Run `npm test` before committing
- Run `tsc --noEmit` to verify no type errors
- Add or update tests for new code (TDD pattern)
- The closest `AGENTS.md` takes precedence in monorepo contexts

## Additional Notes

### Critical Gotchas

- **AbortController in `runSingleAgent`:** Must check `signal.aborted` immediately before awaiting the child process promise. Without the early check, if abort fires before spawn completes, the promise hangs forever because the `close` event never fires after abort. Pattern: `if (signal.aborted) { proc.kill(); reject(...); return; }` at top of await block.
- **pi tool-result shape:** Streaming updates from `runSingleAgent` must be wrapped into `{ content: [{type, text}], details, isError }` before passing to `onUpdate`. Raw `SingleResult` has no `.content` field and will crash `ToolExecutionComponent.getTextOutput()` with `undefined.filter`.
- **fs namespace in ESM:** `fs.existsSync`, `fs.mkdirSync` etc. are non-configurable in ESM context. `vi.spyOn(fs, ...)` cannot override them. Mock at a higher level or use dependency injection.
- **Git gotcha:** `git add -A` tracks a top-level `node_modules` symlink even when `node_modules/` is in `.gitignore`. The `.gitignore` pattern matches directory contents but not the symlink file itself (mode 120000). Must manually `git reset HEAD node_modules` after staging to unstage it.
- **npm publish identity:** Username `aprimediet` and account `aditya.prima` are different npm identities. `aditya.prima` is the org owner. Use the token that matches the org owner when publishing scoped packages.

### Boundaries

- **Do NOT modify:** `.pi/` directory contents (managed by pi)
- **Do NOT modify:** `node_modules/` (symlink, auto-managed)
- **Do modify:** All `.ts` source files, `*.test.ts`, `agents/*.md`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`

### Version Bumping

- NEVER bump `version` field in `package.json` on your own initiative.
- Flag version bumps as follow-ups in the summary instead of editing them.

### Key Design Decisions

- **Pure helpers:** All core logic is pure and testable with dependency injection
- **Three-scope discovery:** bundled → user → project, later scopes override earlier ones
- **Frontmatter parsing:** Uses pi-coding-agent's `parseFrontmatter` for agent `.md` files
- **Concurrency limits:** `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`
- **Output cap:** `PER_TASK_OUTPUT_CAP=51200` bytes for model-visible output
- **Model override:** Agent config `model` field overrides per-invocation model; falls back to current model if unset
