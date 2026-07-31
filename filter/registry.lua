-- richmd block kind registry.
--
-- Owns schema + renderer lookup for every block kind, built-in or
-- consumer-extended (design.md §04). One table keyed by kind name; the
-- filter core (richmd-filter.lua) calls `lookup` generically once per
-- block during validate and again during render — this module has no
-- knowledge of which kinds exist beyond what's been `register`ed into it.

local Registry = {}
Registry.__index = Registry

function Registry.new()
  -- `order` mirrors `kinds` as a plain list of kind names in registration
  -- order. `kinds` alone is a hash table, and Lua's `pairs` iteration order
  -- over one is unspecified — anything that must visit EVERY kind in a
  -- repeatable sequence (each_kind, below) needs a list to walk instead, or
  -- the filter's own output would vary run to run.
  return setmetatable({ kinds = {}, order = {} }, Registry)
end

-- register(kind_name, schema, render_fn)
--
-- schema is a block kind schema fragment (see CONTEXT.md#term-block-kind-schema):
--   { kind = "...", attrs = { <attr_name> = { required, type, enum_values } },
--     body = "required" | "optional" | "forbidden" }
--
-- render_fn(block, resolved_attrs) -> pandoc_ast_node
function Registry:register(kind_name, schema, render_fn)
  if not self.kinds[kind_name] then
    table.insert(self.order, kind_name)
  end
  self.kinds[kind_name] = { schema = schema, render_fn = render_fn }
end

-- lookup(kind_name) -> schema, render_fn | nil, nil
function Registry:lookup(kind_name)
  local entry = self.kinds[kind_name]
  if not entry then
    return nil, nil
  end
  return entry.schema, entry.render_fn
end

-- each_kind() -> iterator yielding (kind_name, schema, render_fn)
--
-- Visits every registered kind exactly once, in registration order.
-- Registration order is DETERMINISTIC for a given tree (built-ins register
-- in the fixed sequence richmd-filter.lua lists them, then consumer
-- extensions in the extension loader's own sorted order), which is what
-- makes anything driven by this iterator — currently the filter core's
-- document-wide batch-validate step (design.md §07, ADR-0018) — produce the
-- same error ordering on every run of the same document. Iterating `kinds`
-- with `pairs` instead would leave that ordering up to Lua's hash layout.
--
-- Callers stay kind-agnostic: this hands back whatever was registered and
-- never interprets it, exactly like `lookup`.
function Registry:each_kind()
  local index = 0
  return function()
    index = index + 1
    local kind_name = self.order[index]
    if not kind_name then
      return nil
    end
    local entry = self.kinds[kind_name]
    return kind_name, entry.schema, entry.render_fn
  end
end

return Registry
