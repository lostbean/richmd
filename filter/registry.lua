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
  return setmetatable({ kinds = {} }, Registry)
end

-- register(kind_name, schema, render_fn)
--
-- schema is a block kind schema fragment (see CONTEXT.md#term-block-kind-schema):
--   { kind = "...", attrs = { <attr_name> = { required, type, enum_values } },
--     body = "required" | "optional" | "forbidden" }
--
-- render_fn(block, resolved_attrs) -> pandoc_ast_node
function Registry:register(kind_name, schema, render_fn)
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

return Registry
