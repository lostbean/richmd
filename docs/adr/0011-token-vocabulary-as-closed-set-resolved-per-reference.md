# A token vocabulary is a closed set of members, and every reference resolves one member

<a id="adr-0011"></a>

Many document conventions carry a controlled vocabulary — a severity tag, a
citation key, a stability level — referenced from inline text and from block
attrs, whose members a consumer wants validated wherever they appear. Without
a mechanism, a consumer hardcodes the set inside a
[cross-block rule](../design/CONTEXT.md#term-cross-block-rule) and regexes over
a [block projection](../design/CONTEXT.md#term-block-projection)'s flattened
`body_text`, which cannot tell a real reference from the same characters in
prose and duplicates the set outside its own source of truth. We chose a
declarable [token vocabulary](../design/CONTEXT.md#term-token-vocabulary): a
JSON file in the [tokens directory](../design/CONTEXT.md#term-tokens-directory)
declaring a closed set of member keys with arbitrary consumer-owned
properties, which richmd recognizes, validates fail-closed, and resolves into
[resolved tokens](../design/CONTEXT.md#term-resolved-token) handed to rules.
richmd owns the mechanism and ships no vocabulary of its own — the set is the
consumer's, authored in the consumer's own source of truth.

## The shape of a reference

A [token reference](../design/CONTEXT.md#term-token-reference) is **singular**:
one inline code span (or one opted-in attr) resolving one member by exact key
lookup. Multiplicity is **repetition** — a heading citing two members writes
two spans, and the set is formed by collecting what the resolution pass found,
never by parsing a combination out of one reference.

We considered the originating proposal's `combinable` / `combinator` fields,
letting one reference carry a combination (`lens:state+composition`) that
richmd splits on a consumer-supplied delimiter and validates part-wise. We
rejected it: a consumer-supplied delimiter makes richmd own a parse it cannot
validate. The delimiter can collide with member names (a `c++` member under a
`+` combinator), forcing a precedence rule richmd must invent and document;
the delimiter's literal-vs-pattern treatment and whitespace tolerance become
knobs that accrete; degenerate inputs (`lens:modeling+`, `lens:+`) become new
error classes; and canonical ordering (whether `state+composition` and
`composition+state` are one reference) could only be settled by richmd reading
the consumer's own member properties — crossing the ownership line this
decision exists to hold. Repetition dissolves every one of those questions
rather than answering them, and costs the consumer nothing: combination
becomes the consumer's interpretation of the tokens richmd resolved, which is
where the meaning always lived. This also removes the combinatorial pressure
that would otherwise force a consumer to enumerate every combination as its
own member — six members express any arity by repetition.

We also rejected two further fields from the same proposal. A `name` field
duplicates the filename, which already keys the vocabulary exactly as
`.richmd/blocks/` keys a [block kind](../design/CONTEXT.md#term-block-kind) —
two sources for one fact is the drift this decision removes. A `references`
field (declaring where a reference may legally appear) is a placement rule,
and placement is already a
[cross-block rule](../design/CONTEXT.md#term-cross-block-rule)'s job — building
a second, weaker rules engine inside the token schema would carve an exception
where the general mechanism already applies.

## What richmd recognizes

Two surfaces, recognized two ways, because their ambiguity differs. An inline
code span is recognized **structurally** — its `<vocabulary>:<member>` shape is
self-announcing, so any code span matching a declared vocabulary's prefix is a
reference, wherever it sits, headings included. A block attr is recognized
**by declaration** — an attr's value is an ordinary string whose meaning is its
[block kind schema](../design/CONTEXT.md#term-block-kind-schema)'s to state, so
an attr is a reference only when its schema opts it into a vocabulary. The
alternative — treating any attr whose name matches a vocabulary as a reference —
would make an unrelated `lens=` attr silently token-validated, and would bind
vocabulary names to attr names across every consumer schema forever.

A reference inside a fenced code block is **not** recognized: that text is
another grammar's source, not richmd's. This holds the same line the
[directive lift](../design/CONTEXT.md#term-directive-lift) already holds when it
refuses to fire inside verbatim code, so the two passes agree about what
document text means. The `<vocabulary>:<member>` shape itself is richmd's own
fixed syntax, identical for every consumer — the one parse richmd does own, and
deliberately not a knob.
