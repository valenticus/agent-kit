# Validation and anti-patterns

## Completion checklist

- Is the reader question explicit and answerable from the available data?
- Are grain, units, denominator, time range, freshness, aggregation, and filters clear?
- Does every visual channel have semantic meaning?
- Is geometry truthful, with defensible baseline, domain, transform, and bins?
- Is ordering intentional?
- Is the principal comparison visible without interaction?
- Is there one primary reading path, with comparison and context subordinate but readable?
- Are labels, source, freshness, and qualifications legible?
- Is color reinforced by another cue?
- Are zero, missing, negative, suppressed, and partial-period states distinguishable where applicable?
- Is uncertainty visible when it could change the conclusion?
- Is the static frame useful?
- Does mobile use an intentional transformation at phone width?
- Are keyboard, touch, focus, and selection behavior defined?
- Is there an accessible text or structured-data equivalent?
- Are reduced motion, supported themes, localization, and RTL considered where relevant?
- Were library defaults accepted only after intentional review?
- Are rendering cost, mark count, label density, and interaction latency reasonable?

## Reject or correct

- truncated bar baselines or domains chosen to dramatize differences;
- arbitrary reversed or nonlinear scales;
- unequal time intervals rendered as equally spaced continuous observations;
- arbitrary bins that create or hide a pattern;
- decorative 3D perspective or volume distortion;
- dual axes whose domains manufacture visual agreement;
- excessive chart chrome;
- equal emphasis on all series when the question has a clear primary comparison;
- rainbow mappings without analytical reason and accessible separation;
- pie or donut forms for many slices, close comparisons, negatives, changing totals, or exact lookup;
- critical values or qualifications available only on hover;
- red/green-only status distinctions;
- animation without explanatory or state-transition value;
- clipped, overlapping, cryptic, or excessively rotated labels;
- desktop composition merely reduced to mobile width;
- causal claims from correlation or co-movement;
- totals without the denominator, population, period, or comparison context needed to interpret them;
- cumulative series with hidden resets or changing definitions;
- funnel or stage comparisons built from different cohorts or observation windows;
- financial or time-series conclusions that ignore relevant splits, sessions, currency, timezone, market closure, or missing observations.

## Final review method

1. `Truth`: recompute or spot-check values, transformations, denominators, domains, and comparison periods.
2. `Perception`: confirm the strongest channel and emphasis correspond to the intended conclusion.
3. `Use`: inspect first frame, interaction equivalence, narrow-screen transformation, and extreme states.
4. `Communication`: verify takeaway, labels, annotations, source, uncertainty, and text equivalent make no claim stronger than the data.

Record unresolved ambiguity instead of polishing it out of sight.
