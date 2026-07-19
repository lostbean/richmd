# Document-shell rendering is a consumer hook, structure-only, render-phase, singleton

<a id="adr-0014"></a>

A schema-projected consumer authors clean YAML frontmatter and wants richmd to
turn declared keys (an eyebrow, a lede, a colophon) into structured document
chrome, but the three existing consumer-declarable contracts — block schemas,
cross-block rules, token vocabularies — are all block- or inline-scoped and
none can read `doc.meta` or inject into the page shell, so those keys are inert
for rendering (issue #25). We add a fourth consumer contract, the
[document-shell hook](../design/CONTEXT.md#term-shell-hook): a single
`.richmd/shell/shell.lua` returning `{ masthead?, colophon? }`, each a function of
`doc.meta` returning structure-only Pandoc blocks that richmd prepends
(masthead) or appends (colophon) inside `.richmd-container`.

The contract is fixed by four decisions, each weighed against a live
alternative: it is a **new peer contract that generalizes**, not a fourth silo
— the existing hardcoded `richmd-layout` read is recognized as the first
built-in instance of "shape the shell from `doc.meta`" and moves under the same
[document shell](../design/CONTEXT.md#term-document-shell) component (§10), so
one component owns every `doc.meta`→shell path rather than leaving two
unrelated-looking readers; it returns **structure-only** Pandoc AST with
`richmd-*` classes, never raw styled HTML, so visual identity stays in the
[theme](../design/CONTEXT.md#term-theme) (P3) exactly as the
[token hook](../design/CONTEXT.md#term-token-hook) already does; it runs in the
**render phase**, cannot add validation errors, and a runtime error in it is a
hard filter failure naming `shell.lua` — a consumer that wants to _require_ a
frontmatter key writes a [cross-block rule](../design/CONTEXT.md#term-cross-block-rule)
(§05), which is what document-wide validation is already for; and it is a
**document singleton** — a second definition of the same region (two
`masthead`s) is a fatal load-time error, honoring the config directory's
"nearest wins, never a silent merge" rule rather than overriding by load order.

Considered and rejected: a fourth silo leaving `richmd-layout` untouched (keeps
two unrelated `doc.meta` readers, pays down no special case); overloading the
block contract with a document-scoped variant (conflates
[block](../design/CONTEXT.md#term-block) — a value-object content unit — with a
document-singleton role); a stringified-meta input (lossy — flattens inline
markup like a link inside an eyebrow, and diverges from how a block's
`render_fn` already sees raw AST); and raw-HTML-string output (punches through
P3).
