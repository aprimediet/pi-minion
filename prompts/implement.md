---
description: Full implementation workflow — explore gathers context, plan designs, general-purpose implements
---
Use the `subagent` tool with the `chain` parameter to execute this workflow for: $@

1. First, use the "explore" agent to find all code relevant to: $@
2. Then, use the "plan" agent to create an implementation plan for "$@" using the context from the previous step (use the {previous} placeholder).
3. Finally, use the "general-purpose" agent to implement the plan from the previous step (use the {previous} placeholder).

Execute this as a single chain, passing output between steps via {previous}.
