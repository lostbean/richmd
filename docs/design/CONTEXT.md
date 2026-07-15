# richmd — glossary

_Register_: markdown authoring and static-site generation vocabulary — terms
are drawn from Pandoc, CommonMark, and JSON Schema idiom, not general
software-engineering idiom.

### Document {#term-document}

A single `.md` source file richmd converts. The one entity with identity
that persists across edits: its file path and content change, but it remains
"the same document."

### Block {#term-block}

A typed content unit inside a [Document](#term-document) — a fenced div
(`::: {.kind attr=val}`) or a fenced code block (` ```mermaid `,
` ```vega-lite `). Defined entirely by its kind, attrs, and body; no
identity beyond that — a value object.

A fenced div's class is always a kind attempt: `::: {.kind}` is richmd's
primary authoring syntax, so a class with no
[registry](#term-block-kind-registry) match is a validation error, never a
silent pass-through. A fenced code block's class is not: by universal
Pandoc/CommonMark convention it names a syntax-highlighting language
(` ```js `, ` ```python `), so richmd only treats a code block as a Block
when its class is one it explicitly recognizes (`mermaid`, `vega-lite`,
...) — an unrecognized code block class is always ordinary code, never a
validation error. The two node types read their class differently on
purpose; this is not an inconsistency.

### Block kind {#term-block-kind}

The name that selects which [schema](#term-block-kind-schema) and renderer
apply to a [block](#term-block) — e.g. `callout`, `cards`, `mermaid`,
`vega-lite`, `svg`, or a consumer-defined kind.

### Block kind schema {#term-block-kind-schema}

The machine-readable contract for one [block kind](#term-block-kind):
required/optional attrs, allowed values, body shape. The validator reads this
generically — extending the vocabulary means adding a schema entry, never
adding an `if kind == "x"` branch. _Avoid_: "block type definition" — schema
is the precise word; richmd's validator is schema-driven by design.

### Block kind registry {#term-block-kind-registry}

The union of built-in [block kind schemas](#term-block-kind-schema) richmd
ships, plus every schema a consumer registers under its own
[extension directory](#term-extension-directory). One registry, looked up by
kind name, regardless of origin.

### Config directory {#term-config-directory}

The consumer-owned `.richmd/` directory richmd discovers for a given
[document](#term-document): the nearest ancestor of the document's own
directory (including that directory itself) containing a `.richmd/`
directory, found by walking upward and stopping at the first directory
containing `.git` (or at the document's own directory, if the walk finds
none, or if an ancestor directory cannot be read — a permission error during
the walk stops the walk exactly like reaching the boundary, never silently
skips past the unreadable directory to keep climbing). "Nearest wins" — a
document uses exactly one config directory, never a merge of several found
along the walk. Its children are named, purpose-specific subdirectories, one
per consumer-facing extension point richmd defines — today the
[extension directory](#term-extension-directory) and the
[rules directory](#term-rules-directory); a future extension point earns a
third child under the same convention, never a parallel discovery mechanism.
See [ADR-0009](../adr/0009-config-dir-upward-walk-bounded-at-repo-root.md#adr-0009).

### Extension directory {#term-extension-directory}

The [config directory](#term-config-directory)'s `blocks/` child
(`.richmd/blocks/`), holding paired schema-fragment + Lua-filter files that
add new [block kinds](#term-block-kind) to the
[registry](#term-block-kind-registry) without forking richmd's core.

### Rules directory {#term-rules-directory}

The [config directory](#term-config-directory)'s `rules/` child
(`.richmd/rules/`), holding [cross-block rule](#term-cross-block-rule) Lua
files. Optional, like the [extension directory](#term-extension-directory) —
most documents have none.

### Block projection {#term-block-projection}

A frozen snapshot of a [block](#term-block) taken once, when the
[block projection](#term-block-projection) list is built (§05) — its kind,
attrs, location, and body text copied out at that moment, never a live
reference into the Pandoc AST. A later phase mutating the AST (the
[render phase](#term-render-phase) rewrites link targets and assigns slugs)
never changes a projection already handed to a
[cross-block rule](#term-cross-block-rule); moot in practice since every
projection is built and consumed entirely within the
[validate phase](#term-validate-phase), before the render phase exists. Never
the raw Pandoc AST node a block-kind renderer works with — decouples rule
authoring from richmd's internal AST representation. See
[ADR-0008](../adr/0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008).

### Cross-block rule {#term-cross-block-rule}

A consumer-defined check spanning more than one [block](#term-block) —
ordering, cardinality, a required cross-link, a document-wide enum — living
as a `.lua` file in the [rules directory](#term-rules-directory), identified
by its filename as an [error source](#term-error-source). Runs once per
document, as a [document-wide check](#term-document-wide-check), receiving
the document's full ordered [block projection](#term-block-projection) list
and reporting through the same collected-
[validation-error](#term-validation-error) mechanism a per-block check uses.
See
[ADR-0008](../adr/0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008).

### Document-wide check {#term-document-wide-check}

Any [validate-phase](#term-validate-phase) check whose input is more than
one [block](#term-block) at once, rather than one block in isolation. Runs
after every check it depends on has already collected its errors — a
document-wide check that itself depends on another document-wide check's
result runs after it, transitively. [Cross-block rules](#term-cross-block-rule)
are richmd's first instance; the ordering rule is stated generally because a
second instance is expected to compose with the first, not to redefine
"last."

### Validate phase {#term-validate-phase}

The first internal phase of the Lua filter: walks the whole AST, checks
every [block](#term-block) against the
[registry](#term-block-kind-registry), shells out to the
[grammar validators](#term-grammar-validator) for diagram/chart blocks, and
collects every [validation error](#term-validation-error) before deciding
whether to proceed. Never renders.

### Render phase {#term-render-phase}

The second internal phase, reached only when the
[validate phase](#term-validate-phase) collects zero errors: rewrites
cross-document links, assigns heading slugs, injects the theme stylesheet
and diagram-runtime script references, and emits the
[rendered page](#term-rendered-page).

### Validation error {#term-validation-error}

One collected failure from the [validate phase](#term-validate-phase): an
[error source](#term-error-source), a location, and a human-readable reason.
Never causes an immediate exit — the phase collects every error in the
document before reporting.

### Error source {#term-error-source}

The identifier a [validation error](#term-validation-error) names as its
origin, reported in the `<source>` slot of
`richmd: [<source>] <location>: <reason>`. Two kinds share the slot, prefix-
distinguished so neither can collide with the other: a bare name (e.g.
`callout`) is a [block kind](#term-block-kind); a `rule:`-prefixed name
(e.g. `rule:foundation-ordering`) is a [cross-block rule](#term-cross-block-rule),
identified by its filename without the `.lua` extension. A block kind and a
rule may otherwise share a name (a rule file named `callout.lua` is legal)
without their errors ever reading alike.

### Chart expansion {#term-chart-expansion}

The `chart` [built-in kind](#term-block-kind)'s render step: a markdown
table body plus a `type` (`bar`/`line`/`pie`) attr expands to a vega-lite
spec — first table column bound to the `x`/category encoding and second to
`y`/value by position, or explicitly via `x=`/`y=` attrs on a wider table.
The expanded spec re-enters the same [grammar validator](#term-grammar-validator)
and diagram runtime a hand-authored ` ```vega-lite ` block goes through —
convenience sugar over vega-lite, not a second chart implementation.

### Grammar validator {#term-grammar-validator}

A small, tightly-scoped Node.js helper script the Lua filter shells out to
for a diagram/chart language with no native Lua grammar (mermaid, vega-lite).
Checks syntax only — parses the source and reports malformed grammar; does
not render to a picture and carries no browser/Puppeteer dependency.
_Avoid_: "linter" — this is a fail-closed gate a document must pass, not an
optional style suggestion.

### Rendered page {#term-rendered-page}

The output `.html` [document](#term-document) produced by the
[render phase](#term-render-phase): self-contained markup plus the theme
stylesheet, with either CDN diagram-runtime references (default) or fully
bundled, offline-viewable assets (`--offline` flag).

### Offline bundling {#term-offline-bundling}

The `--offline` render flag's behavior: download and embed the pinned
diagram/chart JavaScript runtimes (mermaid.js, the vega-lite renderer)
directly into the [rendered page](#term-rendered-page) so it is viewable
with no network access. Disabled by default — the default page carries CDN
`<script>` references instead, keeping the committed HTML small at the cost
of requiring network access to view diagrams.

### Slug {#term-slug}

The HTML `id` richmd derives from a heading's text by a single documented,
pure function (GitHub-flavored rules: lowercase, punctuation stripped except
hyphens, spaces to hyphens, duplicate headings suffixed `-1`/`-2`...). A
heading's actual [anchor id](#term-anchor-id) is this slug only when the
heading carries no explicit id of its own.

### Anchor id {#term-anchor-id}

The identifier a `#fragment` link resolves against. Every anchor id in a
[document](#term-document) comes from exactly one of two sources: a
heading's explicit Pandoc id (`### Heading {#explicit-id}`) when present,
else its [slug](#term-slug); or a raw HTML element's own `id="..."`
attribute (e.g. `<a id="explicit-id"></a>`), authored directly, never
derived. Both sources feed the same id space a target document's fragment
check resolves against — richmd does not distinguish an explicit heading id
from an HTML id when validating a link, since both are equally an author's
explicit, stable anchor.

### Cross-document link {#term-cross-document-link}

A relative link in a [document](#term-document) whose target ends in `.md`
(with or without a `#fragment`). Every such link is rewritten to its sibling
`.html` target during the [render phase](#term-render-phase) — automatic, no
authoring-time marker syntax required to make the rewrite itself happen. A
target that does not resolve to an existing source file is a
[validation error](#term-validation-error).

### In-tree link {#term-in-tree-link}

A [cross-document link](#term-cross-document-link) whose resolved `.md`
target (fragment stripped) matches one of the paths named by the render
call's `--tree` flag. Carries `class="richmd-intree-link"` in the
[rendered page](#term-rendered-page) with zero default styling (P3) — purely
a caller-supplied classification, never authored in the source markdown and
never present when `--tree` is absent.

### Theme {#term-theme}

The CSS asset controlling a [rendered page](#term-rendered-page)'s visual
identity. richmd ships exactly one default stylesheet, built entirely from
`--richmd-*` CSS custom properties; a consumer reskins by overriding the
variables or supplying a replacement stylesheet — richmd's core never
hardcodes visual identity.

### Categorical palette {#term-categorical-palette}

The six `--richmd-color-cat-1` through `--richmd-color-cat-6`
[theme](#term-theme) tokens (the first two aliasing the accent/accent-2
tokens) read live and injected as the default color range for any
Vega-Lite nominal channel with no `scale.range` of its own — chart-derived
or hand-authored, per
[ADR-0007](../adr/0007-shared-categorical-palette-for-vega-lite-specs.md#adr-0007).
A domain with more than six values cycles the range rather than erroring.
