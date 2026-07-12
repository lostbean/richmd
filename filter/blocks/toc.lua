-- richmd built-in block kind: toc.
--
-- Auto-generated from headings (design.md §04 registry card): `::: {.toc}`
-- carries no authored content of its own — its rendered output is a table
-- of contents generated FROM the surrounding document's own headings, not
-- from whatever (nothing) is inside the div.
--
-- INTERFACE NOTE (read before touching this file): the locked render_fn
-- signature is `render_fn(block, resolved_attrs) -> pandoc_ast_node` —
-- block-scoped only, no whole-document `doc` parameter, and richmd-filter.lua's
-- Div dispatch (`richmd_kind_of`/`render_only_div`) is out of scope for this
-- chunk. Rather than threading a `doc` parameter through the render_fn
-- contract (an interface change affecting every registered kind) or
-- stashing headings in a module-level global written from
-- richmd-filter.lua's Header handling (a hidden coupling between this file
-- and the filter core's dispatch, exactly what the work order called out to
-- avoid), this kind independently RE-READS its own source document from
-- disk and re-parses it with Pandoc, mirroring the exact pattern
-- richmd-filter.lua's own `target_heading_slugs` already uses to check
-- `#fragment` link targets against a DIFFERENT document's headings — the
-- only difference here is the target document is the current one. This
-- keeps toc.lua fully self-contained: it needs nothing from richmd-filter.lua
-- beyond the one `register(registry)` call every other kind gets, and it
-- reuses the SAME Slugify.slugify function the render phase uses to assign
-- heading ids, so a TOC entry's link and its target heading's id can never
-- disagree (§00 invariant).

local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"
package.path = script_dir .. "../?.lua;" .. package.path
local Slugify = require("slugify")

local schema = {
  kind = "toc",
  attrs = {
    -- How many heading levels deep to include (H1=1 .. H6=6). Optional;
    -- defaults to including every heading level found.
    ["max-depth"] = {
      required = false,
      type = "string",
    },
  },
  -- A TOC block is generated, not authored — `::: {.toc}` is written empty.
  body = "forbidden",
}

-- current_doc_path() -> string | nil
--
-- Same PANDOC_STATE.input_files derivation richmd-filter.lua's
-- current_doc_dir uses — richmd is always invoked with exactly one input
-- file (bin/richmd.js).
local function current_doc_path()
  local input_files = PANDOC_STATE and PANDOC_STATE.input_files
  return input_files and input_files[1]
end

-- collect_headings(doc_path) -> { {level, text, slug}, ... }
--
-- Re-reads and re-parses the current document from disk, independently of
-- whatever AST node richmd-filter.lua is walking when it reaches this
-- block, and walks its Headers in document order — the exact structure a
-- table of contents needs. Uses the SAME Slugify.slugify function (and a
-- fresh seen-slugs table, since this is a brand-new, from-scratch walk) the
-- render phase uses for the REAL heading ids, so an entry generated here
-- always names a fragment that will genuinely exist in this same rendered
-- page.
local function collect_headings(doc_path)
  local file = io.open(doc_path, "r")
  if not file then
    return nil, "could not open source document '" .. doc_path .. "' to build table of contents"
  end
  local content = file:read("*a")
  file:close()

  local ok, doc = pcall(pandoc.read, content, "markdown")
  if not ok then
    return nil, "could not parse source document '" .. doc_path .. "' to build table of contents"
  end

  local headings = {}
  local seen_slugs = Slugify.new_seen()
  doc:walk({
    Header = function(header)
      local text = pandoc.utils.stringify(header.content)
      local slug = Slugify.slugify(text, seen_slugs)
      table.insert(headings, { level = header.level, text = text, slug = slug })
    end,
  })
  return headings, nil
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Builds a list of links (`#slug`) from the collected headings, filtered to
-- `max-depth` levels when given. Each entry carries a per-level modifier
-- class rather than true nested <ul>/<li> structure (see the comment on
-- list_items below for why) — visually indented by the stylesheet
-- according to heading depth.
local function render(_block, resolved_attrs)
  local doc_path = current_doc_path()
  if not doc_path then
    error("richmd: toc block could not determine the current document's path")
  end

  local headings, err = collect_headings(doc_path)
  if not headings then
    error("richmd: " .. err)
  end

  local max_depth = tonumber(resolved_attrs["max-depth"])
  local filtered = {}
  for _, h in ipairs(headings) do
    if not max_depth or h.level <= max_depth then
      table.insert(filtered, h)
    end
  end

  if #filtered == 0 then
    return pandoc.Div({}, pandoc.Attr("", { "richmd-toc" }))
  end

  -- Each entry is its own Div carrying a per-level modifier class (rather
  -- than a native <ul>/<li>, which cannot carry a per-item attr in Pandoc's
  -- AST) — the stylesheet renders the level classes as an indented list
  -- visually. Simpler than re-deriving true parent/child nesting rules for
  -- skipped levels (e.g. an H1 followed directly by an H3), and just as
  -- navigable.
  local list_items = {}
  for _, h in ipairs(filtered) do
    local link = pandoc.Link({ pandoc.Str(h.text) }, "#" .. h.slug)
    local item_attr =
      pandoc.Attr("", { "richmd-toc__item", "richmd-toc__item--level-" .. tostring(h.level) })
    table.insert(list_items, pandoc.Div({ pandoc.Plain({ link }) }, item_attr))
  end

  return pandoc.Div(list_items, pandoc.Attr("", { "richmd-toc" }))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("toc", schema, render)
end

return {
  schema = schema,
  render = render,
  register = register,
}
