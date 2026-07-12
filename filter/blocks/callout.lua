-- richmd built-in block kind: callout.
--
-- info/warning/danger tinted panel (design.md §04 registry card). This is
-- the only file allowed to know that "callout" exists as a concept — the
-- filter core and the registry's lookup loop stay generic.
--
-- Markup contract (theme/default.css §4 CALLOUTS): the outer
-- `.richmd-callout` element never carries content directly — it wraps a
-- single `.richmd-callout-body` element, which holds an optional leading
-- `.richmd-callout-title` span followed by the block's own content. The
-- optional `title` attr follows the same schema-driven, generic-attrs
-- pattern as every other kind's optional string attr (e.g. embedded-svg's
-- `file`, stat-tile's `value`/`label`) rather than inferring a "title" by
-- inspecting the parsed body content — no special-casing, per design.md §00.

local schema = {
  kind = "callout",
  attrs = {
    tint = {
      required = false,
      type = "enum",
      enum_values = { "info", "warning", "danger" },
    },
    title = {
      required = false,
      type = "string",
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

  -- The title, when present, is emitted as its own leading Plain block (a
  -- Span with `display: block` in the theme) rather than spliced into the
  -- first inline of block.content's first block — the body's first block
  -- could be anything (heading, list, paragraph), and splicing into an
  -- arbitrary block shape is far more fragile than a dedicated leading
  -- block. `.richmd-callout-title`'s `display: block` gives the same
  -- visual stacking either way.
  local body_content = {}
  if resolved_attrs.title and resolved_attrs.title ~= "" then
    table.insert(
      body_content,
      pandoc.Plain({
        pandoc.Span({ pandoc.Str(resolved_attrs.title) }, pandoc.Attr("", { "richmd-callout-title" })),
      })
    )
  end
  for _, item in ipairs(block.content) do
    table.insert(body_content, item)
  end

  local body_div = pandoc.Div(body_content, pandoc.Attr("", { "richmd-callout-body" }))

  return pandoc.Div({ body_div }, pandoc.Attr("", classes))
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
