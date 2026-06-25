---
description: Multi-perspective review of the current changes (code-reviewer + silent-failure-hunter + type-design-analyzer)
---
Use the `subagent` tool with the `tasks` parameter to review the current changes in parallel, focusing on: $@

Run these three agents concurrently, each on the current diff for "$@":
- "code-reviewer" — bugs, style, guideline violations
- "silent-failure-hunter" — swallowed errors / bad fallbacks
- "type-design-analyzer" — type-design weaknesses

Then synthesize their findings into one prioritized review (Critical → Warning → Suggestion), de-duplicating overlaps.
