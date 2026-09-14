# Responsive interaction

## Static first

The first frame must state the takeaway, show the principal comparison, identify units and scope, and reveal important qualifications without hover or selection. Add interaction only when it helps inspect, compare, filter, navigate, or change analytical focus.

## Interaction contracts

- Hover may provide rapid inspection but cannot own essential information.
- Touch needs an explicit tap target and dismissal/change behavior; do not emulate mouse hover implicitly.
- Keyboard focus must reach the same meaningful marks or summary controls in a logical order.
- Nearest-point selection should identify the snapped series, time/category, value, and uncertainty rather than implying arbitrary cursor precision.
- Persistent selection is useful when the reader must compare distant points, read detail, or move between overview and detail.
- Shared x-position comparison is useful for aligned series with common domains; do not compare values that differ in period, unit, or denominator.
- A crosshair should improve alignment, not add visual noise or false precision.
- A tooltip should identify value, unit, series/category, time or scope, comparison/reference, and missing/estimated state as relevant.
- Scrubbing should preserve orientation and work with touch and keyboard equivalents.
- Zoom or range selection is justified for dense exploration, not as a remedy for a poorly framed default view. Provide a clear reset and current-range context.

Hover, touch, and keyboard must expose equivalent essential information. Define focus, selected, and unavailable states as semantic `INTERACTION STATE` roles for project UI to realize.

## Responsive transformation

Treat phone layout as a distinct composition. At iPhone-sized widths, consider transposing, faceting, carefully reducing labels, overview plus selected detail, summary plus drill-down, or replacement with a KPI/table/list. Horizontal scrolling can honestly preserve a dense ordered domain when it has a visible affordance and stable labels.

Do not shrink a desktop chart until text and touch targets fail. Preserve the main question and comparison even when the chart family changes.

Test the composition with real long labels, localized and expanded values, dense periods, extreme values, zero/negative/missing states, and an active selection or tooltip. Check occlusion, clipping, scroll conflicts, orientation, safe-area proximity, and whether the selected datum remains associated with its label.
