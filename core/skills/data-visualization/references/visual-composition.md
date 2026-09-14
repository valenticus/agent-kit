# Visual composition

## Semantic hierarchy

Assign every element one role:

- `PRIMARY`: evidence that answers the reader question;
- `SECONDARY`: comparison needed to interpret the primary evidence;
- `CONTEXT`: orientation, history, units, source, and qualification;
- `REFERENCE`: targets, baselines, thresholds, or expected ranges;
- `ANNOTATION`: deliberate explanation of a meaningful event or exception;
- `INTERACTION STATE`: focus, hover, selection, range, or disabled state.

The visualization owns this hierarchy and the contrast/separation it requires. Project UI owns exact colors, fonts, sizes, spacing tokens, radii, shadows, and component styling. Express semantic roles first, then map them to the project's design language.

## Composition contract

- Create one visual center of gravity aligned with the main conclusion.
- Allocate area by information importance; supporting furniture must not crowd out evidence.
- Use whitespace to group related evidence and separate changes of topic or scale.
- Align titles, plots, KPIs, labels, and notes to reinforce the reading sequence.
- Treat density as a budget. Add a series, label, gridline, panel, or annotation only when its analytical return exceeds its decoding cost.
- Purposeful asymmetry can give the main evidence more room or hold detail beside an overview; symmetry is not a default virtue.
- Compose chart and container together. Avoid decorative cards or headers that compete with the plot.
- When a KPI accompanies a chart, the KPI states the current/result value and the chart supplies evidence; avoid equal-emphasis duplication.

Aim for this scan path: takeaway -> primary evidence -> comparison/context -> qualification/source.

## Line-chart craft

- Give the primary series greater visual weight than comparison lines while keeping comparisons readable; do not render every series as equally important.
- Use solid/dashed treatment only with stated semantics, commonly observed versus forecast. Keep forecast boundaries explicit.
- Emphasize endpoints or the active point when they answer the task. Avoid markers on every observation unless discreteness or exact selection requires them.
- Render missing intervals as gaps unless interpolation is justified and disclosed. Never connect across missing observations by accident.
- Show uncertainty as a subordinate but readable range. Targets and acceptable ranges should remain references rather than competing series.
- Use area fill only when magnitude from a meaningful baseline matters; overlapping fills can obscure comparison.
- Avoid decorative smoothing. Interpolation must not imply unobserved extrema or timing.
- Keep grids sparse but retain enough axes, ticks, and baselines to read scale and time honestly. Choose meaningful ticks rather than accepting defaults blindly.
- Prefer direct endpoint/series labels when space permits. Annotate only events, exceptions, peaks/troughs, threshold crossings, target deviations, current state, or forecast boundaries that alter interpretation.
- Mark a partial current period and compare it with the equivalent elapsed portion of prior periods unless the intended full-period mismatch is explicit.

## Bar and ranking craft

- Balance bar width and gap so bars read as distinct magnitudes without becoming hairlines or a solid block.
- Prefer horizontal bars for long labels or many ranked categories; use vertical bars when the x sequence is compact and meaningful.
- Sort by the analytical question: magnitude for rank, chronology for time, workflow order for stages, or a justified stable order.
- Start the magnitude axis at zero. Show negative bars around a visible zero line.
- Use grouped bars for direct within-category comparison when series count is small. Use stacked bars for totals plus composition; use normalized stacks only for shares.
- Place direct values where legible and avoid false precision. Retain units and distinguish totals from percentages.
- Render a target as a reference marker or band and a comparison as a subordinate bar/mark.
- On mobile, transpose, reduce to the relevant subset, facet, or use a ranked list/table. Never preserve a desktop layout by merely shrinking labels and bars.

## KPI and micro-visualization

Build the semantic sequence `Metric -> Context -> Change -> Visual evidence`.

- Use KPI only when one current value and its context answer the question.
- Add a sparkline for direction and shape, not exact historical lookup. Do not imply inspectable precision without labels or interaction that actually provides it.
- Use compact comparison for a small number of explicit peers or periods.
- Use progress only when there is a meaningful bounded goal and direction.
- Use a status indicator for a defined state or threshold, with text and non-color cues.
- Escalate to a full chart when history, distribution, multiple comparisons, uncertainty, or inspection is essential.

## Typography, axes, grid, and annotation

Define semantic text roles: chart title, takeaway, KPI, axis label, tick, direct data label, annotation, tooltip value, tooltip context, and source/note. Map them to project typography; do not prescribe fonts or fixed pixel sizes.

Remove only redundant guides. Preserve enough ticks, grid, axis labels, and baseline cues to establish scale. Never conceal irregular intervals, log scaling, missingness, or a changed unit. Keep annotation count low, anchor annotations to evidence, and avoid covering data or forcing a zigzag reading path.
