---
name: debugging
description: Diagnose and fix a reproducible defect or regression across UI, state, data flow, APIs, and persistence. Do not use for new features or generic cleanup.
---

# Debugging

1. Capture expected and observed behavior, reproduction, scope, and evidence separately from hypotheses.
2. Trace the value or event across the real boundaries and find the earliest broken invariant.
3. Inspect recent callers and schema/config changes before patching a downstream symptom.
4. Add the smallest regression test that exposes the root cause, then apply a focused fix without weakening validation or access controls.
5. Re-run reproduction, focused tests, project checks, and final diff review.
6. Report root cause, why the fix works, verification, and anything not reproduced.

Load project data/security hooks when persistence or authorization is involved, and `ui` when the user-visible contract changes.
