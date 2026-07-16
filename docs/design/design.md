---
eyebrow: Root design · richmd
lede: A standalone CLI that converts an extended-Markdown dialect into rich, self-contained, static HTML — built on Pandoc + Lua filters, with small Node helpers providing real grammar validation for mermaid and vega-lite. Any repo consumes it as a dependency; this repo IS that dependency.
footer: The design document owns the design; CONTEXT.md owns the glossary; docs/adr/ owns the rationale.
---

# richmd — root design

richmd turns a small set of custom markdown blocks — callouts, cards, stat
tiles, embedded diagrams and charts — into validated, themeable static HTML.
It is consumed as a CLI by other repos, never embedded as one-off scripts in
a single project. Two internal phases inside one Pandoc Lua filter: validate
first (fail closed, every error collected), render only once validation is
clean.

## 00 Foundation

:::goal
**Rich markdown, validated, to static HTML**

Convert extended-markdown [documents](CONTEXT.md#term-document) into
self-contained static HTML carrying rich visual blocks — callouts, cards,
diagrams, charts, stat tiles, embedded SVG — recognizable to anyone who
already writes markdown.
:::

:::goal
**Fail closed, before ever writing output**

A malformed [block](CONTEXT.md#term-block) — wrong attrs, invalid mermaid or
vega-lite grammar, a dangling cross-document link — never reaches rendered
output. Every [validation error](CONTEXT.md#term-validation-error) in the
document is collected and reported with a clear, per-block reason before
any HTML is written.
:::

:::goal
**Consumable as a dependency, not copy-pasted scripts**

Any repo pulls richmd in as a pinned, reproducible package — via its Nix
flake or the npm wrapper — and runs it as a CLI. See
[ADR-0001](../adr/0001-nix-flake-primary-npm-thin-wrapper.md#adr-0001).
:::

:::goal
**Extend without forking**

A consumer adds its own [block kind](CONTEXT.md#term-block-kind) — schema
plus renderer — without touching richmd's core source. See
[ADR-0003](../adr/0003-schema-lua-plugin-pair-for-extension.md#adr-0003).
:::

:::no-goal
**Not a static site generator**

No navigation, search, or multi-page site scaffolding beyond what
[cross-document link](CONTEXT.md#term-cross-document-link) rewriting gives
for free. One document in, one page out — a single render call never
orchestrates or walks a whole tree. The
[in-tree link marker](CONTEXT.md#term-in-tree-link) (§06) narrows this
without crossing it: it only changes how links already being rewritten in
that one render are classified, never adds a second document to the call.
See [ADR-0005](../adr/0005-tree-flag-for-in-tree-link-classification.md#adr-0005).
:::

:::no-goal
**Not a WYSIWYG editor**

richmd converts markdown text a human or agent already wrote; it never
provides an authoring UI.
:::

:::no-goal
**Not a hosting or publishing tool**

richmd's job ends at a written `.html` file on disk. Deploying, serving, or
publishing it is the consumer's concern.
:::

:::no-goal
**Not a semantic validator for diagrams/charts**

[Grammar validators](CONTEXT.md#term-grammar-validator) check that mermaid
and vega-lite source is syntactically well-formed. They do not check that a
vega-lite spec references fields that actually exist in its data, or that a
mermaid diagram's logic makes domain sense.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=robustness}
**Fail-closed gate**

A [document](CONTEXT.md#term-document) that fails the
[validate phase](CONTEXT.md#term-validate-phase) never reaches the
[render phase](CONTEXT.md#term-render-phase). The filter's own control flow
gates on an empty error list — there is no path from a non-empty error list
to a written `.html` file.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=invariants}
**Schema-driven validation, no hardcoded kinds**

Every [block](CONTEXT.md#term-block) — built-in or consumer-extended — is
checked against its
[block kind schema](CONTEXT.md#term-block-kind-schema) in the
[registry](CONTEXT.md#term-block-kind-registry). The validator's core loop
reads the registry generically; extending the vocabulary means adding a
schema entry, never adding an `if kind == "x"` branch.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=robustness}
**All errors collected, never fail-fast on the first**

The [validate phase](CONTEXT.md#term-validate-phase) accumulates every
[validation error](CONTEXT.md#term-validation-error) in the document before
reporting or exiting — never an early return on the first problem found.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=robustness}
**Document-wide checks run after what they depend on**

A [document-wide check](CONTEXT.md#term-document-wide-check) runs only after
every check whose output it depends on has already collected its errors.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=robustness}
**Cross-document links always resolve**

Every relative [cross-document link](CONTEXT.md#term-cross-document-link) is
checked against the filesystem during the
[validate phase](CONTEXT.md#term-validate-phase); a target that does not
resolve to an existing source file is a
[validation error](CONTEXT.md#term-validation-error), never a silently
broken link in the output.
:::

:::invariant {enforcement=mechanism script=richmd-directive-lift lens=robustness}
**Directive lift agrees with the parse, never fires inside code**

The [directive lift](CONTEXT.md#term-directive-lift) rewrites a
[bareword directive](CONTEXT.md#term-bareword-directive) fence-opener only
outside any code block Pandoc reads as verbatim — fenced or indented —
preserving its colon count, so the lifted text and Pandoc's parse of it
classify every line identically — no line richmd rewrites is one Pandoc would
have read as verbatim code, and no attr-bearing bareword block escapes
validation as prose.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=state}
**A heading's anchor id is deterministic: explicit id, else slug**

A heading's [anchor id](CONTEXT.md#term-anchor-id) is its own explicit
Pandoc id (`{#id}`) when authored, else its [slug](CONTEXT.md#term-slug),
computed by one documented, tested function of its text (GitHub-flavored
rules). `#fragment` link resolution checks the identical id a target
heading actually receives, so headings and links can never disagree.
:::

:::invariant {enforcement=mechanism script=richmd-filter-core lens=robustness}
**Fragment resolution sees every authored anchor id**

`#fragment` link validation resolves against every
[anchor id](CONTEXT.md#term-anchor-id) in the target document — both
heading ids (explicit or slugified) and raw HTML `id="..."` attributes —
never against heading slugs alone. Widening the known-id set never narrows
what a previously-valid link resolves to.
:::

:::principle {id=P1 lens=invariants}
**Mechanize the decidable**

A rule a machine can check belongs in the
[block kind schema](CONTEXT.md#term-block-kind-schema) and the validator,
never in author convention or documentation prose.
:::

:::principle {id=P2 lens=robustness}
**Fail loud, local, and early**

A malformed block's error names the block, its location, and the reason, at
[validate-phase](CONTEXT.md#term-validate-phase) time — never a downstream
rendering crash or a silently wrong page.
:::

:::principle {id=P3 lens=composition}
**Style is swappable, never hardcoded**

The renderer emits structure and `--richmd-*` CSS-variable hooks; visual
identity lives entirely in the [theme](CONTEXT.md#term-theme) stylesheet,
never in generator logic.
:::

:::principle {id=P4 lens=composition}
**Extend by composition, never by fork**

A consumer adds a [block kind](CONTEXT.md#term-block-kind) through the
[extension directory](CONTEXT.md#term-extension-directory)'s schema + Lua
pair. Modifying richmd's own core source is never the extension path. See
[ADR-0003](../adr/0003-schema-lua-plugin-pair-for-extension.md#adr-0003).
:::

## 01 System at a glance

richmd is one pipeline: parse, validate, gate, render. The
[validate phase](CONTEXT.md#term-validate-phase) and
[render phase](CONTEXT.md#term-render-phase) are two internal phases of one
Lua filter — not two Pandoc invocations. See
[ADR-0002](../adr/0002-one-filter-two-internal-phases.md#adr-0002).

```mermaid
graph TD
    Doc["Document (.md)"]
    Parse["Pandoc parse → AST"]
    Validate["Validate phase\nschema lookup per block\n+ grammar validators\n+ cross-block rules"]
    Gate{"Errors empty?"}
    Render["Render phase\nlink rewrite · slugify\ntheme + diagram runtime"]
    Page["Rendered page (.html)"]
    Errors["Validation errors\n(all collected, exit 1)"]

    Doc --> Parse --> Validate --> Gate
    Gate -->|yes| Render --> Page
    Gate -->|no| Errors

    classDef core fill:#e8e8ef,stroke:#8a8aa0,color:#333;
    classDef terminal fill:#f4f4f8,stroke:#9a9ab0,color:#222;
    class Parse,Validate,Render core;
    class Page,Errors terminal;
```

:::info {title="Reading the pipeline"}
One invocation, one parse. The
[directive lift](CONTEXT.md#term-directive-lift) is a text normalization on
the source _before_ that parse (§02.1), not a second parse — Pandoc still
parses exactly once. The diamond is the fail-closed gate
([invariant](#00-foundation)): only an empty error list reaches the render
phase. Both branches terminate the same filter run — there is no retry loop
inside richmd itself.
:::

## 02 CLI entry {#02-cli-entry}

:::cards {cols=2}

### `richmd validate <file>` `lens:robustness`

**Run the gate without writing output.** Invokes the same Lua filter, passes
a flag that stops execution right after the
[validate phase](CONTEXT.md#term-validate-phase). Exits 0 clean, 1 on
collected [validation errors](CONTEXT.md#term-validation-error) printed to
stderr, never touches disk beyond reading input. Built for CI/pre-commit
gates that should not produce discardable build artifacts.

### `richmd render <file> [--offline] [--tree=<path>...] [--check]`

**Run the full pipeline.** Same filter, both phases. `--offline` switches
the [render phase](CONTEXT.md#term-render-phase) into
[offline bundling](CONTEXT.md#term-offline-bundling): downloads and embeds
the pinned diagram-runtime JavaScript instead of leaving CDN references.
Repeatable `--tree=<path>` names sibling `.md` paths that count as
[in-tree](CONTEXT.md#term-in-tree-link) for link classification (literal
paths only — richmd does no glob-expansion; the shell or caller expands
globs before argv). Writes the sibling `.html` file only when the validate
phase collects zero errors. `--check` changes only the write step, never
what gets generated: every other flag on the same invocation shapes the
in-memory result exactly as it would shape a write, and `--check` then
byte-compares that same result against the existing sibling `.html` file
instead of writing it — exiting 0 when identical, non-zero (with a diff)
when the committed file is stale, missing, or was committed under a
different flag combination than this invocation used (e.g. a non-`--offline`
check against an `--offline`-committed file reports stale for that reason,
not silent content drift). Built for CI proving a committed `.html` matches
one specific, named invocation, never hand-edited or left stale.
:::

### 02.1 Directive lift {#02-1-directive-lift}

**Owns normalizing the [bareword directive](CONTEXT.md#term-bareword-directive)
form into canonical native form before Pandoc parses.** A pure text-to-text
pass over the [document](CONTEXT.md#term-document) source, run by the CLI (§02)
on the way to the Pandoc invocation — the only richmd step that touches source
text rather than the parsed AST, because the shape it fixes is one Pandoc has
already discarded by the time any Lua filter runs.

- **Responsibility**: rewrite every fence-opener line of the form
  `:::kind {attrs}` (a run of three or more colons, a bareword kind token, then
  a brace-attr group) into `::: {.kind attrs}` at the identical colon count, so
  an attr-bearing bareword directive becomes a real Pandoc `Div` exactly as its
  native equivalent already does. Leave every other line byte-for-byte: a
  closing fence (`:::`), an already-native `::: {.kind …}`, an attrless
  `:::kind` (Pandoc already reads it as a Div), and any prose that merely
  contains a `:::`-like sequence mid-line.
- **Interface**: `lift(source_text) -> source_text`, called by the CLI before
  the document path/text reaches Pandoc; deterministic and idempotent (a second
  lift over lifted text is a no-op, since native openers never match the
  bareword shape).
- **Interacts with**: the [CLI entry](#02-cli-entry), which applies it ahead of
  the single Pandoc parse; the [block kind registry](#04-block-kind-registry),
  which then sees a lifted block as an ordinary Div with a class — a bareword
  kind naming no registered kind becomes the registry's ordinary unknown-class
  [validation error](CONTEXT.md#term-validation-error), never the former
  silent-prose escape. When the lift changes the source, the CLI hands Pandoc
  the transformed text from a temporary file that is a **sibling** of the
  original — same directory — so the document's directory (which drives
  [config directory](CONTEXT.md#term-config-directory) discovery and relative
  [cross-document link](CONTEXT.md#term-cross-document-link) resolution) is
  identical to a native render. A [rendered page](CONTEXT.md#term-rendered-page)
  derives its title from the document's own title when it declares one, else
  from the input filename; since the sibling temp file's name would otherwise
  leak into that fallback, the CLI pins the title to the original file's name
  for a title-less document, leaving a document's own declared title untouched —
  so a lifted render is byte-identical to the native one either way.
- **Invariants held**: fail-loud (§00 P2) — the lift is what makes an
  attr-bearing bareword block _reach_ validation at all, closing the false-green
  where it was silently parsed as prose; lift agrees with the parse (§00).
- **Failure behavior**: the lift never rewrites a line Pandoc reads as
  verbatim code — neither inside a ` ``` `/`~~~` fenced code block (tracking
  fence state, honoring line endings) nor a line Pandoc treats as an
  indented code block (four-space or tab indent). It matches Pandoc's own
  verbatim treatment on both, so the lift and the parse can never disagree on
  the same line, and directive syntax a document quotes as a literal example
  is preserved whichever code form it uses. It raises no errors of its own: a
  line it does not recognize as a bareword directive is simply left unchanged,
  deferring every judgment to the validate phase that runs on the parsed result.

## 03 Filter core {#03-filter-core}

**Owns the two-phase orchestration.** One Lua filter module, loaded by
Pandoc, walks the document's AST once. Its own control flow is the
fail-closed gate: the render pass is unreachable code unless the validate
pass's error list is empty.

- **Responsibility**: sequence validate-then-render inside a single AST
  walk; own the phase boundary itself.
- **Interface**: invoked by the CLI (§02) via `pandoc --lua-filter`; consumes
  a [document](CONTEXT.md#term-document) path and the `--offline` flag;
  produces either a [rendered page](CONTEXT.md#term-rendered-page) or a
  non-zero exit with printed
  [validation errors](CONTEXT.md#term-validation-error). Resolves the
  document's [config directory](CONTEXT.md#term-config-directory) once at
  startup, before either phase runs, by walking upward from the document's
  own directory per [ADR-0009](../adr/0009-config-dir-upward-walk-bounded-at-repo-root.md#adr-0009);
  the resolved path is printed to stderr on every invocation, so which
  `.richmd/` a given render or validate call actually used is never a silent
  fact two sibling documents could disagree on unnoticed.
- **Interacts with**: the [block kind registry](#04-block-kind-registry) for
  per-block schema lookup; the
  [grammar validators](#06-grammar-validators) via shell-out for
  mermaid/vega-lite blocks; [cross-block rules](#05-cross-block-rules) as a
  [document-wide check](CONTEXT.md#term-document-wide-check); the
  [link resolver and slugifier](#07-link-resolver-and-slugifier) during the
  render pass; the [theme and diagram runtime](#08-theme-and-diagram-runtime)
  component for the final HTML injection.
- **Invariants held**: fail-closed gate, all-errors-collected (both §00).
- **Failure behavior**: any Lua runtime error during either phase is a hard
  filter failure — printed with the [error source](CONTEXT.md#term-error-source)
  and location that triggered it, non-zero exit, no partial HTML written.
  Every [validation error](CONTEXT.md#term-validation-error) already
  collected before the crash is still printed alongside it — a runtime
  crash partway through validate never discards errors an earlier check in
  the same phase already gathered, only the crashing check's own remaining
  work is lost.

## 04 Block kind registry {#04-block-kind-registry}

**Owns schema lookup for every block kind, built-in or extended.** A single
table keyed by kind name; each entry is a
[block kind schema](CONTEXT.md#term-block-kind-schema) (required/optional
attrs, allowed values, body shape) plus its Lua render function.

- **Responsibility**: load richmd's built-in schemas (callout, cards, stat
  tile, stat grid, TOC, labeled block, embedded SVG) and merge in every
  schema found under the [filter core](#03-filter-core)'s resolved
  [config directory](CONTEXT.md#term-config-directory)'s
  [extension directory](CONTEXT.md#term-extension-directory) child
  (`.richmd/blocks/`); resolve a block's kind name to its schema and
  renderer for both filter phases.
- **Interface**: `lookup(kind_name) -> {schema, render_fn} | nil`; for a
  [Block](CONTEXT.md#term-block) whose class is always a kind attempt (a
  fenced div), a missing kind is itself a
  [validation error](CONTEXT.md#term-validation-error), never a silent
  pass-through — a fenced code block's unrecognized class is ordinary code,
  not a validation error, per the Block term's own distinction.
- **Interacts with**: the [filter core](#03-filter-core), which calls
  `lookup` once per block during validate and again during render; consumer
  repos, which populate the extension directory.
- **Invariants held**: schema-driven validation (§00) — this is the table
  the invariant's "generic lookup, no hardcoded kinds" claim depends on.
- **Failure behavior**: a schema fragment that itself fails to parse (bad
  JSON, missing required schema fields) is a load-time error naming the
  offending file — the filter refuses to run rather than silently skipping
  a broken extension.

:::cards {cols=3 size=sm}

### callout

info/warning/danger tinted panels

### cards / grid

the workhorse enumeration block, each card's `###` title optionally paired
with a small badge/tag (e.g. `client`, `owns: schema registry`) — visual
metadata, never a substitute for the title text itself

### stat tile

KPI-style number-plus-label

### stat grid

groups sibling stat tiles into one shared row

### TOC

auto-generated from headings

### labeled block

goal/invariant/principle-style typed statement

### embedded SVG

inline a sibling `.svg` file, with an optional caption rendered as a real
`<figure>`/`<figcaption>` pair

### chart

`{type=bar|line|pie}` convenience block: a markdown table expands to a
[vega-lite spec](#term-chart-expansion) — see §04.1
:::

### 04.1 Chart expansion {#04-1-chart-expansion}

**Owns table-to-vega-lite expansion for the `chart` built-in kind.** The
only built-in kind whose Lua render function emits a different block kind's
source (a ` ```vega-lite ` fenced block) rather than final HTML directly —
composition, not a special case: the expanded spec re-enters the same
[grammar validator](#06-grammar-validators) and
[diagram runtime](#08-theme-and-diagram-runtime) every hand-authored
vega-lite block already goes through.

- **Responsibility**: read the block's markdown-table body and `type` attr;
  bind the table's first column to the `x`/category encoding and the second
  to the `y`/value encoding by position, unless `x=`/`y=` attrs name header
  columns explicitly (required once the table carries more than two
  columns); emit a minimal vega-lite spec of the requested mark type. Every
  mark type carries a color channel keyed to the category field — the
  [categorical palette](CONTEXT.md#term-categorical-palette) supplies the
  actual colors at render time, so expansion itself stays color-agnostic.
- **Interface**: `expand(attrs, table_rows) -> vega_lite_json | validation_error`,
  called during the [validate phase](CONTEXT.md#term-validate-phase) before
  the expanded spec is handed to `vega-lite-check.js` (§06) exactly like any
  other vega-lite block.
- **Interacts with**: the [block kind registry](#04-block-kind-registry),
  which dispatches `chart` blocks here instead of straight to HTML; the
  [grammar validators](#06-grammar-validators), which validate the expanded
  output; the [theme and diagram runtime](#08-theme-and-diagram-runtime),
  which renders it identically to a hand-authored chart.
- **Invariants held**: schema-driven validation (§00) — a `chart` block with
  more than two columns and no explicit `x=`/`y=` binding is a
  [validation error](CONTEXT.md#term-validation-error) naming the ambiguity,
  never a guessed encoding.
- **Failure behavior**: an unresolvable column binding, or a `type` outside
  `bar|line|pie`, is a validate-phase
  [validation error](CONTEXT.md#term-validation-error) naming the block; a
  table too wide for positional binding is rejected before expansion is
  attempted, never silently truncated to two columns.

## 05 Cross-block rules {#05-cross-block-rules}

**Owns [document-wide checks](CONTEXT.md#term-document-wide-check)** —
ordering, cardinality, required cross-links, document-wide enums. A
generalization of §04's schema-driven validation from one block to the whole
document, not a new validation model.

- **Responsibility**: load every `.lua` file found in the
  [rules directory](CONTEXT.md#term-rules-directory); build the document's
  ordered [block projection](CONTEXT.md#term-block-projection) list once per
  document, after every per-block, link, and grammar check has already run;
  run each loaded [cross-block rule](CONTEXT.md#term-cross-block-rule) once
  against that list.
- **Interface**: a rule file returns `{ check = function(block_projections,
add_error) ... end }`, or a bare `function` of the same signature — the
  same `add_error` closure per-block checks already call into, so a rule's
  violations land in the identical collected-errors list. A rule can assume
  every projection it receives already passed its own
  [block kind schema](CONTEXT.md#term-block-kind-schema) (§00 invariant). A
  violation's reported [error source](CONTEXT.md#term-error-source) is the
  rule's own filename, `rule:`-prefixed (e.g. `rule:foundation-ordering`) so
  it can never collide with a same-named block kind; its `<location>` names
  the latest block the rule found offending.
- **Interacts with**: the [filter core](#03-filter-core), which invokes the
  rules directory load once at startup and the check pass once per document,
  identically to how the [block kind registry](#04-block-kind-registry)'s
  extension directory already loads; the same collected-errors list every
  other validate-phase check writes into.
- **Invariants held**: schema-driven validation (§00, widened from per-block
  to document-wide by this component); all-errors-collected (§00);
  document-wide checks run after what they depend on (§00, the invariant
  this component introduces cross-block rules as the first instance of).
- **Failure behavior**: a malformed rule file (invalid Lua, a value that is
  neither a function nor a table with a `check` function field) is a
  load-time error naming the offending file and which of those shapes was
  found — fatal, identical to a malformed
  [extension directory](CONTEXT.md#term-extension-directory) file (§04) —
  the filter refuses to run rather than silently skipping a broken rule. A
  rule that itself raises a Lua runtime error during its check pass is a
  hard filter failure naming the rule (not a block location, since the
  failure is document-wide) — every error already collected by an earlier
  per-block, link, grammar, or rule check up to that point is still printed
  before the non-zero exit; only the crashing rule's own remaining checks
  are lost, exactly as any other in-phase runtime error (§03) preserves
  errors gathered before it struck.

:::info {title="Still not a semantic validator"}
A [cross-block rule](CONTEXT.md#term-cross-block-rule) sees only
[block projections](CONTEXT.md#term-block-projection) — kind, attrs,
location, body text. It can enforce document structure (ordering,
cardinality, required links) but has no access to a mermaid diagram's parsed
graph or a vega-lite spec's field bindings — the
["not a semantic validator for diagrams/charts" no-goal](#00-foundation)
still holds.
:::

See [ADR-0008](../adr/0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008).

## 06 Grammar validators {#06-grammar-validators}

**Owns real grammar checking for mermaid and vega-lite.** Neither has a
native Lua grammar library, so each gets a small, tightly-scoped Node.js
helper script the filter shells out to — not the full mermaid-cli/Puppeteer
stack.

- **Responsibility**: given one fenced code block's source text, return
  either "valid" or a structured error (line, column, reason) without
  rendering anything to a picture.
- **Interface**: two standalone scripts, `mermaid-check.js` (calls
  `mermaid.parse(source)` headless — no DOM, no browser) and
  `vega-lite-check.js` (validates against the vega-lite JSON schema);
  invoked as a subprocess per block, communicating over stdin/stdout as
  JSON.
- **Interacts with**: the [filter core](#03-filter-core)'s validate phase,
  once per mermaid or vega-lite block found.
- **Invariants held**: contributes to schema-driven validation (§00) for the
  two block kinds no Lua grammar exists for.
- **Failure behavior**: a malformed diagram/chart is a
  [validation error](CONTEXT.md#term-validation-error) naming the block and
  the parser's own reason; a validator subprocess crashing unexpectedly is
  itself a hard filter failure, distinct from a normal grammar rejection.

:::warning {title="What this does not catch"}
Syntax-only. A mermaid diagram that parses cleanly but references an
unsupported layout feature, or a vega-lite spec whose grammar is valid but
whose field references do not exist in its data, passes this gate — see the
"not a semantic validator" no-goal (§00).
:::

## 07 Link resolver and slugifier {#07-link-resolver-and-slugifier}

**Owns cross-document link rewriting and heading-anchor stability.** Two
related passes during the render phase, both grounded in the same
filesystem/AST walk the validate phase already did.

- **Responsibility**: rewrite every relative `.md` link target (with or
  without a `#fragment`) to its sibling `.html` target, automatically, with
  no special marker syntax required to make rewriting itself work; assign
  every heading its [anchor id](CONTEXT.md#term-anchor-id) — its own
  explicit Pandoc id when authored, else its [slug](CONTEXT.md#term-slug)
  via the documented pure function; when `--tree` (§02) is present, classify
  each rewritten link as [in-tree](CONTEXT.md#term-in-tree-link) by
  comparing its resolved `.md` path (fragment stripped) against the flag's
  path set.
- **Interface**: a link-rewrite pass and a heading-id pass, both operating
  on the Pandoc AST during the render phase; the identical id logic (explicit
  id else slugify) is also exported standalone so `#fragment` link
  resolution during validate can call it. Fragment resolution additionally
  indexes every raw HTML `id="..."` attribute found while walking the target
  document's AST, so an `<a id="...">` (or any other HTML element's `id`)
  resolves exactly like a heading anchor id. The link-rewrite pass
  additionally emits `class="richmd-intree-link"` on a rewritten `<a>` when
  `--tree` is present and the target matches — no class, and identical
  output to today, when `--tree` is absent.
- **Interacts with**: the [filter core](#03-filter-core)'s render phase;
  every [document](CONTEXT.md#term-document) a consumer's corpus links
  between.
- **Invariants held**: cross-document links always resolve, a heading's
  anchor id is deterministic, fragment resolution sees every authored anchor
  id (all §00).
- **Failure behavior**: a link target that fails to resolve to an existing
  source file was already caught at validate time (§00 invariant) — by
  render time this pass only rewrites and classifies, never discovers new
  failures. A `--tree` path that does not match any link in the document is
  not an error — silently unused, exactly like an unmatched glob would be.

## 08 Theme and diagram runtime {#08-theme-and-diagram-runtime}

**Owns the visual identity and how diagrams/charts actually become
pictures.** Two closely related concerns: the CSS asset, and how mermaid/
vega-lite source becomes a rendered visual in the reader's browser.

- **Responsibility**: inject one default stylesheet (built from
  `--richmd-*` CSS custom properties) into every
  [rendered page](CONTEXT.md#term-rendered-page); embed each mermaid/
  vega-lite block's raw source in a runtime-recognizable container
  (`<pre class="mermaid">` and equivalent) so the diagram renders
  client-side on page load, never at build time. A diagram's own colors
  are read from the page's live `--richmd-*` custom properties at render
  time (via `getComputedStyle`), never hardcoded — so a diagram matches
  whatever theme (default or a consumer's reskin) is active, and
  re-renders when the theme toggle (§00) flips light/dark, exactly like
  the surrounding page's own colors do. A [categorical
  palette](CONTEXT.md#term-categorical-palette) of six `--richmd-color-cat-*`
  tokens is read the same live way and injected as every Vega-Lite spec's
  default color range — chart-derived or hand-authored alike, since both
  reach the shared base config identically — with an author's own explicit
  `scale.range` still winning. See
  [ADR-0007](../adr/0007-shared-categorical-palette-for-vega-lite-specs.md#adr-0007).
- **Interface**: default mode emits CDN `<script>` tags for the mermaid.js
  and vega-lite runtimes; `--offline` (§02) downloads the pinned versions
  once and embeds them directly in the page instead. Container width is a
  per-document choice, authored as a YAML frontmatter key
  (`richmd-layout: narrow`, defaulting to `wide` when absent) — a
  data-heavy report reads better wide, a prose-heavy document can opt into
  the narrower reading column.
- **Interacts with**: the [filter core](#03-filter-core)'s render phase for
  injection; a consumer's own CSS file, which overrides `--richmd-*`
  variables or replaces the stylesheet wholesale to reskin.
- **Invariants held**: style is swappable (§00 principle P3) — the
  generator never hardcodes a visual identity, only the variable contract.
- **Failure behavior**: a diagram that fails to parse client-side (a gap the
  syntax-only validator missed, or a mermaid version mismatch between
  validate-time and the CDN-served runtime) fails visibly in the reader's
  browser console — not richmd's own failure surface, but a known seam
  worth naming.

:::info {title="CDN default, offline opt-in"}
The default [rendered page](CONTEXT.md#term-rendered-page) needs network
access to display diagrams and charts — an explicit, named trade-off, not a
silent one. See
[ADR-0004](../adr/0004-cdn-default-offline-bundling-opt-in.md#adr-0004).
:::

## 09 CI {#09-ci}

**Owns proving the gate on every push, not just on the author's machine.**
CI runs a strict superset of what [lefthook](https://github.com/lostbean/richmd/blob/main/lefthook.yml)
runs locally: every check lefthook's pre-commit hook runs (format, the design
gate), plus the slower checks a pre-commit hook can't afford to block a
commit on (the full test suite, the Nix build, the example-doc regression
checks, the theme-swap proof). A contributor's local "green" from lefthook is
never contradicted by CI — it just isn't the whole story until CI's own
slower checks have run too.

- **Responsibility**: run `nix flake check` (formatting plus any flake
  checks), the full test suite for every deep module (filter core, block
  kind registry, grammar validators, link resolver/slugifier, theme/diagram
  runtime), the design gate
  (`scripts/design-render --check` on every `design.md`,
  `scripts/layer-integrity .`), and the example-doc regression check
  (`examples/` — render the golden example, diff its output hash against
  the committed one; a mismatch fails the build, since output only changes
  on a deliberate markup/theme change, never silently) on every push and
  pull request.
- **Interface**: a GitHub Actions workflow, using the repo's own
  [flake.nix](https://github.com/lostbean/richmd/blob/main/flake.nix)
  devShell so CI's toolchain versions can never drift from a contributor's
  local `nix develop` shell.
- **Interacts with**: every component in §02–§08 (it runs their tests) and
  the design layer itself (it runs the design gate).
- **Invariants held**: none new — CI is the mechanism that keeps the
  fail-closed gate (§00) and schema-driven validation (§00) provably true on
  every change, not just locally.
- **Failure behavior**: any red check blocks a pull request from being
  considered mergeable; CI never soft-fails or skips a channel the local
  gate runs.

## 10 End-to-end walkthrough

**Scenario: an author renders a design document, then fixes a broken
diagram.**

1. An author edits `docs/design/design.md` in a consumer repo. It contains a
   callout, a cards grid, a mermaid flowchart, and a link to
   `CONTEXT.md#term-something`.
2. They run `richmd render docs/design/design.md`.
3. The CLI (§02) invokes Pandoc with richmd's Lua filter. The
   [filter core](#03-filter-core) resolves the document's
   [config directory](CONTEXT.md#term-config-directory), parses the document
   once, and enters the [validate phase](CONTEXT.md#term-validate-phase):
   every block is looked up in the [registry](#04-block-kind-registry); the
   mermaid block is shelled out to the
   [grammar validator](#06-grammar-validators); the `CONTEXT.md` link target
   is checked against the filesystem; finally any
   [cross-block rules](#05-cross-block-rules) found in the config directory
   run once over the full block list.
4. Zero errors collected. The gate (§01 diamond) admits the
   [render phase](CONTEXT.md#term-render-phase): the
   [link resolver](#07-link-resolver-and-slugifier) rewrites the `.md` link
   to `.html`, headings get their [slugs](CONTEXT.md#term-slug), the
   [theme](#08-theme-and-diagram-runtime) stylesheet and CDN script tags are
   injected.
5. `design.html` is written; the CLI exits 0.

**Second beat — the same document, but the mermaid block now has a typo in
an arrow syntax.**

6. The author reruns `richmd render docs/design/design.md`.
7. The [grammar validator](#06-grammar-validators) rejects the block;
   the [filter core](#03-filter-core) still finishes walking the rest of the
   document, collecting any further errors alongside it.
8. The validate phase's error list is non-empty. The gate blocks the render
   phase entirely — no `design.html` is written, not even a stale one.
9. The CLI exits 1, printing every collected error with its block's
   location and reason — the mermaid typo, named precisely, and nothing
   else silently wrong elsewhere in the same document.
