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

## Fenced div vs. fenced code block — read this before authoring a new kind

This distinction is load-bearing and easy to get wrong:

- **A fenced div's class is always a kind attempt.** `::: {.kind}` is
  richmd's primary authoring syntax — if `kind` isn't registered, this is a
  validation error (`unknown block kind`), not a silent pass-through.
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
inside the shared diagram panel.

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
the slice size (`theta`).

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
- A `#fragment` that doesn't match any heading in the target document is
  **also** a validation error (checked against the target document's own
  headings, computed via the same slug function used to assign ids).
- Non-`.md` targets (external URLs, images) are never touched.

Heading ids are assigned by one documented, pure function (GitHub-flavored
rules: lowercase, punctuation stripped except hyphens, spaces to hyphens,
duplicate headings suffixed `-1`, `-2`, ...). The same function resolves
every `#fragment` link, so headings and links can never disagree.

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
pair into `.richmd/blocks/` (relative to your document's own directory):

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

## Failure behavior

Every validation error is reported as:

```
richmd: [<kind>] <location>: <reason>
```

All errors in a document are collected and printed together — richmd never
stops at the first one. A document that fails validation produces **zero**
output; a stale or partial `.html` file is never left behind.
