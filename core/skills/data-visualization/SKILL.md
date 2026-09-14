---
name: data-visualization
description: Design, compare, correct, or validate data visualizations when chart choice, analytical encoding, truthfulness, chart-specific interaction, or responsive chart behavior is the essential problem. Do not use when the chart decision is settled and the task is mainly product UI styling or integration.
---

# Data visualization

Turn a reader question and verified data into a concise visualization contract before implementation. Remain implementation-neutral: the project chooses libraries, rendering technology, brand palette, typography, spacing, and component styling.

Use this as the primary skill when choosing or correcting a chart, comparing analytical alternatives, defining chart behavior, or auditing visualization truthfulness. Do not automatically add `ui`; use it as a companion only when a separate material implementation boundary remains. Data/security skills retain ownership of access, authorization, persistence, and backend data boundaries.

## Decision path

1. Profile fields, types, units, denominators, grain, ordering, nulls, zero, signs, aggregation, category/series count, uncertainty, references, and partial periods.
2. State the reader's task as a verb-led question and the one-sentence answer the available data can support.
3. Classify the analytical relationship, then choose a visualization family—or deliberately choose text, KPI, table, or ranked list.
4. Define the encoding, scale, comparison, missingness, and uncertainty contract.
5. Define semantic hierarchy, composition, annotation, and the first-frame reading path.
6. Add interaction only for a real analytical task; define an intentional narrow-screen transformation.
7. Validate truthfulness, usability, accessibility, density, and project-style dependencies.

Never invent data, imply unsupported precision, hide consequential qualifications, or infer causation from association.

## Load references progressively

- For reader-question framing and chart-family choice, read [references/chart-selection.md](references/chart-selection.md).
- For channels, scales, baselines, aggregation, uncertainty, and data truth, read [references/visual-encoding.md](references/visual-encoding.md).
- For hierarchy, polish, line/bar/KPI craft, axes, typography roles, and annotations, read [references/visual-composition.md](references/visual-composition.md).
- For analytical interaction, touch, keyboard selection, and mobile transformation, read [references/responsive-interaction.md](references/responsive-interaction.md).
- For semantic alternatives, contrast, motion, localization, and assistive access, read [references/accessibility.md](references/accessibility.md).
- For final QA or misleading-pattern review, read [references/validation-and-anti-patterns.md](references/validation-and-anti-patterns.md).

Load only the references required by the task.

## Concise output contract

Return this decision record before implementation when the task benefits from an explicit contract:

```text
Reader question:
One-sentence takeaway:
Primary evidence:
Secondary/context evidence:
Reference/uncertainty:
Encoding and scale:
Hierarchy:
Plot/container composition:
Labels/typography roles:
Annotations:
Interaction/selection:
Mobile transformation:
Accessibility/text equivalent:
Project-style dependencies:
```

Keep it short enough to guide implementation rather than becoming a parallel design specification.
