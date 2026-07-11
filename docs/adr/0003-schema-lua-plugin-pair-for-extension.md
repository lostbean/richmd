# Consumers extend the block vocabulary with a schema + Lua filter pair

<a id="adr-0003"></a>

richmd must let a consumer repo add its own
[block kinds](../design/CONTEXT.md#term-block-kind) without forking richmd's
core — the original ask was explicit that a code agent will be the one
extending this. We considered a Lua-filter-only extension (simpler, but
validation for consumer-added kinds becomes whatever the consumer's Lua code
happens to check, losing the generic schema-driven guarantee) and a full
Node/JS plugin API (more familiar syntax, but pulls the Node dependency into
every extension, not just the diagram validators). We chose the schema + Lua
filter pair: a consumer drops a JSON schema fragment (fields, attrs,
validation rules) plus a small Lua render function into
`.richmd/blocks/`, and richmd's core loads both into the same
[registry](../design/CONTEXT.md#term-block-kind-registry) it uses for
built-in kinds. This keeps "the validator reads a schema generically, never
an if/else per kind" true even under extension — the alternative would have
silently exempted every consumer-added kind from that guarantee.
