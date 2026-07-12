# Chart block binds table columns to encoding positionally by default

<a id="adr-0006"></a>

The `chart` built-in kind (§04.1) expands a markdown table to a vega-lite
spec and must decide how table columns map to chart encoding channels. We
considered requiring explicit `x=`/`y=` attrs naming header columns on every
use — unambiguous and slightly more self-documenting, but adds required
boilerplate to the common case of a plain two-column comparison table, which
is most of what a chart block is for. We chose positional binding as the
default (first column → `x`/category, second → `y`/value), with `x=`/`y=`
attrs required only once a table carries more than two columns, where
position alone would be ambiguous. This keeps the terse common case terse
while still supporting wider tables explicitly rather than guessing.
