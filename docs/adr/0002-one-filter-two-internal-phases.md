# Validate and render as two phases of one Lua filter, not two Pandoc invocations

<a id="adr-0002"></a>

The pipeline needed a decision between two separate Pandoc invocations (a
validate-only pass, then a render pass assuming validate already passed) and
a single Lua filter that internally runs a validate phase before a render
phase. We chose the single-filter, two-internal-phase shape: it parses the
document once instead of twice, and it lets the validate phase collect every
[validation error](../design/CONTEXT.md#term-validation-error) in the
document before reporting, rather than failing on the first Pandoc
invocation's first error. Collecting all errors up front matters most for a
code agent iterating on a document — seeing every problem in one pass beats
a fix-one-rerun-repeat loop. The CLI still exposes both `richmd validate`
and `richmd render` as separate subcommands; both invoke the same filter,
with `validate` passing a flag that stops the filter right after the
validate phase and never emits HTML.
