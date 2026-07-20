# A resolved `data-richmd-theme` attribute and an `@layer richmd-base` are the two CSS-facing theme contracts a reskin keys and wins on

<a id="adr-0016"></a>

A consumer reskinning a [rendered page](../design/CONTEXT.md#term-rendered-page)
needs two things from richmd that principle P3's variable contract alone did not
guarantee: a single reliable signal for _which_ theme is actually active, and a
way to override richmd's `--richmd-*` tokens that wins without out-specifying
richmd's own selectors. Keying theme-dependent CSS on the bare
`@media (prefers-color-scheme: dark)` query breaks the moment a page forces a
theme against the OS preference (the reported bug: the media query and the forced
theme disagree), and matching richmd's exact `[data-richmd-theme]` selector list
to win a specificity fight is brittle and undocumented — it breaks the day
richmd's base selectors change. These are guarantees richmd makes _to_ a
consumer's CSS, not a `.richmd/**/*.lua` hook the consumer authors, so they
strengthen the existing [theme](../design/CONTEXT.md#term-theme) reskin contract
(P3, §09) rather than adding a sixth declarable contract.

richmd guarantees two CSS-facing theme contracts. **(1)** `.richmd-doc` always
carries a `data-richmd-theme="light"|"dark"` attribute reflecting the _resolved_
active theme — set at runtime by the inline anti-flash script before first paint
(an explicit stored choice if present, else `matchMedia('(prefers-color-scheme:
dark)')`), kept in sync when the OS preference changes unless an explicit stored
choice wins, and re-emitted alongside the `richmd-theme-changed` event the toggle
dispatches — so a consumer keys theme-dependent CSS on that one signal rather
than the bare media query. The attribute is **runtime-only**: it is never baked
into the emitted static HTML, so `richmd render --check` stays byte-identical.
**(2)** richmd's entire token + base ruleset lives in the `@layer richmd-base`
cascade layer (with the font `@import` still the first at-rule). Because any
unlayered CSS beats all layered CSS regardless of specificity, a consumer
overriding `--richmd-*` tokens with a plain unlayered `.richmd-doc { … }` rule
wins over richmd's base — including its `data-richmd-theme`-scoped light/dark
blocks, which live inside the layer too — with no specificity matching and no
need to replicate richmd's selector list.

Considered and rejected: keying consumer CSS on the bare
`@media (prefers-color-scheme)` query (disagrees with a forced theme — the exact
reported bug); setting the attribute only on an explicit user choice (leaves
OS-driven pages with no signal to key on); baking the resolved attribute into the
static HTML (breaks `render --check` byte-stability — the attribute must be
runtime-only); and expecting consumers to match richmd's exact
`[data-richmd-theme]` selector list to win specificity (brittle and undocumented,
and breaks when the base selectors change — which is precisely what the cascade
layer removes the need for).
