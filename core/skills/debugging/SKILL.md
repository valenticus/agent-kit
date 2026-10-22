---
name: debugging
description: Find and fix the root cause of a reproducible defect or regression. Do not use for new features, routine implementation, or generic cleanup.
---

# Debugging

1. Capture expected and observed behavior, reproduction, scope, and evidence separately from hypotheses.
2. Trace the value or event across the real boundaries and find the earliest broken invariant.
3. Inspect recent callers and schema/config changes before patching a downstream symptom.
4. Add the smallest regression test that exposes the root cause, then apply a focused fix without weakening validation or access controls.
5. After fixing a confirmed defect, check whether the same failure pattern exists in other relevant locations. Reproduce suspected related defects with a focused test or execution before reporting them as confirmed. Report findings without modifying additional locations unless the user approves.
6. Re-run reproduction, focused tests, project checks, and final diff review.
7. Report root cause, why the fix works, verification, and anything not reproduced.

Load project data/security hooks when persistence or authorization is involved, and `ui` when the user-visible contract changes.
