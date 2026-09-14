# Chart selection

## Start with the evidence

Inspect the data before naming a chart:

- fields, types, units, currency, and denominators;
- row grain, aggregation level, time grain, timezone, and ordering;
- null or absent values versus measured zero;
- negative values, outliers, and extreme ranges;
- category and series counts, stable identities, and grouping;
- uncertainty, targets, thresholds, and other reference values;
- current-period completeness and whether comparison periods are genuinely comparable.

Do not repair missing semantics by guessing. Surface ambiguities that could change the conclusion.

## Ask what the reader must do

Phrase the question with a task verb. Useful relationship classes include:

| Reader task | Relationship | Usually consider | Watch for |
|---|---|---|---|
| See change through ordered time | Change | line, step, area, small multiples | irregular intervals, partial periods, smoothing |
| Compare magnitudes | Compare | bars, dots, table | incompatible units or denominators |
| Find leaders and laggards | Rank | sorted bars or dots, ranked list | arbitrary order, ties, long labels |
| Understand composition | Part-to-whole | stacked bars, table; angle/area only for few clear parts | changing totals, too many parts |
| Inspect shape and spread | Distribution | histogram, dot/strip, box/interval forms | arbitrary bins, hidden sample size |
| Examine co-movement | Association | scatter, connected scatter when order matters | causal language, overplotting |
| Read current condition | Status | KPI, status text, compact indicator | missing comparison or freshness |
| Compare with a goal | Target gap | compact target comparison, variance bars, line plus target | target validity and directionality |
| Track a running total | Accumulation | cumulative line/area, waterfall when contributions matter | resets and double counting |
| Find intersections across two dimensions | Matrix | heatmap or table | color precision, sparse cells |
| Follow ordered events | Sequence | timeline, ordered states | unequal duration shown equally |
| Follow attrition or stages | Stage flow | stage table/bars, flow only when paths matter | incomparable cohorts |
| Inspect market or dense time behavior | Market/time series | line, interval, OHLC-style form when fields support it | splits, sessions, currency, timezone |
| Inspect connections | Relationship/network | node-link only when topology is the question; otherwise matrix/list | hairballs, implied importance |
| Locate geographic patterns | Spatial | map only when location is analytically material | area bias and normalization |

This is a decision aid, not a closed taxonomy. Choose the simplest form that makes the required comparison perceptually direct.

## No-chart decisions

Prefer text for one clear finding, a KPI for one current value with compact context, a table for exact lookup across several fields, or a ranked list for names, values, and actions. Use multiple coordinated views only when no single view can answer the real task. Reject a chart when geometry adds decoding cost without adding understanding.

## Selection test

Confirm that the selected form exposes the principal comparison in the static frame, matches the data grain, has room for real labels, does not depend on interaction for the answer, can transform honestly at phone width, and remains useful when uncertainty, missingness, and context are shown.
