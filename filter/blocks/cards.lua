-- richmd built-in block kind: cards.
--
-- The workhorse enumeration block (design.md §04 registry card): a
-- CSS-grid of card-shaped items, authored as ordinary markdown body content
-- (typically a run of `###` sub-headings, one per card) inside a single
-- fenced div. This is the only file allowed to know that "cards" exists as
-- a concept — the filter core and the registry's lookup loop stay generic.

local schema = {
  kind = "cards",
  attrs = {
    cols = {
      required = false,
      type = "enum",
      enum_values = { "2", "3", "4" },
    },
    size = {
      required = false,
      type = "enum",
      enum_values = { "sm", "md", "lg" },
    },
  },
  body = "required",
}

-- DEFAULT_COLS: used when the author omits `cols` entirely (schema marks it
-- optional) — three columns is a reasonable default grid shape for an
-- enumeration block.
local DEFAULT_COLS = "3"

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Wraps the body content (untouched — still ordinary Pandoc blocks, so any
-- `###` sub-headings inside render as normal headings) in a `<div>` whose
-- `--richmd-cards-cols` custom property drives the CSS grid's column count
-- (§00 principle P3: the renderer emits the variable hook, never a literal
-- grid-template-columns value itself). `size` (sm/md/lg), when present,
-- becomes a modifier class the stylesheet uses to scale card padding/type.
local function render(block, resolved_attrs)
  local cols = resolved_attrs.cols or DEFAULT_COLS
  local classes = { "richmd-cards" }
  if resolved_attrs.size then
    table.insert(classes, "richmd-cards--" .. resolved_attrs.size)
  end

  local attr = pandoc.Attr("", classes, { { "style", "--richmd-cards-cols: " .. cols .. ";" } })
  return pandoc.Div(block.content, attr)
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("cards", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
