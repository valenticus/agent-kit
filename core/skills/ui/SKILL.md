---
name: ui
description: Implement visual, responsive, accessibility, or interaction changes using the current project's design language. Do not use for backend-only work or standalone design critique.
---

# UI

Read the project-ui and project-product hooks and inspect nearby implementation before editing. The current project—not this kit or a previous project—defines its visual and product identity.

- Reuse established primitives, tokens, patterns, and content conventions when they fit.
- Start from the project's primary viewport strategy and preserve hierarchy across widths.
- Preserve labels, focus, error association, loading/disabled states, reduced motion, contrast, touch targets, and non-color cues.
- Keep domain calculations and data access in their established layers.
- Follow the project's localization and copy source of truth.
- Verify affected interactions, responsive states, themes, and project UI contracts.

Use `product-ux` when structure or behavior is unsettled and `debugging` for a reproduced state/data-flow defect.
