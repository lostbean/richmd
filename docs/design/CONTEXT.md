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

### Extension directory {#term-extension-directory}

A consumer-owned directory (default `.richmd/blocks/`) holding paired
schema-fragment + Lua-filter files that add new
[block kinds](#term-block-kind) to the [registry](#term-block-kind-registry)
without forking richmd's core.

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

One collected failure from the [validate phase](#term-validate-phase): the
offending [block](#term-block)'s location, its kind, and a human-readable
reason. Never causes an immediate exit — the phase collects every error in
the document before reporting.

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

The HTML `id` richmd assigns to a heading, derived from its text by a single
documented, pure function (GitHub-flavored rules: lowercase, punctuation
stripped except hyphens, spaces to hyphens, duplicate headings suffixed
`-1`/`-2`...). The same function resolves every `#fragment` link, so headings
and links always agree.

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
