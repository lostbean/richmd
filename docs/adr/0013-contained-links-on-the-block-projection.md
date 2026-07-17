# A block projection reports its contained links as flat authored text-and-target pairs

<a id="adr-0013"></a>

The [block projection](../design/CONTEXT.md#term-block-projection) exposed a
block's content only as `body_text`, flattened to visible text. A
[cross-block rule](../design/CONTEXT.md#term-cross-block-rule) could therefore
check that some visible text appeared, but never that an actual link to a
target existed — a block reading `see ADR-0019` was indistinguishable from one
carrying `[ADR-0019](../adr/0019-....md#adr-0019)`. This made "must link to X"
degrade into the strictly weaker "must mention the text X", which passes a
missing or malformed link. The capability was already promised — this
document's own [cross-block rule](../design/CONTEXT.md#term-cross-block-rule)
term lists "a required cross-link" among a rule's examples, and §05 claims
rules enforce required links — so the projection was failing a contract the
layer had already stated. We chose to add `links`: a list of
[contained links](../design/CONTEXT.md#term-contained-link), each the link's
visible text and its authored target, always present and empty when the block
has none, so a rule reads it without a nil check.

This does not widen
[ADR-0008](0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008)'s
projection-not-raw-AST line; it keeps it. That decision's reason is that a
rules author is a consumer writing small Lua checks, not someone fluent in
Pandoc's AST, and a flat `{ text, target }` pair demands no Pandoc fluency
whatsoever. `links` is the same shape a
[resolved token](../design/CONTEXT.md#term-resolved-token) already established
on the same projection: copied out once, flat, never a live AST reference.

## The target is the authored one, not the rendered one

We considered reporting the target the
[render phase](../design/CONTEXT.md#term-render-phase) produces — the sibling
`.html` a [cross-document link](../design/CONTEXT.md#term-cross-document-link)
is rewritten to. We rejected it on two counts. A projection is built and
consumed entirely within the
[validate phase](../design/CONTEXT.md#term-validate-phase), before the render
phase exists, so the rewritten target is not available without running the
rewrite early. More decisively, a rule author writes `.md` links and reasons
in `.md` terms; handing them `.html` would make richmd's internal rewrite
load-bearing for consumer code — the exact coupling
[ADR-0008](0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008)
refused. The fragment, which is what a "must cite a decision record" rule
actually matches on, is identical either way: the rewrite never touches it
(§08).

## An image is not a link

We considered collecting `Image` inlines alongside `Link` inlines, since a
figure referencing its source reads like the same need. We rejected it: an
image's target is a source path the page loads, not a reference to another
document, and collecting both would force every rule matching on `target` to
first disambiguate which kind it had. `links` means links.
