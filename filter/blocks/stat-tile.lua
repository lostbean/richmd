-- richmd built-in block kind: stat-tile.
--
-- KPI-style number-plus-label (design.md §04 registry card): a small tile
-- showing one prominent value, a caption beneath it, and an optional trend
-- indicator. This is the only file allowed to know that "stat-tile" exists
-- as a concept — the filter core and the registry's lookup loop stay
-- generic.
--
-- Markup contract (theme/default.css §6 STAT / KPI TILES): the new theme
-- expects every `.richmd-stat` tile to live inside a shared
-- `.richmd-stat-grid` wrapper, e.g. a row of several tiles inside ONE grid
-- parent. richmd's schema has no concept of "these N stat-tile blocks
-- belong together in one row" — each `::: {.stat-tile}` div is validated
-- and rendered fully independently, and the locked render_fn signature
-- (`render_fn(block, resolved_attrs)`) gives this renderer no access to
-- sibling blocks. Unlike toc.lua's self-read-the-document trick — which
-- only needed whole-document information (every heading, order-independent
-- of which block instance is rendering) — grouping ADJACENT stat-tile
-- blocks would need this renderer to know its own position among its
-- siblings, and there is no id or index in `block`/`resolved_attrs` to
-- correlate a freshly re-parsed copy of the document back to the specific
-- instance being rendered (indistinguishable duplicate tiles would be
-- ambiguous). Rather than invent a new parent block kind (a real design.md
-- §04 addition, out of scope for this chunk) or bolt sibling-detection onto
-- the filter core (an interface change to every other kind, also out of
-- scope), each stat-tile independently emits its own single-item
-- `.richmd-stat-grid` wrapping one `.richmd-stat` tile. An author who wants
-- a true shared row of tiles places several stat-tile blocks back to back
-- in the source with no content between them; Pandoc emits N adjacent
-- one-item grids rather than one N-item grid — visually close for a
-- single-column reading but not a real shared 4-column CSS grid row. That
-- gap is a known, named trade-off, not an oversight.

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
    -- Optional trend indicator text, e.g. "↑ 12% vs last wk". Free-form
    -- string, paired with `dir` for the up/down modifier class — same
    -- optional-string-attr pattern as callout.lua's `title`.
    delta = {
      required = false,
      type = "string",
    },
    -- Direction of the trend the `delta` text describes. Enum-typed and
    -- validated generically by the shared validate_attrs mechanism, the
    -- exact pattern callout.lua's `tint` attr already uses — no
    -- special-casing here.
    dir = {
      required = false,
      type = "enum",
      enum_values = { "up", "down" },
    },
  },
  -- A stat tile is a number plus a caption (plus an optional trend line),
  -- not prose — its content comes entirely from attrs. A body is never
  -- expected.
  body = "forbidden",
}

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Emits `.richmd-stat-grid > .richmd-stat > (.richmd-stat-label,
-- .richmd-stat-value, [.richmd-stat-delta])` — classes only; the actual
-- type scale, color, and spacing live in theme/default.css's
-- `--richmd-*` custom properties (§00 principle P3).
local function render(_block, resolved_attrs)
  -- Attrs are always plain strings (no markdown parsing needed for a short
  -- value/caption/delta), so each becomes a single Plain-wrapped Str inline.
  local label_div = pandoc.Div(
    { pandoc.Plain({ pandoc.Str(resolved_attrs.label) }) },
    pandoc.Attr("", { "richmd-stat-label" })
  )
  local value_div = pandoc.Div(
    { pandoc.Plain({ pandoc.Str(resolved_attrs.value) }) },
    pandoc.Attr("", { "richmd-stat-value" })
  )

  local tile_content = { label_div, value_div }

  if resolved_attrs.delta and resolved_attrs.delta ~= "" then
    local delta_classes = { "richmd-stat-delta" }
    if resolved_attrs.dir then
      table.insert(delta_classes, "richmd-stat-delta--" .. resolved_attrs.dir)
    end
    table.insert(
      tile_content,
      pandoc.Div(
        { pandoc.Plain({ pandoc.Str(resolved_attrs.delta) }) },
        pandoc.Attr("", delta_classes)
      )
    )
  end

  local stat_div = pandoc.Div(tile_content, pandoc.Attr("", { "richmd-stat" }))

  return pandoc.Div({ stat_div }, pandoc.Attr("", { "richmd-stat-grid" }))
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
