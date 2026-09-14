# Accessibility

Treat accessibility as part of the visualization contract, not a post-render annotation.

- Give the visualization a discoverable title or identification and a textual takeaway.
- State units, time range, freshness/source, active filters, denominator, and important qualifications when relevant.
- Provide an accessible table or equivalent structured representation for complex charts and exact values. It may be adjacent, expandable, or otherwise discoverable.
- Keep DOM and focus order aligned with the intended reading and interaction sequence.

SVG is not automatically accessible: visible shapes still need names, grouping, relationships, and keyboard behavior or a suitable equivalent. Canvas needs a separate semantic/text representation because pixels alone expose no usable structure.

- Never use color as the sole carrier of category, trend, status, forecast, or selection. Reinforce it with position, line treatment, shape, pattern, text, or direct labels.
- Ensure required distinctions and text meet the project's applicable contrast requirements across supported themes.
- Make focused and selected states visible without erasing underlying data meaning.
- Ensure keyboard and touch users can obtain essential information available to pointer users.
- Avoid interactions that require fine motor precision or pointer-only gestures.
- Respect reduced-motion preferences. Motion should explain a state change, and the final state must remain understandable without animation.
- Format numbers, dates, units, currencies, signs, separators, and plural forms for the active locale.
- Test text expansion and long category names rather than truncating away identity.
- For right-to-left contexts, review reading order, label alignment, tooltip layout, and directional language. Do not reverse inherently chronological or numeric axes without a documented locale convention.
- Keep source and qualification text readable, not visually discarded as fine print.
