-- Consumer-defined block kind: definition.
--
-- Lives entirely under this document's OWN .richmd/blocks/ directory, never
-- under richmd's own filter/ tree (design.md §00 goal "extend without
-- forking"; ADR-0003; principle P4 "extend by composition, never by fork").
-- richmd's core never special-cases "definition" — it is registered into
-- the exact same shared registry instance as callout/cards/stat-tile/etc.
-- via the generic ExtensionLoader mechanism (filter/extension-loader.lua),
-- resolved relative to THIS document's own directory (examples/), not the
-- repo root.
--
-- A definition is a small glossary-style panel: a required `term` attr
-- rendered as a bold heading line, followed by the block's own body as the
-- definition text. Modeled directly on filter/blocks/callout.lua's own
-- "attr-driven leading line + body div" shape (see callout.lua's `title`
-- attr handling) — a leading Plain/Span line built from a schema attr,
-- never spliced into the body's own first block, because the body's first
-- block could be anything (heading, list, paragraph).
--
-- Attrs: `term` (string, required — the glossary term being defined).
-- Body: required (the definition's own prose).
--
-- Styling lives in examples/custom-theme.css (`.custom-definition`,
-- `.custom-definition-term`, `.custom-definition-body`), proving a
-- consumer's own extension can ship its own CSS alongside a custom theme —
-- a realistic combined scenario (this work order's whole point).

local function render(block, resolved_attrs)
  local term_line = pandoc.Plain({
    pandoc.Span(
      { pandoc.Str(resolved_attrs.term) },
      pandoc.Attr("", { "custom-definition-term" })
    ),
  })

  local body_content = { term_line }
  for _, item in ipairs(block.content) do
    table.insert(body_content, item)
  end

  local body_div = pandoc.Div(body_content, pandoc.Attr("", { "custom-definition-body" }))

  return pandoc.Div({ body_div }, pandoc.Attr("", { "custom-definition" }))
end

return { render = render }
