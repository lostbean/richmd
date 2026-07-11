-- richmd built-in block kind: callout.
--
-- info/warning/danger tinted panel (design.md §04 registry card). This is
-- the only file allowed to know that "callout" exists as a concept — the
-- filter core and the registry's lookup loop stay generic.

local schema = {
  kind = "callout",
  attrs = {
    tint = {
      required = false,
      type = "enum",
      enum_values = { "info", "warning", "danger" },
    },
  },
  body = "required",
}

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
local function render(block, resolved_attrs)
  local tint = resolved_attrs.tint
  local classes = { "richmd-callout" }
  if tint then
    table.insert(classes, "richmd-callout--" .. tint)
  end

  return pandoc.Div(block.content, pandoc.Attr("", classes))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("callout", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
