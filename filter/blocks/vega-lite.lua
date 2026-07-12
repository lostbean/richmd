-- richmd built-in block kind: vega-lite.
--
-- A ```vega-lite fenced code block (design.md §04/§05/§07) — NOT a fenced
-- div like callout, and following the exact same CodeBlock-kind pattern as
-- mermaid.lua. This is the only file allowed to know that "vega-lite"
-- exists as a concept — the filter core and the registry's lookup loop stay
-- generic. The filter core dispatches CodeBlocks with a "vega-lite" class to
-- this kind's schema/render_fn via the SAME registry:lookup mechanism used
-- for every other kind; see richmd-filter.lua's CodeBlock walk entries.
--
-- Validation shells out to helpers/vega-lite-check.js (JSON-schema
-- validation against the published vega-lite JSON schema, no browser/
-- Puppeteer — design.md §05) to catch both malformed JSON and
-- schema-nonconforming vega-lite specs before the render phase is ever
-- reached.
--
-- Rendering never turns the chart into a picture at build time (a named
-- no-goal, design.md §00/§07): the raw JSON spec is embedded in a
-- runtime-recognizable container and the vega-embed CDN runtime renders it
-- client-side, in the reader's browser, on page load — the same spirit as
-- mermaid's <pre class="mermaid"> pattern.

local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"

local schema = {
  kind = "vega-lite",
  attrs = {},
  body = "required",
  -- Optional extra validation hook (beyond generic attrs/body schema
  -- checks): the filter core calls `schema.validate(block, kind_name,
  -- location, add_error)` generically, if present, for ANY registered kind
  -- — never a kind-name check in the filter core itself. vega-lite is the
  -- other built-in kind (alongside mermaid) that needs this: real
  -- JSON-schema checking has no schema-expressible shape within richmd's
  -- own block-kind-schema vocabulary.
  validate = nil, -- set below, after `validate` is defined
}

-- VEGA_CDN_URL / VEGA_LITE_CDN_URL / VEGA_EMBED_CDN_URL: the pinned
-- vega-embed runtime and its own vega/vega-lite peer dependencies, loaded
-- from a CDN by default (ADR-0004: CDN default, --offline bundling opt-in).
-- vega-embed ships as a UMD bundle (confirmed: its jsdelivr-served script
-- is `!function(e,t){"object"==typeof exports...` — a classic UMD wrapper
-- expecting `vega`/`vega-lite` as pre-existing globals, NOT a self-
-- contained ES module), so — per vega-embed's own README-documented CDN
-- usage — all three are loaded as plain `<script src>` tags, in dependency
-- order, and `vegaEmbed(...)` is then called as a global function. This is
-- deliberately NOT mermaid.lua's `<script type="module"> import ...`
-- pattern: mermaid's CDN artifact is its own published ESM build
-- (dist/mermaid.esm.min.mjs), while vega-embed's is not, so copying
-- mermaid's exact script shape here would silently produce a broken
-- `import` of a non-module file.
local VEGA_CDN_URL = "https://cdn.jsdelivr.net/npm/vega@5"
local VEGA_LITE_CDN_URL = "https://cdn.jsdelivr.net/npm/vega-lite@6"
local VEGA_EMBED_CDN_URL = "https://cdn.jsdelivr.net/npm/vega-embed@6"

-- run_vega_lite_check(source) -> valid (bool), reason (string | nil)
--
-- Shells out to the Node grammar-validator helper via io.popen, passing the
-- block's source over stdin and reading its JSON result back from stdout —
-- exactly the shell-out design.md §05 calls for, and the identical
-- mechanism run_mermaid_check (filter/blocks/mermaid.lua) uses. A
-- subprocess that itself fails to run (helper missing, node missing,
-- non-JSON output) is treated as a validation failure naming the raw
-- problem, rather than silently passing the block through.
local function run_vega_lite_check(source)
  local helper_path = script_dir .. "../helpers/vega-lite-check.js"

  -- Write the source to a temp file rather than piping through the shell
  -- directly, to avoid any quoting/escaping hazards with arbitrary JSON
  -- source text (quotes, backslashes, etc.) — same rationale as mermaid's
  -- run_mermaid_check.
  local tmp_path = os.tmpname()
  local tmp_file = io.open(tmp_path, "w")
  if not tmp_file then
    return false, "could not create temp file to invoke vega-lite-check helper"
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
    return false, "could not invoke vega-lite-check helper (node not found?)"
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
    return false, "vega-lite-check helper produced no output"
  end
  return false, "vega-lite-check helper produced unexpected output: " .. output
end

-- validate(block, kind_name, location, add_error)
--
-- Called by the filter core's generic validate step alongside the
-- schema-driven attr/body checks (this kind has no attrs and a required
-- body, both already covered generically) — this function adds the ONE
-- check no generic schema field can express: real JSON-schema validity
-- against the published vega-lite schema. A malformed or nonconforming
-- block's error names the block and the validator's own reason, added to
-- the SAME shared errors list every other kind's errors use (via the
-- add_error callback the filter core passes in), never a separate
-- error-collection path.
local function validate(block, kind_name, location, add_error)
  local source = block.text or ""
  if source == "" then
    -- Already caught by the generic "body is required" schema check; skip
    -- the grammar check as unhelpfully redundant when there is no body.
    return
  end

  local valid, reason = run_vega_lite_check(source)
  if not valid then
    add_error(kind_name, location, "invalid vega-lite spec: " .. (reason or "unknown error"))
  end
end

schema.validate = validate

-- html_escape(text) -> string
--
-- Minimal HTML-entity escaping for embedding the raw JSON spec inside a
-- <script type="application/json"> element — JSON can legitimately contain
-- `<`/`>`/`&` inside string values (e.g. a title like "A & B") which would
-- otherwise be misinterpreted by an HTML parser, so the source is escaped
-- rather than assumed safe. Same rationale as mermaid.lua's html_escape.
local function html_escape(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Embeds the raw vega-lite JSON spec in a <div class="richmd-vega-lite">
-- container (a <script type="application/json"> child holds the spec text
-- itself, so it is never parsed/executed as markup) and lets the
-- client-side vega-embed runtime render the chart in the reader's browser
-- on page load — never pre-rendered to a static image here, per design.md
-- §00/§07.
--
-- Default mode (RICHMD_OFFLINE unset, ADR-0004's default): three CDN
-- `<script src>` references (vega, vega-lite, vega-embed, in that
-- dependency order — vega-embed's own documented usage) followed by a
-- plain inline `<script>` that calls the `vegaEmbed` global against the
-- parsed spec.
--
-- Offline bundling (RICHMD_OFFLINE=1) is not yet implemented for
-- vega-lite in this chunk — see the module-level note below.
local function render(block, _resolved_attrs)
  local source = block.text or ""
  local container_id = "richmd-vega-lite-" .. tostring(math.random(1, 1000000000))

  local spec_html = "<div id=\""
    .. container_id
    .. "\" class=\"richmd-vega-lite\"></div>\n"
    .. "<script type=\"application/json\" class=\"richmd-vega-lite-spec\">"
    .. html_escape(source)
    .. "</script>"

  -- Offline bundling is a follow-up for this kind (see module doc comment
  -- at the top of this file): only the CDN-default path is implemented
  -- here, matching ADR-0004's default mode. RICHMD_OFFLINE has no effect on
  -- vega-lite rendering yet — mermaid's own offline path is unaffected and
  -- continues to work exactly as before.
  local script_html = "<script src=\""
    .. VEGA_CDN_URL
    .. "\"></script>\n"
    .. "<script src=\""
    .. VEGA_LITE_CDN_URL
    .. "\"></script>\n"
    .. "<script src=\""
    .. VEGA_EMBED_CDN_URL
    .. "\"></script>\n"
    .. "<script>\n"
    .. "  (function () {\n"
    .. "    var specEl = document.getElementById('"
    .. container_id
    .. "').nextElementSibling;\n"
    .. "    var spec = JSON.parse(specEl.textContent);\n"
    .. "    vegaEmbed('#"
    .. container_id
    .. "', spec);\n"
    .. "  })();\n"
    .. "</script>"

  return pandoc.Div({
    pandoc.RawBlock("html", spec_html),
    pandoc.RawBlock("html", script_html),
  }, pandoc.Attr("", { "richmd-vega-lite-wrapper" }))
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("vega-lite", schema, render)
end

return {
  schema = schema,
  render = render,
  validate = validate,
  register = register,
}
