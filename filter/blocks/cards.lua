-- richmd built-in block kind: cards.
--
-- The workhorse enumeration block (design.md §04 registry card): a
-- CSS-grid of card-shaped items, authored as ordinary markdown body content
-- (a run of `###` sub-headings, one per card) inside a single fenced div.
-- This is the only file allowed to know that "cards" exists as a concept —
-- the filter core and the registry's lookup loop stay generic.
--
-- MARKUP CONTRACT (theme/default.css §5 CARD GRIDS, current theme): the grid
-- wrapper is `.richmd-card-grid[data-cols="N"]` (columns read from a
-- `data-cols` HTML attribute, not a CSS custom-property style hook), and
-- each enumerated item is its OWN `.richmd-card` div — a flex-column card
-- with its own background/border/shadow — containing a `.richmd-card-title`
-- and a `.richmd-card-body` <p>. This means the body content can no longer
-- be passed through untouched: it has to be split into one card per `###`
-- heading. See split_cards() below.

local schema = {
  kind = "cards",
  attrs = {
    cols = {
      required = false,
      type = "enum",
      enum_values = { "2", "3", "4" },
    },
    -- `size` has no rendering effect under the new theme (see render()'s
    -- comment) but stays schema-valid so existing/authored documents using
    -- size= don't suddenly fail validation.
    size = {
      required = false,
      type = "enum",
      enum_values = { "sm", "md", "lg" },
    },
  },
  body = "required",
}

-- CARD_HEADING_LEVEL: the heading level that starts a new card. Authors
-- write `### Title` per card (see test/fixtures/cards-valid.md).
local CARD_HEADING_LEVEL = 3

-- split_cards(blocks) -> { { heading = pandoc.Header, body = { block, ... } }, ... }
--
-- Walks a LOCAL block list (a cards block's own `block.content` — NOT the
-- whole document; toc.lua's doc:walk over Headers is a different job, a
-- document-wide table of contents, and isn't reusable here) and splits it
-- into one entry per level-3 Header boundary. Everything from one `###` up
-- to (but not including) the next `###`, or the end of the list, becomes
-- that heading's body. Any content before the first `###` (unusual, but not
-- forbidden by the schema) is dropped rather than guessed into a card —
-- cards are heading-delimited by contract.
local function split_cards(blocks)
  local cards = {}
  local current = nil
  for _, blk in ipairs(blocks) do
    if blk.t == "Header" and blk.level == CARD_HEADING_LEVEL then
      current = { heading = blk, body = {} }
      table.insert(cards, current)
    elseif current then
      table.insert(current.body, blk)
    end
  end
  return cards
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Splits the body into per-`###` cards (split_cards) and renders each as
-- `<div class="richmd-card"><div class="richmd-card-title">...</div>
-- <p class="richmd-card-body">...</p></div>`, all wrapped in
-- `<div class="richmd-card-grid" data-cols="N">` — `data-cols` is the value
-- the new theme's `[data-cols="N"]` selectors read directly (§00 principle
-- P3 still holds: the renderer emits the hook the CSS contract asks for,
-- never a literal grid-template-columns value — the hook just moved from a
-- style-attr custom property to a data-attribute under this theme).
--
-- `size` (sm/md/lg): the new theme's CARD GRIDS section has no card-size
-- concept at all (no size-modifier class, no --richmd-card-size-* token —
-- checked against the actual current theme/default.css, not assumed). There
-- is nothing left for this renderer to hook it to, so `size` is accepted by
-- the schema (existing authored documents keep validating) but has no
-- rendering effect. This is a deliberate, reported decision, not an
-- oversight — see the chunk report.
local function render(block, resolved_attrs)
  local cols = resolved_attrs.cols

  local grid_attrs = {}
  if cols then
    grid_attrs = { { "data-cols", cols } }
  end
  local grid_attr = pandoc.Attr("", { "richmd-card-grid" }, grid_attrs)

  local cards = split_cards(block.content)
  local card_divs = {}
  for _, card in ipairs(cards) do
    local title_text = pandoc.utils.stringify(card.heading.content)
    local title_div = pandoc.Div(
      { pandoc.Plain({ pandoc.Str(title_text) }) },
      pandoc.Attr("", { "richmd-card-title" })
    )

    -- Pandoc's Para/Plain AST nodes carry no Attr field of their own (unlike
    -- Div/Span/Header) — a class can't be hung directly off a `<p>` this
    -- way. Wrapping the body blocks in a Div with the richmd-card-body
    -- class is the same pattern callout.lua's richmd-callout-body already
    -- uses (see theme/default.css's `.richmd-callout-body p:last-child`
    -- rule, which only makes sense if richmd-callout-body is itself a
    -- wrapper, not the <p> element).
    local body_div = pandoc.Div(card.body, pandoc.Attr("", { "richmd-card-body" }))

    table.insert(card_divs, pandoc.Div({ title_div, body_div }, pandoc.Attr("", { "richmd-card" })))
  end

  return pandoc.Div(card_divs, grid_attr)
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
