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
    -- The fixed label rendered above the list (`.richmd-toc-title`, theme
    -- default.css §3). Optional; defaults to "Contents" — following the
    -- same `{required=false, type="string"}` optional-string-attr shape
    -- every other kind's authorable text uses (e.g. embedded-svg's `file`,
    -- but non-required), rather than hardcoding the label, so a document
    -- that wants a different heading ("On this page", localized text, etc.)
    -- can author one without richmd needing a special case for it.
    title = {
      required = false,
      type = "string",
    },
  },
  -- A TOC block is generated, not authored — `::: {.toc}` is written empty.
  body = "forbidden",
}

local DEFAULT_TITLE = "Contents"

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

-- html_escape(text) -> string
--
-- Escapes the three characters that would otherwise be misinterpreted by
-- an HTML parser inside the raw <ul>/<li> markup this renderer emits (see
-- render() below for why raw HTML is needed here). Same rationale and same
-- three-character set as mermaid.lua's and vega-lite.lua's html_escape.
local function html_escape(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Builds `<div class="richmd-toc"><div class="richmd-toc-title">...</div>
-- <ul class="richmd-toc-list">...</ul></div>` (theme default.css §3) from
-- the collected headings, filtered to `max-depth` levels when given.
--
-- The shallowest heading level actually present in the FILTERED set (not
-- necessarily h1 — a document's real top level, or whatever `max-depth`
-- left standing) is the "top" tier; anything deeper gets the
-- `richmd-toc-sub` modifier class on its <li>. This is a simple two-tier
-- distinction (top vs. sub), not one class per heading level 1-6: the
-- theme's `.richmd-toc-list .richmd-toc-sub` rule only defines one
-- "sub" visual treatment, so a third tier would have no stylesheet rule to
-- land on anyway.
--
-- Emitted as raw HTML rather than a native pandoc.BulletList: Pandoc's Lua
-- AST has no way to put a class on an individual <li>, or on the <ul>
-- itself (BulletList carries no Attr) — the exact same constraint
-- embedded-svg.lua/mermaid.lua/vega-lite.lua hit for their own
-- theme-contract markup, hence the same RawBlock("html", ...) + local
-- html_escape pattern used there.
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

  local title_text = resolved_attrs.title
  if not title_text or title_text == "" then
    title_text = DEFAULT_TITLE
  end
  local title_html = '<div class="richmd-toc-title">' .. html_escape(title_text) .. "</div>"

  if #filtered == 0 then
    return pandoc.Div(
      { pandoc.RawBlock("html", title_html) },
      pandoc.Attr("", { "richmd-toc" })
    )
  end

  local top_level = filtered[1].level
  for _, h in ipairs(filtered) do
    if h.level < top_level then
      top_level = h.level
    end
  end

  local list_html_parts = { '<ul class="richmd-toc-list">' }
  for _, h in ipairs(filtered) do
    local li_class = ""
    if h.level > top_level then
      li_class = ' class="richmd-toc-sub"'
    end
    table.insert(
      list_html_parts,
      "<li"
        .. li_class
        .. '><a href="#'
        .. html_escape(h.slug)
        .. '">'
        .. html_escape(h.text)
        .. "</a></li>"
    )
  end
  table.insert(list_html_parts, "</ul>")
  local list_html = table.concat(list_html_parts)

  return pandoc.Div(
    { pandoc.RawBlock("html", title_html), pandoc.RawBlock("html", list_html) },
    pandoc.Attr("", { "richmd-toc" })
  )
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
