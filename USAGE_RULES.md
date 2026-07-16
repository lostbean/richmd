# richmd usage rules

A compact, accurate reference for authoring richmd documents and extending
richmd with your own block kinds. Written for both humans and coding
agents — every rule here is enforced by richmd's validator, not aspirational.

## The model

A richmd document is standard markdown plus a small set of **blocks**: a
fenced div (`::: {.kind attr=val}` ... `:::`) or a fenced code block
(` ```kind `). Every block has a **kind** that names its schema and
renderer. `richmd validate <file>` and `richmd render <file>` both run the
same two-phase pipeline: **validate** first (every block checked, every
error collected — never fails on just the first), **render** only if zero
errors were found. A `render` that fails writes **no output file at all**,
not a partial or stale one.

A fenced div's kind may be authored in **either** form, interchangeably:

- **Native (canonical) form** — `::: {.kind attr=val}`, the Pandoc-native
  fenced-div opener. This is richmd's documented canonical syntax.
- **Bareword form** — `:::kind {attr=val}`, the kind written directly after
  the colons, attrs in a following brace group (the markdown-it-container /
  remark-directive convention many consumers migrating to richmd already
  author).

richmd **normalizes the bareword form to native before validating**, so both
forms reach the identical validator, the identical schema, and produce the
identical errors — pick whichever you prefer per block. The colon count is
preserved (a `::::kind {…}` nested opener stays four colons), and the
normalization never touches directive syntax quoted inside a code fence as a
literal example (a `:::kind {…}` line inside a ` ``` ` block is left
verbatim, exactly as Pandoc reads it).

## Fenced div vs. fenced code block — read this before authoring a new kind

This distinction is load-bearing and easy to get wrong:

- **A fenced div's class is always a kind attempt.** `::: {.kind}` is
  richmd's primary authoring syntax — if `kind` isn't registered, this is a
  validation error (`unknown block kind`), not a silent pass-through. The
  bareword form is held to the identical rule: an unknown _bareword_ kind
  (`:::notakind {…}`) is likewise a loud `unknown block kind` validation
  error, never silent prose — richmd normalizes it to native form before
  validating precisely so it can never slip past as ordinary text.
- **A fenced code block's class is a syntax-highlighting language by
  convention, not a kind attempt.** ` ```js `, ` ```python `, ` ```bash ` —
  ordinary code samples are never touched or validated as richmd blocks.
  richmd only treats a fenced code block as one of its own blocks when the
  class is a kind it explicitly recognizes (`mermaid`, `vega-lite`, or a
  consumer-registered code-block kind). An unrecognized code-block class is
  always ordinary code.

Plain, unclassed markdown (headings, paragraphs, unclassed code fences) is
never touched or validated — richmd only ever looks at classed divs and
classed code blocks.

## The block vocabulary

### `callout` (fenced div)

```
::: {.callout tint="warning" title="Heads up"}
Rebuilding this index takes about ten minutes.
:::
```

| Attr    | Required | Type   | Allowed values              |
| ------- | -------- | ------ | --------------------------- |
| `tint`  | no       | enum   | `info`, `warning`, `danger` |
| `title` | no       | string |                             |

Body: **required**.

### `cards` (fenced div)

The workhorse enumeration block — items are `###` headings inside the div.
Each card's title heading may optionally carry its own `badge`,
`badge-tint`, and `meta` attrs — visual metadata rendered beside the title,
never a substitute for the title text itself.

```
::: {.cards cols="3"}

### First card {badge="ingest" badge-tint="info" meta="owns: validation"}

Body text.

### Second card

Body text.
:::
```

| Attr   | Required | Type | Allowed values   |
| ------ | -------- | ---- | ---------------- |
| `cols` | no       | enum | `2`, `3`, `4`    |
| `size` | no       | enum | `sm`, `md`, `lg` |

Body: **required**.

Per-card heading attrs (all optional, independent of each other and of the
div's own `cols`/`size`):

| Attr         | Required | Type   | Allowed values                                                         |
| ------------ | -------- | ------ | ---------------------------------------------------------------------- |
| `badge`      | no       | string | free text, rendered as a small pill                                    |
| `badge-tint` | no       | enum   | `accent`, `accent2`, `info`, `warning`, `danger`, `neutral`, `outline` |
| `meta`       | no       | string | free text, rendered alongside the badge                                |

Omitting all three renders a card byte-for-byte identical to one authored
before these attrs existed.

### `stat-tile` (fenced div)

KPI-style number-plus-label. No body content — the tile's content comes
entirely from its attrs.

```
::: {.stat-tile value="42" label="widgets shipped" delta="↑ 12% vs last wk" dir="up"}
:::
```

| Attr    | Required | Type   | Allowed values                       |
| ------- | -------- | ------ | ------------------------------------ |
| `value` | yes      | string |                                      |
| `label` | yes      | string |                                      |
| `delta` | no       | string | free-form trend text, e.g. `"↑ 12%"` |
| `dir`   | no       | enum   | `up`, `down`                         |

Body: **forbidden**.

### `stat-grid` (fenced div)

Groups sibling `stat-tile`s into one shared row — the body is a run of
nested `stat-tile` divs (a longer colon-run on the outer fence than the
inner one), not free content.

```
::: {.stat-grid cols="4"}
:::: {.stat-tile value="99.97%" label="uptime"}
::::

:::: {.stat-tile value="142ms" label="p50 latency"}
::::
:::
```

| Attr   | Required | Type | Allowed values |
| ------ | -------- | ---- | -------------- |
| `cols` | no       | enum | `2`, `3`, `4`  |

Body: **required** — nested `stat-tile` divs; each one validates and
renders independently before the grid wraps them.

### `toc` (fenced div)

Auto-generated from the document's own headings — written empty. `richmd`
re-parses the source document to build the list, so it always matches the
real rendered heading ids (the same slug function is used for both).

```
::: {.toc max-depth="2" title="On this page"}
:::
```

| Attr        | Required | Type   | Meaning                                                     |
| ----------- | -------- | ------ | ----------------------------------------------------------- |
| `max-depth` | no       | string | heading levels to include (1–6); omit for all levels        |
| `title`     | no       | string | the label rendered above the list; defaults to `"Contents"` |

Body: **forbidden**.

### `labeled-block` (fenced div)

Mirrors this framework's own goal/invariant/principle-style typed
statements. The `type` attr is a free string — richmd has no opinion on
your vocabulary (`goal`, `invariant`, `decision`, whatever fits your
document).

```
::: {.labeled-block type="goal"}
**Ship the thing**

Get the feature out the door with clear scope.
:::
```

| Attr   | Required | Type   |
| ------ | -------- | ------ |
| `type` | yes      | string |

Body: **required** — conventionally a bold label line followed by prose.

### `embedded-svg` (fenced div)

Inlines a sibling `.svg` file's actual markup (a real `<svg>` element
spliced into the page, never an `<img src="...">` reference) — stylable via
CSS, inspectable in the page's own DOM. The `file` path is resolved
relative to the **current document's own directory**. A missing file is a
validation error naming the path; `richmd validate` catches it before
`richmd render` would ever need to.

```
::: {.embedded-svg file="diagram.svg" caption="Request flow, high level"}
:::
```

| Attr      | Required | Type   |
| --------- | -------- | ------ |
| `file`    | yes      | string |
| `caption` | no       | string |

Body: **forbidden**. With `caption` present, the SVG is wrapped in a real
`<figure>`/`<figcaption>` pair; omitting it renders exactly as before the
attr existed — a bare div, no `<figure>` wrapper at all.

### `mermaid` (fenced code block)

Real grammar validation (not just "is this valid JSON") via mermaid's own
parser — no browser, no Puppeteer. Renders **client-side**: the raw source
is embedded and a script tag loads the mermaid.js runtime, which draws the
diagram when the page opens. Default mode references the runtime from a
CDN (the page needs network access to display the diagram); `--offline`
embeds the runtime directly instead.

````
```{.mermaid title="Request flow"}
graph TD
    A[Start] --> B{Is it?}
    B -->|Yes| C[OK]
    B -->|No| D[End]
```
````

| Attr    | Required | Type   |
| ------- | -------- | ------ |
| `title` | no       | string |

Body: **required** — must be syntactically valid mermaid source. A
malformed diagram fails validation with the parser's own line/column error,
not a generic message. `title`, when present, renders above the diagram
inside the shared diagram panel. If a diagram's source is valid at build
time but still fails to render in the browser (a render-time error the
syntax-only build-time check cannot catch), richmd shows the raw diagram
source instead of blank space, with the error logged to the browser
console.

### `vega-lite` (fenced code block)

Real JSON-schema validation against vega-lite's own published schema (via
`ajv`, no browser dependency). Renders client-side via CDN-loaded
vega/vega-lite/vega-embed. Two distinct failure modes are reported: invalid
JSON vs. valid JSON that doesn't conform to the vega-lite schema.

````
```{.vega-lite title="Widgets by category"}
{
  "mark": "bar",
  "data": { "values": [{ "a": "A", "b": 28 }] },
  "encoding": {
    "x": { "field": "a" },
    "y": { "field": "b" }
  }
}
```
````

| Attr    | Required | Type   |
| ------- | -------- | ------ |
| `title` | no       | string |

Body: **required** — must be valid JSON conforming to the vega-lite schema.
`title`, when present, renders above the chart inside the shared diagram
panel (same as mermaid's `title`). `--offline` embeds the
vega/vega-lite/vega-embed runtimes directly in the page, the same as
mermaid's own runtime; the default CDN mode works for both.

### `chart` (fenced div)

A terser convenience over `vega-lite` for the common case: a two-column
markdown table expands into a bar, line, or pie chart, rendered through the
exact same client-side vega-embed runtime a hand-authored `vega-lite` block
uses (same CDN/`--offline` behavior, same theming).

```
::: {.chart type="bar"}

| Month | Incidents |
| ----- | --------- |
| Apr   | 1         |
| May   | 1         |
| Jun   | 4         |

:::
```

| Attr   | Required | Type   | Allowed values            |
| ------ | -------- | ------ | ------------------------- |
| `type` | yes      | enum   | `bar`, `line`, `pie`      |
| `x`    | no       | string | must name a header column |
| `y`    | no       | string | must name a header column |

Body: **required** — a markdown table. The first column binds to the
x/category encoding and the second to the y/value encoding **by position**;
a table with more than two columns requires explicit `x=`/`y=` attrs naming
the header columns to use, since position alone becomes ambiguous — richmd
never guesses or silently truncates to the first two columns. For `pie`,
the first column becomes the slice color/category and the second becomes
the slice size (`theta`). For `bar`/`line`, x-axis category labels render
horizontally by default rather than auto-rotating aggressively; Vega-Lite
still rotates them when they genuinely don't fit.

Every mark type (`bar`, `line`, `pie`) carries a color channel keyed to the
category column, so each category renders in a distinct color from
richmd's theme-aware categorical palette (the six `--richmd-color-cat-1`
through `-6` tokens, read live from the active theme); the palette cycles
if a table has more than 6 categories. The legend stays visible for all
three mark types — it is not hidden, even though it is redundant with
`bar`/`line`'s own x-axis category labels.

Failure cases, all reported at validate time:

- Fewer than 2 columns: `"table has N column(s); a chart block needs at
least 2 (x and y)"`.
- More than 2 columns with `x=`/`y=` missing or empty: the ambiguity error
  above, naming ADR-0006.
- An `x=`/`y=` value that doesn't match any table header column: `"attr 'x'
names column '...', which does not match any table header column"` (same
  for `y`).
- The expanded vega-lite spec is also run back through the same JSON-schema
  check hand-authored `vega-lite` blocks use — a second, vega-lite-flavored
  error is possible even after the column binding itself resolves cleanly.

## Cross-document links and heading anchors

Every relative link ending in `.md` (with or without a `#fragment`) is
automatically rewritten to its sibling `.html` target at render time — no
special syntax needed:

```
See [the glossary](CONTEXT.md#term-block) for the full definition.
```

- A `.md` target that doesn't exist on disk is a validation error.
- A `#fragment` that doesn't match any anchor id in the target document is
  **also** a validation error. An anchor id comes from either of two
  sources, both checked:
  - **A heading's id** — its own explicit `{#id}` when authored
    (`### Heading {#term-x}`), else its slug (computed via the documented
    slug function).
  - **A raw HTML `id="..."` attribute**, on any element, anywhere in the
    document — `<a id="adr-1"></a>`, `<span id="...">`, `<div id="...">`,
    etc. richmd does not distinguish an explicit heading id from an HTML
    id when validating a link; both are equally an author's explicit,
    stable anchor.
- Non-`.md` targets (external URLs, images) are never touched.

A heading's actual rendered `id` follows the same rule used to validate
`#fragment` links against it: its own explicit `{#id}` when authored, else
its slug, assigned by one documented, pure function (GitHub-flavored rules:
lowercase, punctuation stripped except hyphens, spaces to hyphens,
duplicate headings suffixed `-1`, `-2`, ...). The identical logic backs
both the id a heading actually receives and the set of ids `#fragment`
resolution checks against, so headings and links can never disagree.

### Marking links as "in-tree" with `--tree`

`richmd render <file> --tree=<path>` is a repeatable flag (literal `.md`
paths only — richmd does no glob expansion; expand globs in your shell or
caller before passing them). Any cross-document link whose resolved `.md`
target (fragment stripped) matches one of the given paths gets
`class="richmd-intree-link"` added to its rendered `<a>` tag — with **zero
default styling**, so a consumer's own theme decides what "in-tree" should
look like. Omitting `--tree` entirely produces byte-identical output to
every prior release: the class is never present unless you ask for it.

**richmd still renders exactly one document per invocation — always.**
`--tree` doesn't make it read, walk, or render any file beyond the one you
gave it; it only compares that one document's own link targets, as plain
strings, against the path set you passed. richmd never opens the files
named in `--tree` — it doesn't know or care whether they exist, what they
contain, or whether they're part of any "tree" in reality. That's just the
name of the list you handed it.

Rendering a whole tree of documents with consistent in-tree/out-of-tree
link marking is entirely the caller's job: invoke `richmd render` once per
file in the tree, passing the **same, full `--tree=<path>` list** (every
in-tree path, not just the ones the current file links to) on every single
call. The recursion — deciding which files make up the tree, looping over
them, invoking richmd once per file — is 100% your responsibility; richmd
supplies only the per-link classification primitive, once per document,
every time you ask.

## Extending: your own block kinds

Add a kind without forking richmd's own source. Drop a schema/renderer
pair into `.richmd/blocks/`, inside your document's **config directory**
(see "Config directory discovery" below for exactly which directory that
is):

```
.richmd/blocks/highlight.schema.json
.richmd/blocks/highlight.lua
```

`highlight.schema.json`:

```json
{
  "kind": "highlight",
  "attrs": {},
  "body": "required"
}
```

`highlight.lua`:

```lua
return {
  render = function(block, resolved_attrs)
    return pandoc.Div(block.content, pandoc.Attr("", {"my-highlight"}))
  end
}
```

The schema's `attrs`/`body` shape is identical to every built-in kind's
(see the vocabulary above). The schema's `"kind"` field must match the
filename it's loaded from (`highlight.schema.json` must declare
`"kind": "highlight"`) — a mismatch is also a fatal, load-time error. The
Lua file may return either `{ render = fn }` or a bare `render` function
directly. Your kind then validates and renders through the exact same
generic pipeline as `callout` or `mermaid` — richmd's own filter code never
special-cases it. A malformed schema file (bad JSON, missing a required
field, or a kind/filename mismatch) is a **fatal, load-time** error naming
the offending file — richmd refuses to run at all rather than silently
skipping a broken extension.

### Config directory discovery

richmd resolves `.richmd/blocks/` inside a **config directory** it finds by
walking upward from the document's own directory — it does not assume
`.richmd/` lives next to the document itself. This lets a group of
documents nested under a shared directory (e.g. several
`docs/design/<context>/*.md` files) point at one common
`docs/design/.richmd/` instead of each needing its own copy.

The walk, starting at the document's own directory and checking it first:

1. If the directory being checked contains a `.richmd/` subdirectory, that
   directory is the config directory — the walk stops immediately.
   **Nearest wins**: richmd never merges kinds from more than one
   `.richmd/` found along the way.
2. Otherwise, if the directory being checked contains a `.git`
   subdirectory (the repository root), the walk stops there — that
   directory's own `.richmd/` was already checked in step 1 and was
   absent, so richmd falls back to the **document's own directory**
   (not the `.git` directory).
3. Otherwise, richmd moves up to the parent directory and repeats. If an
   ancestor directory can't be read (a permission error), the walk stops
   there too, exactly as if a `.git` boundary had been reached.

A project with no `.git` directory anywhere above the document, and no
`.richmd/` anywhere along the walk, falls back to the document's own
directory — identical to richmd's behavior before this discovery existed.

Every `render` and `validate` invocation prints the resolved config
directory to stderr, so which `.richmd/` a given call actually used is
never a silent fact:

```
richmd: config directory resolved to '/path/to/docs/design'
```

(That directory's `.richmd/blocks/`, `.richmd/rules/`, etc. — not the
`.richmd` path itself — is what gets resolved and loaded.)

## Cross-block rules: your own document-wide checks

Per-block validation (the schema each kind above already enforces) can't
express a rule that spans more than one block — ordering, cardinality, a
required cross-link, a document-wide enum. Drop a `.lua` file into
`.richmd/rules/`, inside your document's config directory (same discovery
as `.richmd/blocks/` above):

```
.richmd/rules/at-most-one-callout.lua
```

```lua
return {
  check = function(block_projections, add_error)
    local count = 0
    for _, bp in ipairs(block_projections) do
      if bp.kind == "callout" then
        count = count + 1
        if count > 1 then
          add_error(
            "rule:at-most-one-callout",
            bp.location,
            "at most one callout block is allowed per document"
          )
        end
      end
    end
  end,
}
```

Given a document with two `callout` blocks, this produces:

```
richmd: [rule:at-most-one-callout] div.callout: at most one callout block is allowed per document
```

A rule runs once per document, after every per-block, link, grammar, and
token resolution check has already run — regardless of whether those checks
found errors — against the document's full **block projection** list: one
`{ kind, attrs, location, body_text, tokens }` entry per recognized block,
in document order, frozen at the moment the list is built (never a live
reference into the Pandoc AST). `kind` is the block's kind name (e.g.
`"callout"`); `attrs` is a plain table of its resolved attributes;
`location` is the same `"div.<kind>"` / `"codeblock.<kind>"` string a
per-block error already uses; `body_text` is the block's content flattened
to plain text; `tokens` is the list of resolved token vocabulary references
found within the block (see "Token vocabularies" below — always a list,
empty when the block has none, so it never needs a nil check). A rule can
assume every projection it receives already passed its own block kind
schema.

The Lua file returns either `{ check = function(block_projections,
add_error) ... end }` or a bare `check` function directly — same two
accepted shapes as a `.richmd/blocks/*.lua` render function. `add_error` is
the exact same error-collecting function per-block checks call into, so a
rule's violations land in the identical list, contributing to the same
fail-closed gate. A rule reports its own errors with itself as the
source — always call `add_error` with `"rule:<filename-without-.lua>"` as
the first argument (e.g. `"rule:at-most-one-callout"` for
`at-most-one-callout.lua`). The `rule:` prefix means a rule file can share
a name with a block kind (a rule file literally named `callout.lua` reports
`[rule:callout]`) without its errors ever being confused with a genuine
`callout` block's `[callout]` errors.

A malformed rule file (bad Lua syntax, or a loaded value that is neither a
function nor a table with a `check` function field) is a **fatal,
load-time** error naming the offending file — richmd refuses to run at all,
identical to a malformed `.richmd/blocks/` extension. A rule's `check`
function itself raising a Lua runtime error partway through is also a hard
failure (non-zero exit, no HTML) — but every error already collected
before the crash (from an earlier per-block check, or an earlier rule) is
still printed, and the crash itself is reported naming the crashing rule
(not a block location), since the failure is document-wide.

## Token vocabularies: your own closed set of terms

A **token vocabulary** is a closed set of terms you declare once and then
cite from your documents — an architecture's lenses, a status ladder, a team
roster. richmd checks that every citation names a term you actually
declared, and carries that term's properties through to your cross-block
rules. richmd owns the mechanism; **the set is always yours — richmd ships
no vocabulary of its own**, and every example below is a hypothetical one a
consumer might declare.

### Declaring a vocabulary

Drop a `.json` file into `.richmd/tokens/`, inside your document's config
directory (same discovery as `.richmd/blocks/` above):

```
.richmd/tokens/lens.json
```

**The filename is the vocabulary name.** `lens.json` declares the
vocabulary `lens`; there is no `"name"` field to keep in sync with it.

A vocabulary declares exactly one field, `members` — a map of member key to
that member's properties:

```json
{
  "members": {
    "modeling": { "order": 0, "label": "Modeling", "primary": true },
    "state": { "order": 1, "label": "State", "primary": true },
    "composition": { "order": 2, "label": "Composition" }
  }
}
```

The properties object is **arbitrary and entirely yours**. `order`, `label`
and `primary` above are not richmd concepts — they are one hypothetical
consumer's. Put whatever you want in there; richmd carries it through
without ever reading it.

### Referencing a member

Two surfaces, recognized two different ways.

**An inline code span** whose text reads `<vocabulary>:<member>` is a
reference wherever it appears — including in a heading, since a heading's
code span is an ordinary code span:

```markdown
## Data flow `lens:modeling`

This section is mostly `lens:state` work.
```

**A block attr** is a reference only when its block kind's schema opts it in
with a `tokens` field naming the vocabulary:

```json
{
  "kind": "lens-card",
  "attrs": {
    "lens": { "required": true, "tokens": "lens" }
  },
  "body": "required"
}
```

```markdown
::: {.lens-card lens="modeling"}
Card body.
:::
```

An opted-in attr holds **exactly one member**, and holds the bare member key
— not the `<vocabulary>:<member>` shape a code span uses. The schema already
names the vocabulary, so repeating it in the value would just be a second
fact the two could disagree about.

### The rules that will surprise you

- **A reference is singular. There is no combinator.** richmd never splits a
  reference on any delimiter. `` `lens:a+b` `` is **one** lookup of a member
  literally keyed `a+b` — it fails closed unless you declared that exact
  key, even if `a` and `b` are both members. **Multiplicity is repetition**:
  to cite two members, write two spans (`` `lens:modeling` `lens:state` ``).
  What a combination _means_ — whether a pair renders as one pill, whether
  its order is canonical, whether it's even legal — is yours to decide in a
  rule, from properties richmd carried but never read.
- **Fenced code blocks are never scanned.** A `lens:modeling` inside a
  ` ```js ` block is that grammar's source text, not a reference.
- **A span naming an undeclared vocabulary is ordinary prose, not an
  error.** `` `foo:bar` `` with no `foo.json` renders as plain code. richmd
  recognizes references only for vocabularies you actually declared —
  otherwise every colon in every code span in every document would become
  richmd's business.
- **An attr is a reference only when its schema opts it in — never inferred
  from its name.** An attr literally named `lens` on a schema without a
  `tokens` field is an ordinary string attr, untouched.
- **A schema opting into a _missing_ vocabulary IS an error** — the exact
  opposite of the span case above. The asymmetry is deliberate: a span's
  prefix is a **coincidence of text** (it may well be prose that happens to
  contain a colon), whereas a schema's `tokens` field is a **deliberate
  declaration** — the only way it can name a vocabulary that doesn't exist
  is if something is broken.
- **richmd validates membership and never interprets a property.**
  Properties are opaque payload, carried through untouched. In particular
  richmd never sorts, groups, or dedupes tokens by any property — an
  `order` property is meaningless to richmd. Tokens arrive in **document
  order**, and the same member cited twice arrives twice.

### Reading tokens from a rule

Every resolved token found within a block arrives on that block's projection
as `tokens`, from **both** surfaces above — the block's own opted-in attrs
first, then the spans in its body, in document order. Each entry is a flat
`{ vocabulary, member, properties, location }`:

```lua
-- .richmd/rules/lens-cards-are-labeled.lua
-- Every lens-card must cite a lens whose properties mark it as a primary
-- lens. Reads `properties` DIRECTLY — no membership re-check, no scanning
-- body_text for a reference.
return {
  check = function(block_projections, add_error)
    for _, bp in ipairs(block_projections) do
      if bp.kind == "lens-card" then
        local has_primary = false
        for _, tok in ipairs(bp.tokens) do
          if tok.vocabulary == "lens" and tok.properties.primary then
            has_primary = true
          end
        end
        if not has_primary then
          add_error(
            "rule:lens-cards-are-labeled",
            bp.location,
            "a lens-card must cite at least one primary lens"
          )
        end
      end
    end
  end,
}
```

A rule can assume every token it receives **already names a declared
member** — richmd resolved it before the rule ran, and an unknown member
already failed the document. So a rule reads `properties` directly and never
re-checks membership.

Two things worth knowing about what lands in `tokens`:

- A reference **outside any recognized block** — in a plain paragraph or a
  top-level heading — is still validated, but belongs to no block, so it
  appears in no projection's `tokens`.
- A reference inside a **nested** block appears on both the inner and the
  outer block's `tokens`, because it is genuinely within both — the same
  containment `body_text` already reports.

### Failure behavior

- A reference naming a declared vocabulary but an **undeclared member** is
  an ordinary validation error at the reference's location, naming both:

  ```
  richmd: [token:lens] code.lens: unknown member 'bogus' in token vocabulary 'lens'
  ```

  From an opted-in attr, the same failure is reported against the block's
  own kind, exactly like a bad enum value:

  ```
  richmd: [lens-card] div.lens-card: attr 'lens' has unknown member 'bogus' in token vocabulary 'lens'
  ```

  Either way it fails closed, and an unknown member never stops richmd from
  collecting the rest of the document's errors.

- A **malformed vocabulary file** (bad JSON, or a missing or non-map
  `members` field) is a **fatal, load-time** error naming the offending
  file — richmd refuses to run at all, identical to a malformed
  `.richmd/blocks/` or `.richmd/rules/` file. A broken vocabulary is never
  silently skipped.

## Failure behavior

Every validation error is reported as:

```
richmd: [<kind>] <location>: <reason>
```

All errors in a document are collected and printed together — richmd never
stops at the first one. A document that fails validation produces **zero**
output; a stale or partial `.html` file is never left behind.

## Checking a committed .html is fresh (--check)

`richmd render <file> --check` proves, without writing anything, that an
already-committed sibling `.html` file still matches what richmd would
generate right now — built for CI that wants to catch a committed `.html`
that's stale or was hand-edited, without letting the CI run itself
overwrite the committed file.

`--check` changes only the write step, never what gets generated: it runs
the exact same validate-then-render pipeline as a normal `render`, honoring
every other flag on the same invocation (`--offline`, `--tree=<path>...`)
exactly as it would shape a normal write. The generated HTML is captured in
memory instead of being written, then byte-compared against the existing
sibling `.html` file:

- **Validation fails**: identical to `render` without `--check` — non-zero
  exit, errors printed, nothing written and nothing compared. Checking
  freshness of a document that doesn't even validate is meaningless.
- **The sibling `.html` doesn't exist yet**: non-zero exit, a message
  stating the file is missing.
- **Byte-identical**: exit 0.
- **Different**: non-zero exit, with a textual diff (enough for a CI log
  reader to see what changed, not a sophisticated visual diff).

In every case, `--check` never writes the sibling `.html` path — not on
success, not on failure, not partially.

`--check` proves freshness against **one specific, named invocation** —
whatever flags you pass to `--check` must match the flags the committed
file was actually generated with. A non-`--offline` `--check` against an
`--offline`-committed file (or one committed with a different `--tree`
list) correctly reports the file as stale for that reason — a real
difference in how the file was produced, not a bug. Pin the flag
combination your CI uses for `--check` to the same one your commit step
uses.

```
richmd render report.md --check
richmd render report.md --check --offline
richmd render report.md --check --tree=architecture.md --tree=glossary.md
```
