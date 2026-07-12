-- richmd built-in block kind: stat-grid.
--
-- The PARENT block kind (design.md §04 registry card) that groups several
-- sibling stat-tiles into one shared row, mirroring cards.lua's exact
-- structural pattern: a single fenced div whose body content holds multiple
-- nested items, all wrapped in ONE shared grid container — cards.lua's body
-- is a run of `### heading` cards; a stat-grid's body is a run of nested
-- `::: {.stat-tile ...} :::` fenced divs instead (Pandoc's fenced-div syntax
-- nests via a longer colon-run on the outer fence than the inner one, e.g.
-- `::::` around `:::` — confirmed against real Pandoc 3.7 output before
-- writing this file; see the chunk report for the probe). This is the only
-- file allowed to know that "stat-grid" exists as a concept — the filter
-- core and the registry's lookup loop stay generic.
--
-- WHY THIS FILE DOES NOT RE-EXTRACT NESTED TILES' ATTRS ITSELF: richmd's
-- filter core (filter/richmd-filter.lua) walks the WHOLE document AST with
-- one `doc:walk`, bottom-up, for both the validate and render phases —
-- proven by direct probe, not assumed. In the render phase this means each
-- nested `.stat-tile` Div is independently re-derived and handed to
-- stat-tile.lua's OWN render_fn by the generic `render_only_div` dispatch
-- BEFORE this stat-grid Div's own render_fn ever runs (children before
-- parent) — by the time `block.content` reaches this file's render(), every
-- nested stat-tile has ALREADY been rewritten in place into its standalone
-- rendering: `<div class="richmd-stat-grid"><div class="richmd-stat">...
-- </div></div>`. So there is no raw attrs table left to re-validate or
-- re-render from here — reusing stat-tile.lua's rendering logic does not
-- mean calling its render_stat_div() helper directly (that helper takes
-- resolved_attrs this file never sees); it means unwrapping the one-item
-- `.richmd-stat-grid` wrapper each already-rendered nested tile arrives in
-- and lifting out the inner `.richmd-stat` div, discarding only the
-- redundant per-tile grid wrapper. The `.richmd-stat` markup itself is
-- still produced by stat-tile.lua's single render path — this file never
-- assembles label/value/delta markup itself, so there remains exactly ONE
-- place that knows how a stat tile's insides are shaped.
--
-- Validation of nested tiles needs no special handling here either: the
-- SAME bottom-up whole-document walk means every nested `.stat-tile` Div is
-- independently validated by the generic `validate_only_div` dispatch (its
-- own schema, its own required/enum checks) before this file's schema.body
-- check even runs — a malformed nested tile (e.g. missing required `label`)
-- is reported through the exact same shared `add_error` mechanism as a
-- top-level block, never swallowed by this parent (confirmed by probe).

local schema = {
  kind = "stat-grid",
  attrs = {
    cols = {
      required = false,
      type = "enum",
      enum_values = { "2", "3", "4" },
    },
  },
  body = "required",
}

-- unwrap_rendered_stat_div(rendered_child) -> pandoc_ast_node | nil
--
-- A stat-grid's body, BY THE TIME render() below runs, no longer holds raw
-- `.stat-tile` Divs with attrs — the whole-document bottom-up walk has
-- already replaced each one with its own standalone
-- `.richmd-stat-grid > .richmd-stat` rendering (see this file's header
-- comment). This function lifts the inner `.richmd-stat` div back out,
-- discarding the now-redundant one-item `.richmd-stat-grid` wrapper each
-- nested tile arrived in, so this stat-grid can emit exactly ONE shared grid
-- containing all of them. Any body content that ISN'T a rendered stat-tile
-- (stray prose, say) is skipped rather than guessed into a tile slot — same
-- "heading/shape-delimited by contract" spirit as cards.lua's split_cards.
local function unwrap_rendered_stat_div(rendered_child)
  if
    rendered_child.t == "Div"
    and rendered_child.classes
    and rendered_child.classes[1] == "richmd-stat-grid"
    and #rendered_child.content > 0
  then
    return rendered_child.content[1]
  end
  return nil
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Emits `.richmd-stat-grid[data-cols="N"] > .richmd-stat, .richmd-stat, ...`
-- — one shared grid wrapping every nested tile — using the exact same
-- `data-cols` hook pattern cards.lua's card-grid already established (§00
-- principle P3: the renderer emits the CSS contract's hook, never a literal
-- grid-template-columns value).
local function render(block, resolved_attrs)
  local cols = resolved_attrs.cols

  local grid_attrs = {}
  if cols then
    grid_attrs = { { "data-cols", cols } }
  end
  local grid_attr = pandoc.Attr("", { "richmd-stat-grid" }, grid_attrs)

  local stat_divs = {}
  for _, child in ipairs(block.content) do
    local stat_div = unwrap_rendered_stat_div(child)
    if stat_div then
      table.insert(stat_divs, stat_div)
    end
  end

  return pandoc.Div(stat_divs, grid_attr)
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("stat-grid", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
