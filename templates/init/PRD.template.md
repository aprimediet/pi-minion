# PRD — {{project_name}}

> **Vision:** {{vision_statement}}

## Users
| Role | Need |
|------|------|
| {{user_role_1}} | {{user_need_1}} |
| {{user_role_2}} | {{user_need_2}} |
| {{user_role_3}} | {{user_need_3}} |

## Goals (M1)
1. {{goal_1}} — measurable: {{goal_1_metric}}
2. {{goal_2}} — measurable: {{goal_2_metric}}
3. {{goal_3}} — measurable: {{goal_3_metric}}

## Non-Goals (M1)
- {{non_goal_1}}
- {{non_goal_2}}
- {{non_goal_3}}

## Architecture Direction
- **Style:** {{architecture_style}}
- **Data:** {{data_store}}
- **Deploy:** {{deployment_target}}
- **Key Libraries:** {{key_libraries}}

## Boundaries
- **In scope (M1):** {{in_scope_summary}}
- **Out of scope (M1):** {{out_of_scope_summary}}
- **Ownership:** {{ownership_model}}

## Roadmap
| Phase | Focus | Timeline |
|-------|-------|----------|
| M1 | {{m1_focus}} | {{m1_timeline}} |
| M2 | {{m2_focus}} | {{m2_timeline}} |
| M3 | {{m3_focus}} | {{m3_timeline}} |
| Future | {{future_focus}} | TBD |

---

## Template Reference

This template is loaded by `/init` (see `prompts/init.md`). The interactive
interview fills the `{{placeholders}}`; any field the user skips falls back
to `[brackets for user to fill]`.

| Placeholder | Source question | Required? |
|-------------|-----------------|-----------|
| `{{project_name}}` | Q1 | yes |
| `{{vision_statement}}` | Q3 | yes |
| `{{user_role_n}}` / `{{user_need_n}}` | Q4 | yes (≥1) |
| `{{goal_n}}` / `{{goal_n_metric}}` | Q5 | yes (2-3) |
| `{{non_goal_n}}` | Q7 | yes (≥1) |
| `{{architecture_style}}` | Q6 | yes |
| `{{data_store}}` | Q6 | yes |
| `{{deployment_target}}` | Q6 | yes |
| `{{key_libraries}}` | Q6 | optional |
| `{{in_scope_summary}}` | Q5 + Q7 | yes |
| `{{out_of_scope_summary}}` | Q7 | yes |
| `{{ownership_model}}` | Q4 | optional |
| `{{mN_focus}}` / `{{mN_timeline}}` | Q8 | yes (≥2) |
