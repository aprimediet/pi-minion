---
description: general-purpose implements, code-reviewer reviews, general-purpose applies the feedback
---
Use the `subagent` tool with the `chain` parameter for: $@

1. First, use the "general-purpose" agent to implement: $@
2. Then, use the "code-reviewer" agent to review the implementation from the previous step (use the {previous} placeholder).
3. Finally, use the "general-purpose" agent to apply the feedback from the review (use the {previous} placeholder).

Execute this as a chain, passing output between steps via {previous}.
