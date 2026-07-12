-- richmd built-in block kind: labeled-block.
--
-- Goal/invariant/principle-style typed statement (design.md §04 registry
-- card), modeling the design-write framework's own block anatomy: every
-- statement block opens with a required label — bold text alone on the
-- first line — and the rest of the block is the body (see
-- primitives/design-write.md §2 "Block anatomy"). This is the only file
-- allowed to know that "labeled-block" exists as a concept — the filter
-- core and the registry's lookup loop stay generic.

local schema = {
  kind = "labeled-block",
  attrs = {
    -- `type` names what KIND of typed statement this is (goal, no-goal,
    -- principle, invariant, or any other consumer vocabulary word) — driving
    -- a modifier class and, via the theme, a badge color. Left as a free
    -- string rather than an enum: richmd itself has no opinion on which
    -- statement-type vocabulary a consumer document uses.
    type = {
      required = true,
      type = "string",
    },
  },
  -- Body must contain both the label line and the statement text.
  body = "required",
}

-- extract_label(content) -> label_inlines, remaining_blocks
--
-- Per the reference pattern: the label is bold text ALONE on the block's
-- first line — i.e. the first body block is a Plain/Para whose entire
-- inline content is a single Strong run. Everything after that first block
-- is the body proper. If the first block does not match that shape, there
-- is no separate label — the whole body renders as-is and `label_inlines`
-- is nil.
local function extract_label(content)
  local first = content[1]
  if not first then
    return nil, content
  end
  local tag = first.tag
  if tag ~= "Plain" and tag ~= "Para" then
    return nil, content
  end
  if #first.content ~= 1 or first.content[1].tag ~= "Strong" then
    return nil, content
  end

  local label_inlines = first.content[1].content
  local remaining = {}
  for i = 2, #content do
    table.insert(remaining, content[i])
  end
  return label_inlines, remaining
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Renders per theme/default.css §9 STATEMENT BLOCKS: a two-column grid
-- (`.richmd-statement`) with an accent-colored label on the left
-- (`.richmd-statement-label`) and the body wrapped in a paragraph on the
-- right (`.richmd-statement-body`). The new theme applies the SAME accent
-- color to every statement's label regardless of `type` — there is no
-- `.richmd-statement--{type}` modifier rule in the CSS — so `type` is kept
-- only as semantic authoring metadata (schema still requires it) and is no
-- longer projected into a CSS class.
local function render(block, resolved_attrs)
  local label_inlines, remaining = extract_label(block.content)

  local inner = {}
  if label_inlines then
    -- Re-wrap in Strong: label_inlines is the Strong run's INNER content
    -- (extract_label unwraps it to isolate the label text), so the visual
    -- boldness must be re-applied here rather than assumed to survive.
    table.insert(
      inner,
      pandoc.Div(
        { pandoc.Plain({ pandoc.Strong(label_inlines) }) },
        pandoc.Attr("", { "richmd-statement-label" })
      )
    )
  end

  -- Body content is wrapped in a single <p class="richmd-statement-body">.
  -- Pandoc's native Para block carries no Attr, so raw HTML markers bracket
  -- a Para built from the flattened inlines (joined by a soft break where
  -- multiple blocks existed) to produce a single real <p class="..."> in
  -- the HTML writer's output, matching the theme's exact markup contract.
  local body_inlines = {}
  for i, b in ipairs(remaining) do
    if i > 1 then
      table.insert(body_inlines, pandoc.SoftBreak())
    end
    for _, inline in ipairs(b.content) do
      table.insert(body_inlines, inline)
    end
  end
  table.insert(
    inner,
    pandoc.RawBlock("html", '<p class="richmd-statement-body">')
  )
  table.insert(inner, pandoc.Plain(body_inlines))
  table.insert(inner, pandoc.RawBlock("html", "</p>"))

  return pandoc.Div(inner, pandoc.Attr("", { "richmd-statement" }))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("labeled-block", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
