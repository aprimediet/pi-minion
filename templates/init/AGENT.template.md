# AGENTS.md — Project Conventions

> Guide for coding agents working in this repository. Keep this file lean (≤ 30 lines).
> Edit values below as the project evolves; remove this comment block once filled in.

## Stack
- **Runtime:** {{runtime}}
- **Language:** {{language}}
- **Framework:** {{framework}}
- **Testing:** {{test_framework}}
- **Linting:** {{linter}}
- **Package Manager:** {{package_manager}}

## Rules
1. **Read before edit** — understand current state before modifying
2. **Type everything** — no `any`, no untyped params
3. **Test business logic** — unit test core, integration at boundaries
4. **Small PRs** — one concern per change
5. **Ask if ambiguous** — don't guess intent, name what's unclear

## Directory Layout
```
{{directory_layout}}
```

## Commit Convention
{{commit_convention}}

## Constraints
- {{constraint_1}}
- {{constraint_2}}

---

## Template Reference

This template is loaded by `/init` (see `prompts/init.md`). The interactive
interview fills the `{{placeholders}}`; any field the user skips falls back
to `[brackets for user to fill]`.

| Placeholder | Source question | Required? |
|-------------|-----------------|-----------|
| `{{runtime}}` | Q2 — stack | yes |
| `{{language}}` | Q2 — stack | yes |
| `{{framework}}` | Q2 — stack | optional |
| `{{test_framework}}` | Q2 — stack | yes |
| `{{linter}}` | Q2 — stack | yes |
| `{{package_manager}}` | Q2 — stack | yes |
| `{{directory_layout}}` | Q2 — stack | yes |
| `{{commit_convention}}` | Q2 — stack | yes |
| `{{constraint_n}}` | Q7 — out of scope (non-negotiables) | optional |
