# The embedded-svg block takes one of two sources — a `file=` attr or a nested ` ```svg ` code fence — never a bare inline body

<a id="adr-0017"></a>

The [embedded-svg](../design/design.md#04-block-kind-registry) block originally
required a `file=` attr and read a sibling `.svg` file, so a self-contained
document with a small one-off figure was impossible — every figure had to be a
second on-disk artifact. Widening the block to accept inline SVG markup raises a
capture-fidelity problem: Pandoc parses a bare `<svg>…</svg>` written directly
in a `:::svg` fenced div into fragmented, interpreted AST — the open/close tags
become separate `RawBlock`s, inner elements become `RawInline`s, and text
content is decoded (`&amp;` → `&`) with whitespace turned into `Space`/`SoftBreak`
nodes. Reconstructing the original SVG source from that AST is lossy: entity
forms, indentation, and any XML declaration do not survive the round-trip, so a
byte-stable `render --check` could not be guaranteed.

The block accepts exactly one of two sources, enforced by its custom
`validate` hook (the same cross-field mechanism mermaid uses for grammar
checks — the generic `required`/`optional`/`forbidden` body enum cannot express
a rule that depends on another field): **(1)** a `file=` attr, read from the
current document's directory exactly as before; or **(2)** a single nested
` ```svg ` code fence inside the `:::svg` div, whose body Pandoc preserves as one
`CodeBlock` with byte-faithful `.text` (verified: `&amp;` and indentation survive
intact). Neither source present is a "no source" validation error; both present
is a "two sources" error. A caption is carried by the `caption=` attr in both
modes — the body is never a caption. Both modes render inside the same
`.richmd-embedded-svg` container, so the theme is unchanged.

Considered and rejected: a **bare inline `<svg>` body** in the div (the
fragmented, lossy AST above — no fidelity guarantee); **reconstructing** the SVG
by re-serializing the div's inline AST (fragile — re-escaping and whitespace
mapping ship subtle mismatches); and a **top-level ` ```svg ` fence** with no
`:::svg` wrapper (indistinguishable from an ordinary code-display block, losing
the figure semantics and the `.richmd-embedded-svg` sizing). Nesting the fence
inside the div keeps byte-faithful capture while marking the block as an
embedded figure, not displayed source.
