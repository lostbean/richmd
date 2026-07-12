-- Consumer-defined block kind: kicker.
--
-- Lives entirely under this document's OWN .richmd/blocks/ directory, never
-- under richmd's own filter/ tree (design.md §00 goal "extend without
-- forking"; ADR-0003; principle P4 "extend by composition, never by fork").
-- richmd's core never special-cases "kicker" — it is registered into the
-- exact same shared registry instance as callout/cards/stat-tile/etc. via
-- the generic ExtensionLoader mechanism (filter/extension-loader.lua),
-- resolved relative to THIS document's own directory (examples/), not the
-- repo root.
--
-- A kicker is a short, uppercase label line set above a section — the same
-- visual idea as theme/default.css's existing `.richmd-card-kicker` rule
-- (§5 CARD GRIDS), reused here as a small standalone span so a section
-- heading can be preceded by an eyebrow-style label without needing a full
-- `cards` block.
--
-- Body: required (the kicker's own short text, e.g. "PLATFORM HEALTH").
-- No attrs.

local function render(block, resolved_attrs)
  return pandoc.Div(
    { pandoc.Plain({ pandoc.Span(pandoc.utils.blocks_to_inlines(block.content, { pandoc.Space() }), pandoc.Attr("", { "richmd-card-kicker" })) }) },
    pandoc.Attr("", { "richmd-kicker" })
  )
end

return { render = render }
