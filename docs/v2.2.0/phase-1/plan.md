# minion v2.2.0 — Phase 1: `/init` Prompt & Template Design

> **Status:** Design phase. Builds on v2.0 (subagent delegation), v2.1 (primary agents), v2.1.1 (model persistence fixes).
> **Target:** Phase 1 — `/init` pi prompt that generates `AGENTS.md` + `PRD.md`.
> **Approach:** Zero code. A pi workflow prompt (`.md` in `prompts/`) instructs the LLM to generate both files. Templates are embedded in the prompt text — no template files, no `init.ts`, no `index.ts` changes.

> **⚠️ Design superseded — see [`prompts/init/`](./prompts/init/) for the interactive version.**
> The plan below describes **Phase 1a** (static template-dump). The current shipped design is
> **Phase 1b** (interactive 8-question interview modeled on the brainstorming skill):
> - Design spec: [`./prompts/init/prompt.md`](./prompts/init/prompt.md)
> - Template reference: [`./prompts/init/templates.md`](./prompts/init/templates.md)
> - Runtime prompt: [`../../prompts/init.md`](../../prompts/init.md)
>
> The static approach in §2.2 below is kept for historical context only — do not implement.

## 1. Motivation

Every project starts with a blank directory. The coding agent needs two things to work effectively:

1. **Conventions** (`AGENTS.md`) — how this project is structured, what stack it uses, what rules the agent must follow. Without these, the agent guesses, and guesses are wrong half the time.
2. **Business context** (`PRD.md`) — what this project is for, who it serves, where it's going. Without this, the agent makes architectural decisions in a vacuum.

Users can write these by hand, but they rarely do. A `/init` **workflow prompt** (same pattern as `/implement`, `/scout-and-plan`) tells the LLM to generate both files **on demand** — zero code, zero bloat, zero maintenance.

### Why a prompt, not a command?

- **Zero code.** No `init.ts`, no command handler, no tests. Just a markdown file.
- **LLM does the work.** The prompt instructs the LLM what to generate; the LLM uses its `write` tool to create the files. Templates are embedded in the prompt text.
- **No template files to maintain.** The templates live INSIDE the prompt text. One source of truth.
- **User edits immediately.** The LLM generates the files, user opens them and fills in the blanks. No template-copy → user-edits → save round trip.
- **Consistent with existing pattern.** `/implement`, `/scout-and-plan` are all workflow prompts that tell the LLM to orchestrate subagents. `/init` tells the LLM to scaffold files.

## 2. Design: The `/init` Prompt

### 2.1 Prompt file

```
prompts/
├── implement.md
├── scout-and-plan.md
├── implement-and-review.md
└── init.md              ← NEW
```

### 2.2 Prompt content (draft)

```markdown
---
description: Bootstrap a new project with AGENTS.md (coding conventions) and PRD.md (business overview)
---

Run this workflow in an empty or new project to generate scaffolding files that guide the agent in subsequent sessions.

## Instructions

1. **Check project root** (`ls`) — if `AGENTS.md` and `PRD.md` both already exist, notify the user and stop. This is a one-time bootstrap.
2. **Generate `AGENTS.md`** with this exact structure (keep it lean — under 30 lines, under 200 tokens):

```markdown
# Project Conventions

## Stack
- **Runtime:** [Node 20 / TypeScript 5.x]
- **Framework:** [Express / React / ...]
- **Testing:** [vitest / jest]
- **Linting:** [biome / eslint + prettier]
- **Package Manager:** [npm / pnpm]

## Rules
1. **Read before edit** — understand current state before modifying
2. **Type everything** — no `any`, no untyped params
3. **Test business logic** — unit test core, integration at boundaries
4. **Small PRs** — one concern per change
5. **Ask if ambiguous** — don't guess intent, name what's unclear

## Directory Layout
```
src/                    # source code
tests/                  # tests mirror src/
docs/                   # ADRs, design docs
```

## Commit Convention
- `<type>(<scope>): <description>`  (e.g. `feat(api): add rate limit`)
```

3. **Generate `PRD.md`** with this structure (longer, reference doc — NOT auto-loaded into context):

```markdown
# PRD — [Project Name]

> _One sentence: what problem does this solve and for whom?_

## Users
| Role | Need |
|------|------|
| [primary user] | [what they do with it] |

## Goals (first milestone)
1. [Goal 1] — [measurable outcome]
2. [Goal 2] — [measurable outcome]

## Architecture Direction
- **Style:** [monolith / modular monolith / services]
- **Data:** [Postgres / SQLite / ...]
- **Deploy:** [Vercel / Docker / ...]

## Out of Scope (for now)
- [Thing 1]
- [Thing 2]
```

## Rules
- Replace `[bracketed placeholders]` with project-specific values IF the user has specified them in the conversation. Otherwise leave brackets for the user to fill in.
- Keep AGENTS.md lean — no prose paragraphs, no philosophy. Just actionable rules.
- Do NOT overwrite existing AGENTS.md or PRD.md.
- After writing both files, summarize what was created and what the user still needs to fill in.
```

### 2.3 Why this structure?

- **Frontmatter `description`** — pi uses this for prompt discovery (`/list-prompts` or model-tool selection).
- **"Check project root" first** — prevents accidental overwrite. Same idempotent pattern as `install-agents`.
- **Full template inline** — the LLM reads both templates and writes them verbatim (with placeholder substitution). No template files to load, no directory structure to maintain.
- **"Keep it lean" instruction** — explicit guard against the LLM adding its own verbose paragraphs.
- **Placeholder brackets** — `[like this]` is visually obvious. User fills them in after generation.

## 3. Template Design (the Suggestion)

These are the **canonical templates** embedded in the prompt. They're designed to be lean, scannable, and actionable.

### 3.1 `AGENTS.md` — Project Conventions

**Target: ≤ 30 lines, ~180 tokens.** Auto-loaded into context (either by agent discovery or future auto-inject).

| Section | Lines | Purpose |
|---------|-------|---------|
| **Stack** | 5 | Runtime + framework + test runner + linter + PM |
| **Rules** | 6 | Behavioral constraints — read-before-edit, type everything, test business logic, small PRs, ask if ambiguous |
| **Directory Layout** | 5 | src/ + tests/ + docs/ structure |
| **Commit Convention** | 3 | Conventional commits format |

**Why these sections and no more:**
- **Stack** — single highest-impact context. Agent needs runtime, framework, test runner to call correct tools.
- **Rules** — each is a direct instruction, not general advice. 6 items is scannable (3–4 seconds to process).
- **Directory Layout** — prevents agent from reading `node_modules` or dumping files in wrong places.
- **Commit Convention** — marginal cost (~3 lines), high impact if agent generates commits.
- **NOT included:** code style details (prettier config handles that), naming conventions (too verbose, low impact), architectural patterns (belongs in ADRs).

### 3.2 `PRD.md` — Product Requirements

**Target: ≤ 40 lines.** Reference document — NOT auto-loaded into system prompt. Agent reads it via `read` tool when it needs business context.

| Section | Lines | Purpose |
|---------|-------|---------|
| **Vision** | 1 | One-sentence problem statement |
| **Users** | 4 | Role + need table |
| **Goals** | 3 | Measurable milestone outcomes |
| **Architecture Direction** | 4 | Style, data, deploy, key libs |
| **Out of Scope** | 2 | What we're NOT building (yet) |

**Why no auto-load?**
- PRD content varies wildly (5 lines or 500). Auto-loading a long PRD wastes context.
- Business context is only needed for architectural decisions, not every turn.
- Agent discovers PRD.md by listing root and reads it when relevant. Zero standing token cost.

## 4. Deliverables

**One file: `prompts/init.md`**

That's it. No `init.ts`, no `templates/` dir, no `index.ts` changes, no `package.json` changes.

The prompt is registered automatically via `package.json` `pi.prompts` (which already points to `./prompts`). Adding `init.md` to the prompts directory makes it instantly available as `/init`.

## 5. Work Plan

### WP0 — Write `prompts/init.md`

Create the prompt file with:
- YAML frontmatter (`description`)
- Instructions to check project root, skip if files exist
- Full inline templates for AGENTS.md and PRD.md
- Rules: keep lean, replace known placeholders, don't overwrite, summarize after

No tests needed. Existing `bundled.test.ts` validates that all prompt files parse (extend if needed, but prompts are free-form markdown — frontmatter parse is enough).

### WP1 — (Optional) Bundle validation

If desired, add a check in `bundled.test.ts` (or a new lightweight test) that:
- `prompts/init.md` exists
- Frontmatter has `description`
- Body contains both `AGENTS.md` and `PRD.md` strings (smoke check)

### WP2 — Documentation

- README: add `/init` to the prompt list in the "Workflow Prompts" section.

## 6. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **LLM generates bloated AGENTS.md** | Context token waste | Prompt explicitly says "keep it lean — under 30 lines, under 200 tokens" |
| **LLM overwrites existing files** | Data loss | Prompt says "check project root first — skip if files exist" |
| **LLM ignores template structure** | Inconsistent output | Template is inline and explicit. If LLM deviates, user can regenerate or fix manually |
| **Placeholder brackets not replaced** | User must fill in | Intentional — user should customize. Prompt says "replace [brackets] if user specified values" |
| **Prompt grows stale** | Outdated conventions | Prompt is one file, trivial to update. No code changes needed |

## 7. Comparison: Prompt vs Command

| Aspect | `/init` prompt | `/minion init` command (rejected) |
|--------|---------------|-----------------------------------|
| **Code** | Zero — one `.md` file | `init.ts` + `templates/` dir + index.ts changes + tests |
| **Maintenance** | Edit one `.md` file | Update templates + init.ts + tests |
| **Flexibility** | LLM adapts to user's stack context | Static template copy |
| **Token cost** | Only when invoked | Zero (but templates are static) |
| **Consistency** | LLM may deviate slightly | Exact template copy |
| **Idempotent** | Prompt instructs to skip if exists | Built into code |

The prompt approach wins on **simplicity and zero maintenance cost.** The trade-off: the LLM might not generate the template 100% verbatim. Acceptable for Phase 1 — the user gets something usable immediately and can tweak.

## 8. Files Changed (Summary)

| File | Action | Why |
|------|--------|-----|
| `prompts/init.md` | **NEW** | The `/init` workflow prompt |
| `README.md` | **MODIFY** | Document `/init` in workflow prompts |
| `docs/v2.2.0/phase-1/plan.md` | **NEW** | This plan |

No changes to: `index.ts`, `init.ts`, `package.json`, `agents.ts`, `config.ts`, `primaries.ts`, any test files.

## 9. Definition of Done

- [ ] `prompts/init.md` exists with valid YAML frontmatter and inline templates
- [ ] Prompt instructs: check root, skip if exists, generate AGENTS.md (lean), generate PRD.md (reference)
- [ ] AGENTS.md template ≤ 30 lines, ≤ 200 tokens
- [ ] PRD.md template ≤ 40 lines
- [ ] README lists `/init` under workflow prompts
- [ ] No code changes — prompt-only
