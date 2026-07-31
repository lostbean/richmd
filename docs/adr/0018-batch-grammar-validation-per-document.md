# Grammar validators are invoked once per document per kind, not once per block

<a id="adr-0018"></a>

Each [grammar validator](../design/design.md#07-grammar-validators) was invoked
as a subprocess once per block. Both helper scripts carry per-process setup that
dwarfs the check itself — `mermaid-check.js` initializes a linkedom DOM for
mermaid's DOMPurify dependency, and `vega-lite-check.js` has `ajv` compile the
1.87MB vega-lite JSON schema — and a one-block process discards that setup
immediately. Measured on this repo at commit `83897e5`: 0.19s per mermaid block
and 0.50s per vega-lite block, against a ~0.6s fixed cost for an entire render.
Both scripts already cache their setup at module level, but the cache could never
be hit, because each process handled exactly one block and exited.

The [filter core](../design/design.md#03-filter-core)'s validate walk now collects
every block of a kind and invokes the validator once with the whole set. stdin
carries each block tagged with an identifier; stdout returns one verdict per
identifier, so a grammar rejection still names the block it came from. The
existing module-level caches then hold across a document's blocks, which is what
they were written for. The three documented outcomes are unchanged: valid,
grammar rejection, and a helper crash as a hard filter failure distinct from a
rejection.

Considered and rejected: **per-block invocation** (the prior shape), whose merit
is isolation — one block's source cannot affect another block's verdict, and the
protocol is one value in, one value out. Batching accepts a list protocol and a
shared process to remove a cost that grows with every diagram a document adds; a
validator crash was already a hard filter failure rather than a per-block
rejection, so the observable contract does not move, though a crash's blast
radius within one run does widen from one block to that kind's set. Also
rejected: a **persistent validator process** across documents (a protocol,
lifecycle management, and a hang risk inside a pre-commit hook) and an
**on-disk cache** of per-block verdicts (staleness risk on a validator that must
fail closed, and the expensive artifact — the compiled schema validator — is
identical for every block, so reuse within a process already captures it).
