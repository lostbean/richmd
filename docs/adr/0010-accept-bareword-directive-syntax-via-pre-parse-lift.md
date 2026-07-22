# Accept the bareword directive form `:::kind {attrs}` (or `::: kind {attrs}`) via a pre-parse text lift, not only Pandoc-native `::: {.kind}`

<a id="adr-0010"></a>

Pandoc's markdown reader recognizes a bareword-class fenced div
(`:::goal`) only while no attribute group follows; the moment a `{…}` group
appears (`:::invariant {enforcement=convention}` or `::: invariant {enforcement=convention}` — the widely-used
markdown-it-container / remark-directive form) Pandoc parses the line as a
plain `Para` beginning `Str ":::invariant"`, not a `Div`. Such a block reaches
neither per-block validation nor the cross-block
[block projection](../design/CONTEXT.md#term-block-projection): it is silently
seen as prose, so `richmd validate` reports zero errors for blocks it never
examined — a false-green, the failure mode the
["fail loud, local, and early" principle](../design/design.md#00-foundation)
exists to prevent. We considered detecting the bareword-attr line in prose and
raising a hard error (keep the native form as the only syntax), against lifting
the bareword form into native form before Pandoc parses. We chose the lift: it
is strictly less code (a text transform ahead of the existing single parse
versus a new prose-scanning heuristic, a new error kind, and its own
false-positive guard), it accepts the ecosystem form richmd consumers migrating
from markdown-it/remark already author, and every lifted block flows through
the exact same Div path, validation, error format, and projection the native
form already uses — no new filter logic. The transform is **text-level and runs
before Pandoc** (a Lua filter runs after the parse, by which point the block is
already a `Para` — too late), it is **fence-aware** (it never rewrites inside a
` ``` `/`~~~` fenced code block, matching Pandoc's own verbatim treatment so the
transform and the parse can never disagree on the same line, and protecting the
directive syntax richmd's own docs quote as literal examples), it **preserves
the fence's colon count** at any nesting depth (`::::stat-tile {x}` →
`:::: {.stat-tile x}`, never collapsed to three, so nested blocks still
balance), and it leaves the attrless `:::kind` form untouched (already a Div).
A consequence folds in for free: a bareword-attr line naming an unregistered
kind becomes a real Div with an unknown class, which the
[registry](../design/design.md#04-block-kind-registry) already reports as a
[validation error](../design/CONTEXT.md#term-validation-error) — the former
silent-prose escape becomes a loud, local error. Both forms are accepted and
interchangeable; the native form remains richmd's documented canonical syntax.
