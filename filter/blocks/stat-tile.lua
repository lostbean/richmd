-- richmd built-in block kind: stat-tile.
--
-- KPI-style number-plus-label (design.md §04 registry card): a small tile
-- showing one prominent value and a caption beneath it. This is the only
-- file allowed to know that "stat-tile" exists as a concept — the filter
-- core and the registry's lookup loop stay generic.

local schema = {
  kind = "stat-tile",
  attrs = {
    value = {
      required = true,
      type = "string",
    },
    label = {
      required = true,
      type = "string",
    },
  },
  -- A stat tile is a number plus a caption, not prose — its content comes
  -- entirely from the `value`/`label` attrs. A body is never expected.
  body = "forbidden",
}

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Emits a small `<div>` structure — a prominent value element and a label
-- element beneath it — with classes only; the actual type scale, color,
-- and spacing live in theme/default.css's `--richmd-stat-tile-*` custom
-- properties (§00 principle P3).
local function render(_block, resolved_attrs)
  -- Attrs are always plain strings (no markdown parsing needed for a short
  -- value/caption), so each becomes a single Plain-wrapped Str inline.
  local value_div = pandoc.Div(
    { pandoc.Plain({ pandoc.Str(resolved_attrs.value) }) },
    pandoc.Attr("", { "richmd-stat-tile__value" })
  )
  local label_div = pandoc.Div(
    { pandoc.Plain({ pandoc.Str(resolved_attrs.label) }) },
    pandoc.Attr("", { "richmd-stat-tile__label" })
  )

  return pandoc.Div({ value_div, label_div }, pandoc.Attr("", { "richmd-stat-tile" }))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("stat-tile", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
