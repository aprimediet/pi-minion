---
description: Explore gathers context, plan creates an implementation plan (no implementation)
---
Use the `subagent` tool with the `chain` parameter for: $@

1. First, use the "explore" agent to find all code relevant to: $@
2. Then, use the "plan" agent to create an implementation plan for "$@" using the context from the previous step (use the {previous} placeholder).

Execute this as a chain, passing output between steps via {previous}. Do NOT implement — just return the plan.
