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
canonical authoring syntax, so a class with no
[registry](#term-block-kind-registry) match is a validation error, never a
silent pass-through. A fenced code block's class is not: by universal
Pandoc/CommonMark convention it names a syntax-highlighting language
(` ```js `, ` ```python `), so richmd only treats a code block as a Block
when its class is one it explicitly recognizes (`mermaid`, `vega-lite`,
...) — an unrecognized code block class is always ordinary code, never a
validation error. The two node types read their class differently on
purpose; this is not an inconsistency.

A fenced div's kind may be written in either of two interchangeable forms:
the canonical native `::: {.kind attr=val}`, or the
[bareword directive](#term-bareword-directive) `:::kind {attr=val}` (the
markdown-it/remark convention), which the
[directive lift](#term-directive-lift) normalizes to the native form before
Pandoc parses. Both reach the identical [registry](#term-block-kind-registry)
lookup, validation, and [block projection](#term-block-projection); the choice
of form is never itself observable to a check.

### Bareword directive {#term-bareword-directive}

The fenced-div form `:::kind {attrs}` — the kind written as a bareword
immediately after the colons, with attrs in a following brace group — as used
by markdown-it-container and remark-directive. Distinct from the canonical
native form `::: {.kind attrs}`, where the kind is a Pandoc class inside the
brace group. Pandoc's reader accepts the attrless bareword `:::kind` as a
[Block](#term-block) directly, but reads the attr-bearing bareword as prose;
the [directive lift](#term-directive-lift) closes that gap so both forms behave
identically. _Avoid_: "container syntax" — names the borrowed ecosystem, not the
shape.

### Directive lift {#term-directive-lift}

The text-level normalization that rewrites a
[bareword directive](#term-bareword-directive) fence-opener into the canonical
native form (`:::kind {attrs}` → `::: {.kind attrs}`) before Pandoc parses.
Runs on the [document](#term-document) source ahead of the single parse — never
in the Lua filter, which sees the AST only after the parse has already decided
what is a [Block](#term-block). Matches a fence-opener line at any nesting
depth and preserves its colon count; never fires inside a code block Pandoc
reads as verbatim (fenced or indented), so the lift and Pandoc's own parse
agree on every line. See
[ADR-0010](../adr/0010-accept-bareword-directive-syntax-via-pre-parse-lift.md#adr-0010).

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
per consumer-facing extension point richmd defines — the
[extension directory](#term-extension-directory), the
[rules directory](#term-rules-directory), and the
[tokens directory](#term-tokens-directory); a further extension point earns
another child under the same convention, never a parallel discovery
mechanism.
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

### Tokens directory {#term-tokens-directory}

The [config directory](#term-config-directory)'s `tokens/` child
(`.richmd/tokens/`), holding one
[token vocabulary](#term-token-vocabulary) JSON file per vocabulary.
Optional, like the [rules directory](#term-rules-directory).

### Token vocabulary {#term-token-vocabulary}

A named closed set of member keys, each carrying arbitrary consumer-owned
properties. Its name is its filename (`.richmd/tokens/lens.json` declares the
vocabulary `lens`), so the name is never a second fact the file could
disagree with. richmd ships no vocabulary of its own: the set and its
properties are the consumer's, and richmd owns only the mechanism that
declares, recognizes, and validates them. See
[ADR-0011](../adr/0011-token-vocabulary-as-closed-set-resolved-per-reference.md#adr-0011).

_Avoid_: "enum" (a vocabulary's members carry properties, an enum's do not);
"taxonomy" (implies a hierarchy the set does not have).

### Token reference {#term-token-reference}

One citation of a [token vocabulary](#term-token-vocabulary) member from a
[document](#term-document): an inline code span of the form
`` `<vocabulary>:<member>` ``, or a [block](#term-block) attr whose
[block kind schema](#term-block-kind-schema) opted it into a vocabulary. A
reference is singular and resolves by exact key lookup — it never carries a
combination of members. Multiplicity is repetition: a heading citing two
members writes two references, so a set of members is formed by collection
at the reference site, never by a grammar richmd parses.

### Resolved token {#term-resolved-token}

What a [token reference](#term-token-reference) becomes once the
[token resolution pass](#term-token-resolution-pass) matches it against its
[vocabulary](#term-token-vocabulary): the vocabulary name, the member key,
the member's properties, and the reference's location — `code.<vocabulary>`
for an inline span, and the owning [block](#term-block)'s own location for an
attr, since an attr's reference is that block's. A flat value, never a live
reference into the Pandoc AST — the same consumer-facing contract a
[block projection](#term-block-projection) already holds to
([ADR-0008](../adr/0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008)).

### Token hook {#term-token-hook}

What a recognized inline [token reference](#term-token-reference) renders as:
a `richmd-token` class plus its vocabulary and member as data attributes
(`<code class="richmd-token" data-vocabulary="lens" data-member="state">state</code>`).
Structure only — it names which member this is and carries no
[properties](#term-token-vocabulary), so a consumer's stylesheet decides what
a member looks like and a [theme](#term-theme) can still override it (P3). The
[block](#term-block)-attr surface needs no hook: a block's own renderer
already receives the member as its attr value.

### Token resolution pass {#term-token-resolution-pass}

The [validate-phase](#term-validate-phase) pass that walks a
[document](#term-document) for [token references](#term-token-reference),
resolves each against its [vocabulary](#term-token-vocabulary), and records
a [validation error](#term-validation-error) for any member not in the set.
A [document-wide check](#term-document-wide-check): it runs after every
per-block schema check and before [cross-block rules](#term-cross-block-rule),
which consume its [resolved tokens](#term-resolved-token).

### Block projection {#term-block-projection}

A frozen snapshot of a [block](#term-block) taken once, when the
[block projection](#term-block-projection) list is built (§05) — its kind,
attrs, location, body text, and the [resolved tokens](#term-resolved-token)
found within it, copied out at that moment, never a live
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
heading carries no explicit id of its own. The text it reads is the heading's
prose: a [token reference](#term-token-reference) richmd recognizes is
addressing, not prose, and contributes nothing
([ADR-0012](../adr/0012-token-references-are-addressing-not-heading-prose.md#adr-0012)) —
an ordinary code span, and a span naming no declared
[vocabulary](#term-token-vocabulary), are prose and contribute normally.

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
