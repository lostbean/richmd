-- richmd built-in block kind: mermaid.
--
-- A ```mermaid fenced code block (design.md §04/§05/§07) — NOT a fenced div
-- like callout. This is the only file allowed to know that "mermaid" exists
-- as a concept — the filter core and the registry's lookup loop stay
-- generic. The filter core dispatches CodeBlocks with a "mermaid" class to
-- this kind's schema/render_fn via the SAME registry:lookup mechanism used
-- for Div-shaped kinds (e.g. callout); see richmd-filter.lua's CodeBlock
-- walk entries.
--
-- Validation shells out to helpers/mermaid-check.js (a real grammar parser,
-- no browser/Puppeteer — design.md §05) to catch malformed mermaid syntax
-- before the render phase is ever reached.
--
-- Rendering never turns the diagram into a picture at build time (a named
-- no-goal, design.md §00/§07): the raw source is embedded in a
-- runtime-recognizable container (<pre class="mermaid">) and the mermaid.js
-- CDN runtime renders it client-side, in the reader's browser, on page
-- load.

local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"

local schema = {
  kind = "mermaid",
  attrs = {},
  body = "required",
  -- Optional extra validation hook (beyond generic attrs/body schema
  -- checks): the filter core calls `schema.validate(block, kind_name,
  -- location, add_error)` generically, if present, for ANY registered kind
  -- — never a kind-name check in the filter core itself. Mermaid is the
  -- one built-in kind that needs this (real grammar checking has no
  -- schema-expressible shape); callout has no `validate` field and the
  -- filter core skips the call entirely for it.
  validate = nil, -- set below, after `validate` is defined
}

-- MERMAID_CDN_URL: the pinned mermaid.js runtime script, loaded from a CDN
-- by default (ADR-0004: CDN default, --offline bundling is a later chunk,
-- issue #7 — not implemented here).
local MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"

-- run_mermaid_check(source) -> valid (bool), reason (string | nil)
--
-- Shells out to the Node grammar-validator helper via io.popen, passing the
-- block's source over stdin and reading its JSON result back from stdout —
-- exactly the shell-out design.md §05 calls for. A subprocess that itself
-- fails to run (helper missing, node missing, non-JSON output) is treated
-- as a validation failure naming the raw problem, rather than silently
-- passing the block through.
local function run_mermaid_check(source)
  local helper_path = script_dir .. "../helpers/mermaid-check.js"

  -- Write the source to a temp file rather than piping through the shell
  -- directly, to avoid any quoting/escaping hazards with arbitrary mermaid
  -- source text (backticks, quotes, etc.).
  local tmp_path = os.tmpname()
  local tmp_file = io.open(tmp_path, "w")
  if not tmp_file then
    return false, "could not create temp file to invoke mermaid-check helper"
  end
  tmp_file:write(source)
  tmp_file:close()

  local handle = io.popen("node " .. helper_path .. " < " .. tmp_path .. " 2>&1")
  local output = ""
  if handle then
    output = handle:read("*a") or ""
    handle:close()
  end
  os.remove(tmp_path)

  if not handle then
    return false, "could not invoke mermaid-check helper (node not found?)"
  end

  local valid_true = output:match('"valid"%s*:%s*true')
  local reason = output:match('"reason"%s*:%s*"(.-)"[^"]*"?%s*}')
  if not reason then
    -- Fall back to a looser match in case escaping in the JSON reason
    -- string trips up the pattern above.
    reason = output:match('"reason"%s*:%s*"(.*)"%s*}')
  end

  if valid_true then
    return true, nil
  end

  if reason then
    -- Unescape the common JSON escapes the helper's JSON.stringify would
    -- have produced, so the printed error reads naturally.
    reason = reason:gsub("\\n", " "):gsub('\\"', '"'):gsub("\\\\", "\\")
    return false, reason
  end

  -- No parseable JSON at all — the helper crashed or never ran.
  if output == "" then
    return false, "mermaid-check helper produced no output"
  end
  return false, "mermaid-check helper produced unexpected output: " .. output
end

-- validate(block, kind_name, location, add_error)
--
-- Called by the filter core's generic validate step alongside the
-- schema-driven attr/body checks (this kind has no attrs and a required
-- body, both already covered generically) — this function adds the ONE
-- check no generic schema field can express: real mermaid grammar
-- validity. A malformed block's error names the block and the parser's own
-- reason, added to the SAME shared errors list callout's errors use (via
-- the add_error callback the filter core passes in), never a separate
-- error-collection path.
local function validate(block, kind_name, location, add_error)
  local source = block.text or ""
  if source == "" then
    -- Already caught by the generic "body is required" schema check; skip
    -- the grammar check as unhelpfully redundant when there is no body.
    return
  end

  local valid, reason = run_mermaid_check(source)
  if not valid then
    add_error(kind_name, location, "invalid mermaid syntax: " .. (reason or "unknown error"))
  end
end

schema.validate = validate

-- html_escape(text) -> string
--
-- Minimal HTML-entity escaping for embedding raw mermaid source inside a
-- <pre> element — mermaid syntax can legitimately contain `<`/`>` (e.g.
-- `-->` arrows do not need escaping, but node/edge labels could contain a
-- literal angle bracket or ampersand) so the source is escaped rather than
-- assumed safe.
local function html_escape(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Embeds the raw mermaid source in a <pre class="mermaid"> container (per
-- design.md §07) and lets the client-side mermaid.js runtime (loaded via
-- the CDN script tag injected alongside it) render the diagram in the
-- reader's browser on page load — never pre-rendered to a static SVG here.
local function render(block, _resolved_attrs)
  local source = block.text or ""

  local pre_html = "<pre class=\"mermaid richmd-mermaid\">" .. html_escape(source) .. "</pre>"
  local script_html = "<script type=\"module\">\n"
    .. "  import mermaid from '"
    .. MERMAID_CDN_URL
    .. "';\n"
    .. "  mermaid.initialize({ startOnLoad: true });\n"
    .. "</script>"

  return pandoc.Div({
    pandoc.RawBlock("html", pre_html),
    pandoc.RawBlock("html", script_html),
  }, pandoc.Attr("", { "richmd-mermaid-wrapper" }))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("mermaid", schema, render)
end

return {
  schema = schema,
  render = render,
  validate = validate,
  register = register,
}
