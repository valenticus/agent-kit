---
name: safe-change
description: Implement a small scoped change with minimal diffs and focused verification. Do not use as the primary workflow for reproduced defects, UI work, security-sensitive work, or broad audits.
---

# Safe change

Read the root instructions and relevant project hooks. Inspect status and trace the smallest relevant implementation surface.

1. State the intended behavior and contracts that must remain stable.
2. Stop and surface conflicts with project rules or user-owned changes.
3. Make the smallest coherent patch without unrelated refactors, dependencies, generated churn, or widened interfaces.
4. Add the narrowest meaningful test when behavior changes.
5. Run focused checks, project-required checks, diff checks, and review scope.
6. Report behavior, checks, failures, and residual risk. Do not commit without permission.

Route defects to `debugging`, UI behavior to `ui`, and authority/data-integrity changes to `security`.
