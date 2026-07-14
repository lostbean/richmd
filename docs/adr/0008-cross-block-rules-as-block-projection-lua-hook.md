# Cross-block rules run over a simplified block projection, not the raw AST

<a id="adr-0008"></a>

Per-block [validation](../design/CONTEXT.md#term-validate-phase) cannot
express a rule that spans blocks — ordering, cardinality, or a required
cross-link between blocks of different kinds. We considered handing a rule
the raw Pandoc AST nodes (the same shape block-kind render functions already
receive) against a simplified per-block projection (kind, attrs, location,
body text). We chose the projection: a rules author is a consumer writing
JSON schemas and small Lua checks, not necessarily someone fluent in
Pandoc's AST, and coupling every rule to that AST's shape would make richmd's
internal representation load-bearing for consumer code. We also considered
running rules interleaved with per-block checks (letting a rule short-circuit
before every block is validated) against running every
[document-wide check](../design/CONTEXT.md#term-document-wide-check) only
once every check it depends on has already collected its errors; we chose
the dependency-ordered rule, so a cross-block rule can assume every
[block projection](../design/CONTEXT.md#term-block-projection) it sees
already passed its own schema, and the
[all-errors-collected invariant](../design/design.md#00-foundation) still
holds — a rule never causes per-block errors to go unreported. Violations
report through the exact same `add_error` mechanism and
`richmd: [<source>] <location>: <reason>` format per-block errors already
use, naming the rule as its [error source](../design/CONTEXT.md#term-error-source)
(its filename, `rule:`-prefixed so it can never collide with a same-named
block kind) and the latest offending block as `<location>`. Load-time
failures (a malformed `.richmd/rules/*.lua` file) are fatal at filter
startup, identical to
[ADR-0003](0003-schema-lua-plugin-pair-for-extension.md#adr-0003)'s
`.richmd/blocks/` contract — a broken rule is never silently skipped.
