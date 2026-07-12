-- richmd built-in block kind: stat-tile.
--
-- KPI-style number-plus-label (design.md §04 registry card): a small tile
-- showing one prominent value, a caption beneath it, and an optional trend
-- indicator. This is the only file allowed to know that "stat-tile" exists
-- as a concept — the filter core and the registry's lookup loop stay
-- generic.
--
-- Markup contract (theme/default.css §6 STAT / KPI TILES): the theme
-- expects every `.richmd-stat` tile to live inside a shared
-- `.richmd-stat-grid` wrapper, e.g. a row of several tiles inside ONE grid
-- parent. A standalone `.stat-tile` (this file, used alone) has no sibling
-- to share a grid with, so its own render_fn wraps its single `.richmd-stat`
-- in a one-item `.richmd-stat-grid` — see render() below. An author who
-- wants several tiles in one real shared row uses the `stat-grid` PARENT
-- block kind instead (filter/blocks/stat-grid.lua): `::: {.stat-grid
-- cols="4"} :::: {.stat-tile ...} :::: ... :::` nests several stat-tile divs
-- inside one stat-grid div, and stat-grid.lua reuses this file's
-- render_stat_div() helper (below) to render each nested tile's
-- `.richmd-stat` markup into the ONE shared `.richmd-stat-grid` it emits —
-- composition, not a fork: this file's schema, registration, and standalone
-- behavior are unchanged by stat-grid's existence.

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

-- render_stat_div(resolved_attrs) -> pandoc_ast_node (a single `.richmd-stat` Div)
--
-- Emits just `.richmd-stat > (.richmd-stat-label, .richmd-stat-value,
-- [.richmd-stat-delta])` — classes only; the actual type scale, color, and
-- spacing live in theme/default.css's `--richmd-*` custom properties (§00
-- principle P3). Factored out from the standalone render_fn (below) so a
-- PARENT block kind that groups several stat-tiles into one shared row
-- (filter/blocks/stat-grid.lua) can reuse this exact per-tile markup without
-- duplicating the label/value/delta assembly logic — the single source of
-- truth for what a "stat tile" renders to stays here, in the only file
-- allowed to know that "stat-tile" exists as a concept. stat-grid.lua calls
-- this directly (`require("blocks.stat-tile").render_stat_div`); it does
-- NOT reimplement this assembly.
local function render_stat_div(resolved_attrs)
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

  return pandoc.Div(tile_content, pandoc.Attr("", { "richmd-stat" }))
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Standalone rendering path (backward compatible): a lone `.stat-tile` not
-- grouped under a `.stat-grid` parent still wraps its own single
-- `.richmd-stat` in a one-item `.richmd-stat-grid`, exactly as before
-- stat-grid.lua existed — this preserves every existing document's
-- rendered output unchanged (§00 principle P4: stat-grid is added by
-- composition, never by changing this external contract).
local function render(_block, resolved_attrs)
  local stat_div = render_stat_div(resolved_attrs)
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
  render_stat_div = render_stat_div,
  register = register,
}
