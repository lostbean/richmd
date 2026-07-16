# A token reference is addressing, not prose: it never enters a heading's slug and renders as a styling hook

<a id="adr-0012"></a>

A [token reference](../design/CONTEXT.md#term-token-reference) in a heading
was, until this decision, ordinary text to everything downstream of
validation. Two consequences followed, both wrong. Its characters entered the
heading's [slug](../design/CONTEXT.md#term-slug) — `## Invariants
` + "`lens:invariants`" + ` ` + "`lens:robustness`" + ` ` yielded the anchor
`#invariants-lensinvariants-lensrobustness`, so **tagging a heading renamed
its anchor and broke every link to it**. And the reference rendered as an
inert `<code>lens:state</code>`, so a vocabulary richmd had just validated
could not show on the page at all: a consumer wanting a styled tag had to
hardcode its member set a second time in a renderer, which is the duplication
[ADR-0011](0011-token-vocabulary-as-closed-set-resolved-per-reference.md#adr-0011)
exists to remove.

We chose to treat a recognized reference as **addressing rather than prose**,
throughout. It contributes nothing to a heading's slug, so a heading keeps the
anchor it had before it was tagged; and it renders as a styling hook, not as
its own literal text.

## The exclusion is exactly what richmd recognizes

We considered excluding every `Code` inline from a heading's slug — simpler to
state, and it needs no vocabulary lookup. We rejected it: `## Uses `+"`code`"+`
in prose` would silently change its anchor from `uses-code-in-prose` to
`uses-in-prose`, a regression on documents that declare no vocabulary at all.
The rule is therefore narrow by construction: **only a span richmd resolves
against a declared vocabulary is excluded.** An ordinary code span is prose. A
span naming an undeclared vocabulary is prose, exactly as
[ADR-0011](0011-token-vocabulary-as-closed-set-resolved-per-reference.md#adr-0011)
already holds. A document with no
[tokens directory](../design/CONTEXT.md#term-tokens-directory) sees no change
whatsoever — the exclusion set is empty.

This is the one place richmd's own recognition changes what a heading's anchor
is, which is why it is stated as an amendment to the
[deterministic anchor invariant](../design/design.md#00-foundation) rather than
left as an implementation detail. The alternative — leaving the anchor polluted
— makes a lens tag and a stable anchor mutually exclusive, and a consumer must
then choose between tagging a section and linking to it.

## The hook carries no properties

A recognized reference renders as its member's text carrying a
`richmd-token` class plus the vocabulary and member as data attributes:
`<code class="richmd-token" data-vocabulary="lens" data-member="state">state</code>`.
The vocabulary prefix is addressing, so it leaves the reader's text; the member
stays, because that is what the reference says.

We considered also emitting each member's properties as data attributes, so a
vocabulary could supply rendered content (a `label` as the visible text, a
`color` as the pill's fill). We rejected it on two counts. It would make richmd
read a property's meaning, the exact line
[ADR-0011](0011-token-vocabulary-as-closed-set-resolved-per-reference.md#adr-0011)
draws — properties are the consumer's, carried and never interpreted. And a
`color` property painting the page would put visual identity in a consumer's
JSON file where no `--richmd-*` variable and no
[theme](../design/CONTEXT.md#term-theme) could override it, contradicting
[principle P3](../design/design.md#00-foundation) and repeating the mistake
[ADR-0007](0007-shared-categorical-palette-for-vega-lite-specs.md#adr-0007)
avoided for chart palettes by reading live theme properties instead. The hook
is the whole mechanism: richmd emits structure and says which member this is,
the consumer's stylesheet decides what that looks like, and a reskin still
works. What a member means stays where every other property already lives — the
consumer's CSS, and their [cross-block rules](../design/CONTEXT.md#term-cross-block-rule).
