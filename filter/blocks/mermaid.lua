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
  attrs = {
    -- Optional caption rendered above the diagram inside the shared
    -- `.richmd-diagram` panel (theme/default.css §10) — the same
    -- `.richmd-diagram-title` concept vega-lite.lua's schema also declares.
    -- Follows the exact optional-string-attr shape every other kind uses
    -- (e.g. embedded-svg.lua's `file`, required=true there vs. optional
    -- here) — no special-casing in the generic validate_attrs/render_fn
    -- pipeline (design.md §00 invariant).
    title = {
      required = false,
      type = "string",
    },
  },
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
-- by default (ADR-0004: CDN default, --offline bundling opt-in via
-- RICHMD_OFFLINE, issue #7).
local MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"

-- MERMAID_OFFLINE_BUNDLE_PATH: the SAME mermaid version pinned above,
-- already present on disk as the browser-ready UMD bundle the `mermaid` npm
-- dependency itself ships (node_modules/mermaid/dist/mermaid.min.js) —
-- resolved relative to script_dir exactly like theme/default.css is
-- resolved in richmd-filter.lua, so this works identically from the source
-- checkout and from the Nix-packaged install (verified: buildNpmPackage's
-- `npm install` step places node_modules/mermaid alongside bin/filter/theme
-- inside $out/lib/node_modules/richmd). Reading this file directly avoids an
-- HTTP fetch at render time entirely — no network dependency, no cache
-- invalidation concern, and it is guaranteed to match the exact version
-- mermaid-check.js already validates against.
local MERMAID_OFFLINE_BUNDLE_PATH = script_dir .. "../node_modules/mermaid/dist/mermaid.min.js"

-- read_offline_bundle() -> string
--
-- Reads the pinned mermaid.js UMD bundle fresh on every offline render
-- (design.md §07 "downloads/embeds the pinned versions once" refers to
-- once-per-render, not a persistent cache across CLI invocations — the
-- acceptance criteria only require correctness, and re-reading a local file
-- already on disk is cheap enough that adding a cross-process cache would
-- be complexity with no measurable benefit). A missing file is a hard
-- filter failure naming the path, not a silent fallback to the CDN
-- reference — offline mode must never silently produce a page that still
-- needs network access.
local function read_offline_bundle()
  local file = io.open(MERMAID_OFFLINE_BUNDLE_PATH, "r")
  if not file then
    error("richmd: --offline requested but could not open pinned mermaid bundle at " .. MERMAID_OFFLINE_BUNDLE_PATH)
  end
  local source = file:read("*a")
  file:close()
  return source
end

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

-- mermaid_theme_variables_js() -> string
--
-- A JS expression (embedded verbatim into each diagram's own inline
-- <script>) that maps `window.richmdDiagramTheme()`'s live-CSS color object
-- (richmd-filter.lua's diagram_theme_script_html(), emitted once per page)
-- into the shape mermaid's own `themeVariables` expects when
-- `theme: 'base'` is selected. This is the ONLY place mermaid.lua knows
-- about mermaid's specific themeVariables field names — no hex value is
-- ever hardcoded here (design.md §00 principle P3 / §07): every color comes
-- from the shared `richmdDiagramTheme()` object, which itself reads
-- `--richmd-*` custom properties live via getComputedStyle at call time.
-- `theme: 'base'` is mermaid's own documented mechanism for a
-- fully-custom theme driven entirely by `themeVariables` rather than one of
-- mermaid's built-in named themes (default/dark/forest/neutral) — using any
-- built-in theme here would reintroduce exactly the hardcoded-elsewhere's-
-- palette problem this chunk removes.
local function mermaid_theme_variables_js()
  return [[function (c) {
      return {
        background: c.bg,
        primaryColor: c.surface,
        primaryTextColor: c.text,
        primaryBorderColor: c.border,
        lineColor: c.accentSolid,
        secondaryColor: c.surface2,
        tertiaryColor: c.surface2,
        actorBkg: c.surface,
        actorBorder: c.border,
        actorTextColor: c.text,
        signalColor: c.text,
        signalTextColor: c.text,
        noteBkgColor: c.accentTint,
        noteTextColor: c.text,
        noteBorderColor: c.border,
        fontFamily: c.fontBody,
      };
    }]]
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Embeds the raw mermaid source in a <pre class="mermaid"> container (per
-- design.md §07) and lets the client-side mermaid.js runtime render the
-- diagram in the reader's browser — but, unlike before this chunk, never via
-- `mermaid.initialize({ startOnLoad: true })`'s own auto-scan-and-render.
-- Instead each diagram's own inline <script> explicitly calls mermaid's
-- async `mermaid.render(id, source)` API itself, with `theme: 'base'` plus
-- `themeVariables` built from the page's LIVE --richmd-* colors (via the
-- shared `window.richmdDiagramTheme()` helper), and injects the resulting
-- SVG into a dedicated target <div> (the source-bearing <pre> is hidden via
-- inline `display:none` and kept around purely as the data source for
-- re-renders — never removed from the DOM). The same render logic is
-- wrapped in a named function and pushed onto the shared
-- `window.richmdDiagramRerenders` array (richmd-filter.lua's
-- diagram_theme_script_html()), so clicking the theme toggle re-invokes it
-- with freshly-read colors — this is the "expose a way to re-render"
-- requirement from design.md §07 / this chunk's work order.
--
-- The `.render()` promise's `.catch()` handles the render-time failure
-- mermaid-check.js's build-time syntax check cannot catch (e.g.
-- semantically-invalid diagrams mermaid's own grammar parser accepts but
-- its renderer rejects): it logs the diagram id and the error to the
-- console, then un-hides the source <pre> (undoing its default
-- `display:none`) and replaces the target div's contents with a short
-- visible error notice, so a failed diagram reads as "broken" rather than
-- as blank space with no signal at all. This lives inside the shared
-- renderMermaid_<id> function itself (not appended only to the first call)
-- so re-renders on theme toggle get the same failure handling.
--
-- Default mode (RICHMD_OFFLINE unset, ADR-0004's default): a CDN
-- <script type="module"> that imports mermaid and assigns it to
-- `window.mermaid` (mermaid's ESM export is scoped to the importing module,
-- not global by default — every diagram's own script tag needs the SAME
-- mermaid instance, so the first one to run publishes it to `window`).
--
-- Offline mode (RICHMD_OFFLINE=1, set by `richmd render --offline` via
-- bin/richmd.js, the SAME env-var-signal pattern as RICHMD_VALIDATE_ONLY):
-- the pinned mermaid.js UMD bundle's full source is embedded directly in a
-- plain inline <script> tag (no `type="module"`, since the UMD build
-- assigns `globalThis.mermaid` itself rather than exporting an ES module) —
-- no CDN URL anywhere in the output. The UMD bundle is only embedded once
-- per page (a page-level guard checks `window.mermaid` isn't already set)
-- to avoid re-defining the runtime once per diagram on multi-diagram pages.
--
-- The whole diagram (optional title + the <pre class="mermaid
-- richmd-mermaid"> content + the render target) is wrapped in the shared
-- `.richmd-diagram` panel (theme/default.css §10) — the same outer panel
-- concept vega-lite.lua's render_fn wraps its own chart target in.
local function render(block, resolved_attrs)
  local source = block.text or ""
  local diagram_id = "richmd-mermaid-" .. tostring(math.random(1, 1000000000))
  local target_id = diagram_id .. "-target"

  local pre_html = '<pre class="mermaid richmd-mermaid" id="'
    .. diagram_id
    .. '" style="display:none">'
    .. html_escape(source)
    .. "</pre>"
  local target_html = '<div class="richmd-mermaid" id="' .. target_id .. '"></div>'

  -- render_call_js: the actual per-diagram render logic, shared verbatim
  -- between the initial render and every subsequent re-render (the toggle
  -- click included) — defined as a named function and both called
  -- immediately AND pushed onto the shared rerender array, so "render once"
  -- and "re-render on demand" can never drift apart into two copies of the
  -- same logic.
  local render_call_js = "  function renderMermaid_"
    .. diagram_id:gsub("-", "_")
    .. "() {\n"
    .. "    var sourceEl = document.getElementById('"
    .. diagram_id
    .. "');\n"
    .. "    var targetEl = document.getElementById('"
    .. target_id
    .. "');\n"
    .. "    if (!sourceEl || !targetEl || !window.mermaid) return;\n"
    .. "    var colors = window.richmdDiagramTheme ? window.richmdDiagramTheme() : {};\n"
    .. "    window.mermaid.initialize({\n"
    .. "      startOnLoad: false,\n"
    .. "      theme: 'base',\n"
    .. "      themeVariables: ("
    .. mermaid_theme_variables_js()
    .. ")(colors),\n"
    .. "    });\n"
    .. "    window.mermaid\n"
    .. "      .render('"
    .. target_id
    .. "-svg', sourceEl.textContent)\n"
    .. "      .then(function (result) {\n"
    .. "        targetEl.innerHTML = result.svg;\n"
    .. "      })\n"
    .. "      .catch(function (err) {\n"
    .. "        console.error('richmd: mermaid diagram \""
    .. diagram_id
    .. "\" failed to render: ' + (err && err.message ? err.message : err));\n"
    .. "        sourceEl.style.display = 'block';\n"
    .. "        targetEl.innerHTML = '<div class=\"richmd-mermaid-error\">Mermaid diagram failed to render (see console) — showing raw source below.</div>';\n"
    .. "      });\n"
    .. "  }\n"
    .. "  window.richmdDiagramRerenders = window.richmdDiagramRerenders || [];\n"
    .. "  window.richmdDiagramRerenders.push(renderMermaid_"
    .. diagram_id:gsub("-", "_")
    .. ");\n"
    .. "  renderMermaid_"
    .. diagram_id:gsub("-", "_")
    .. "();\n"

  local script_html
  if os.getenv("RICHMD_OFFLINE") then
    local bundle_source = read_offline_bundle()
    script_html = "<script>\n"
      .. "  if (!window.mermaid) {\n"
      .. bundle_source
      .. "\n  }\n"
      .. render_call_js
      .. "</script>"
  else
    script_html = "<script type=\"module\">\n"
      .. "  if (!window.mermaid) {\n"
      .. "    var mermaidModule = await import('"
      .. MERMAID_CDN_URL
      .. "');\n"
      .. "    window.mermaid = mermaidModule.default;\n"
      .. "  }\n"
      .. render_call_js
      .. "</script>"
  end

  local title_html = ""
  if resolved_attrs.title then
    title_html = "<div class=\"richmd-diagram-title\">" .. html_escape(resolved_attrs.title) .. "</div>"
  end

  local panel_html = "<div class=\"richmd-diagram\">" .. title_html .. pre_html .. target_html .. "</div>"

  return pandoc.Div({
    pandoc.RawBlock("html", panel_html),
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
