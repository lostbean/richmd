# A theme-aware categorical palette applies to every vega-lite spec, not just chart

<a id="adr-0007"></a>

`chart` blocks render every bar/slice in a single color, with no way to
distinguish categories visually (e.g. income vs. cost). Fixing this means
picking colors for a nominal channel — but richmd's theme only exposes two
accent colors, and using Vega-Lite's own built-in categorical scheme would
hardcode colors disconnected from a consumer's theme, violating [style is
swappable](../design/design.md#p3) (`--richmd-*` variables are the only
visual-identity contract; nothing else may hardcode color). We considered
scoping the fix to `chart.lua` alone — a local palette constant only `chart`
reads — but rejected it: `vega-lite.lua`'s shared base config
(`vega_lite_base_config_js`) is already the single place every Vega-Lite
spec's theme colors are injected (axis, legend, view), chart-derived or
hand-authored, and a chart-only palette would leave hand-authored
`vega-lite` blocks using a nominal channel with the exact same
theme-disconnected-color problem chart itself started with. We chose to
extend the shared base config instead: `--richmd-color-cat-3` through
`--richmd-color-cat-6` join the existing accent/accent2 tokens as a 6-color
categorical range (`richmdDiagramTheme()`'s new `categorical` field), read
live from `--richmd-*` custom properties exactly like every other diagram
color, and injected as the _default_ `scale.range` for a categorical color
channel — an author's own explicit `scale.range` in a hand-authored spec
still wins, via the same `richmdMergeConfig` "author wins" merge every other
base-config value already goes through. This is a real trade-off: chart
authors get automatic color-by-category, but so does every hand-authored
`vega-lite` block the moment it uses a nominal color channel with no range
of its own — richmd cannot tell those two authoring paths apart at the
config layer, since both produce the identical spec shape by the time
`vega-lite.lua`'s render function runs.
