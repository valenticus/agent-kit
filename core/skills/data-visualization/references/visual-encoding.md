# Visual encoding

## Encoding priority

Use the most accurately read channels for the main comparison:

- shared-position judgments are usually strongest;
- aligned length supports precise magnitude comparison;
- line position supports ordered change when intervals and continuity are honest;
- angle and area are harder to compare and should carry coarse, limited distinctions;
- size must represent an area or volume rule explicitly and consistently;
- color is best for semantic role, grouping, status, or ordered intensity—not unsupported precision;
- shape can reinforce categories or state but should not carry dense distinctions alone;
- ordering and grouping are encodings: choose them analytically, not alphabetically by accident.

Every visible difference should have a meaning. Remove accidental mappings introduced by library defaults.

## Required encoding contract

Specify field-to-channel mappings, scale and visible domain, ordering/grouping, references, comparison basis, missing-value behavior, and uncertainty behavior. Include units, transformations, aggregation, filtering, and normalization when they affect interpretation.

## Scale and geometry

- Bars encode magnitude by length and normally require a visible zero baseline. Do not truncate them to amplify small differences.
- Position-only forms may use a non-zero domain when it improves resolution, provided the domain and context remain legible.
- Use a log scale only for positive values spanning meaningful orders of magnitude; label it clearly and ensure the question suits multiplicative comparison.
- Do not reverse axes or apply nonlinear transforms without an analytical reason made visible to the reader.
- Preserve irregular time spacing. If observations are categorical snapshots rather than continuous time, encode them as such.
- Choose bins from the distribution and question; disclose boundaries and avoid bins that manufacture a pattern.
- Treat dual axes as high risk. Prefer normalization, indexed change, small multiples, or aligned panels; if retained, prevent arbitrary scale choices from creating apparent agreement.

## Comparison integrity

- Make the denominator explicit for rates, shares, per-capita values, and normalized indices.
- Keep raw and aggregated values distinct. State the aggregation function and grain where material.
- Distinguish cumulative values from period values and reveal cumulative resets.
- Compare like periods and populations. For partial periods, align elapsed days or clearly qualify the mismatch.
- Separate zero, missing, not applicable, suppressed, and not yet observed states.
- Show negative values across an honest zero reference and preserve sign in labels.
- If uncertainty can change the conclusion, encode intervals, ranges, samples, or a clear qualification rather than a falsely precise mark.
- Correlation or temporal co-movement does not establish causation; use language that matches the evidence.

Use reference lines or bands for justified targets, normal ranges, thresholds, events, or comparison baselines. Identify whose target or rule it is and its applicable period. Prefer direct labels when they reduce lookup and remain readable; use a legend when direct labeling would create clutter or ambiguity.
