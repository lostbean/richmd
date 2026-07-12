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
  -- owns_internal_headers: this kind's body content is authored as a run
  -- of `### heading` Headers, but each one is purely this kind's own
  -- title-splitting syntax (split_cards below), never a real, independently
  -- navigable section of the document. Declaring this generic, opt-in
  -- schema field (checked by filter/heading-scope.lua, never an
  -- `if kind_name == "cards"` special case in the filter core) is what
  -- keeps these Headers from being assigned a real `id` or leaking into a
  -- `::: {.toc}` block's auto-generated entries — see
  -- filter/heading-scope.lua's own header comment for the full mechanism
  -- and why it works this way.
  owns_internal_headers = true,
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
  validate = nil, -- set below, after `validate` is defined
}

-- BADGE_TINTS: the 7 real tint-variant modifier classes theme/default.css
-- ships (§7 BADGES / PILLS: `.richmd-badge--accent`/`--accent2`/`--info`/
-- `--warning`/`--danger`/`--neutral`/`--outline`) — the only values
-- `badge-tint` may validate to. Shared between validate() and render() so
-- the two can never drift out of sync on what counts as a real tint.
local BADGE_TINTS = { "accent", "accent2", "info", "warning", "danger", "neutral", "outline" }

-- CARD_HEADING_LEVEL: the heading level that starts a new card. Authors
-- write `### Title` per card (see test/fixtures/cards-valid.md).
--
-- Per-card badge/meta (design.md §04: "each card's `###` title optionally
-- paired with a small badge/tag... visual metadata, never a substitute for
-- the title text itself") is authored as Pandoc's own `header_attributes`
-- reader extension directly on that SAME `###` line — `### Title
-- {badge="..." badge-tint="..." meta="..."}` — never a new heading level
-- or a sibling div. This was confirmed reliable in this repo's actual
-- Pandoc invocation (bin/richmd.js: plain `markdown` reader, no `-f`
-- override, so the default extension set applies) by a direct probe: a
-- `pandoc --lua-filter` run against `### Title {badge="x"}` shows
-- `header_attributes` is on by default, and the resulting Header AST node
-- already carries `badge`/`badge-tint`/`meta` in its own `.attributes`
-- table — exactly like any Div's attrs, just read off `card.heading`
-- instead of off the cards Div itself. This keeps cards.lua's existing
-- one-`###`-per-card contract completely unchanged (no new heading level
-- introduced, so filter/heading-scope.lua's owns_internal_headers
-- mechanism — which only ever looks at DIRECT-child Header nodes of a
-- cards Div — needs no change at all: the attrs ride along on the exact
-- same Header node heading-scope.lua already marks internal).
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

-- validate(block, kind_name, location, add_error)
--
-- The generic schema-driven attrs/body checks (richmd-filter.lua's
-- validate_attrs/validate_body) only ever see the cards Div's OWN attrs
-- (cols/size) — they have no idea per-card Header nodes even exist, let
-- alone that each one can carry its own badge/badge-tint/meta attrs. This
-- hook is cards.lua's own custom grammar check (the exact same pattern
-- embedded-svg.lua's `validate` uses for its file-existence check, and
-- mermaid.lua's for its parse check): split the body into cards exactly
-- like render() will, then validate each card's own `badge-tint` attr
-- against BADGE_TINTS the same way the generic enum-attr check would, since
-- there is no way to express "an attr living on a nested AST node, not the
-- block's own attrs" in the generic schema.attrs table. `badge` and `meta`
-- are free-form optional strings — nothing to validate beyond "present or
-- not".
local function validate(block, kind_name, location, add_error)
  local cards = split_cards(block.content)
  for _, card in ipairs(cards) do
    local tint = card.heading.attributes["badge-tint"]
    if tint and tint ~= "" then
      local allowed = false
      for _, candidate in ipairs(BADGE_TINTS) do
        if tint == candidate then
          allowed = true
          break
        end
      end
      if not allowed then
        add_error(
          kind_name,
          location,
          "attr 'badge-tint' has invalid value '"
            .. tint
            .. "' (allowed: "
            .. table.concat(BADGE_TINTS, ", ")
            .. ")"
        )
      end
    end
  end
end

schema.validate = validate

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

    -- Optional per-card badge/meta (design.md §04), read directly off the
    -- card's own `### Title {badge="..." badge-tint="..." meta="..."}`
    -- heading attrs (see CARD_HEADING_LEVEL's comment for why this attr
    -- location is reliable in this repo's actual Pandoc invocation). Both
    -- are entirely optional and independent of each other; omitting both
    -- renders byte-for-byte identical to a card with no attrs at all — no
    -- `.richmd-card-meta` div is emitted unless at least one of badge/meta
    -- is actually present, so an existing card with a plain `### Title`
    -- heading (no `{...}` at all) never gains one.
    local badge_text = card.heading.attributes.badge
    local badge_tint = card.heading.attributes["badge-tint"]
    local meta_text = card.heading.attributes.meta

    local meta_children = {}
    if badge_text and badge_text ~= "" then
      local badge_classes = { "richmd-badge" }
      if badge_tint and badge_tint ~= "" then
        table.insert(badge_classes, "richmd-badge--" .. badge_tint)
      end
      table.insert(
        meta_children,
        pandoc.Span({ pandoc.Str(badge_text) }, pandoc.Attr("", badge_classes))
      )
    end
    if meta_text and meta_text ~= "" then
      table.insert(meta_children, pandoc.Str(meta_text))
    end

    local card_children = { title_div }
    if #meta_children > 0 then
      table.insert(
        card_children,
        pandoc.Div({ pandoc.Plain(meta_children) }, pandoc.Attr("", { "richmd-card-meta" }))
      )
    end
    table.insert(card_children, body_div)

    table.insert(card_divs, pandoc.Div(card_children, pandoc.Attr("", { "richmd-card" })))
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
  validate = validate,
  register = register,
}
