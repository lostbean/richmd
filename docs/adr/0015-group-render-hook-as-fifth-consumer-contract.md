# Grouping consecutive same-kind blocks is a consumer hook, structure-only, render-phase, per-kind singleton

<a id="adr-0015"></a>

A schema-projected consumer authors a flat sequence of typed blocks (individual
`:::goal`, `:::principle`) and wants richmd to render each maximal run of one
kind as a single titled section — the goals gathered under one "Goals" heading,
each block a card inside — without the author grouping them by hand, so the
source stays a clean sequence and the sectioned presentation is derived (issue
#27). The four existing consumer-declarable contracts cannot do this: block
schemas and the token vocabulary are per-block or per-inline-span, the
cross-block rule sees a run but only to validate it, and the document-shell hook
is document-scoped chrome — none has a render-phase pass that can wrap a run of
sibling blocks into a section. We add a fifth consumer contract, the
[group hook](../design/CONTEXT.md#term-group-hook): a `.richmd/groups/*.lua`
returning `{ kinds = {...}, render = function(kind, rendered_blocks) end }`,
which richmd calls once per [block group](../design/CONTEXT.md#term-block-group)
of a claimed kind, replacing that run with the hook's returned blocks.

The contract is fixed by four decisions, each weighed against a live
alternative: it groups **maximal runs of consecutive same-kind blocks only**, so
grouping never reorders blocks and never reaches across a block of another kind
(a `:::no-goal` between two `:::goal`s yields two goal groups, not one) — the run
is always a contiguous document span, keeping the transform local and
order-preserving; it runs in the **render phase on the already-rendered nodes**,
after per-block render, so each block's own `render_fn` is untouched and the
hook composes with it rather than replacing it; the hook receives the run's
`kind` as its first argument, so **one hook file may claim several kinds** and
switch its heading and class on the kind rather than forcing one file per kind;
and it returns **structure-only** Pandoc AST with `richmd-*` classes, never raw
styled HTML, so visual identity stays in the
[theme](../design/CONTEXT.md#term-theme) (P3), exactly as the shell hook and the
[token hook](../design/CONTEXT.md#term-token-hook) already do. Like the other
directory contracts it is **optional and fail-closed**: a kind with no hook
renders block-by-block exactly as before, and a malformed hook, a per-kind
singleton collision (two hooks claiming the same kind, naming both files), or a
render-time crash is a hard filter failure naming the file — never a partial or
silently wrong page.

Considered and rejected: a **validate-side** grouping bolted onto the
cross-block rule (a rule gates a run, it does not render one — conflates the
validate and render phases the two contracts deliberately split); grouping on
the **source blocks before per-block render**, re-implementing each kind's
`render_fn` inside the hook (throws away composition — the hook would have to
know how a goal card is built); a **non-consecutive** gather that pulls every
block of a kind together regardless of position (reorders the document and
reaches across intervening content, breaking the author's own sequencing); and a
`render(rendered_blocks)` signature without the `kind` argument (forces one hook
file per kind and blinds a multi-kind hook to which run it is wrapping).
