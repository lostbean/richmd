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
  attrs = {
    -- Optional caption rendered above the chart inside the shared
    -- `.richmd-diagram` panel (theme/default.css §10) — the same
    -- `.richmd-diagram-title` concept mermaid.lua's schema also declares.
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
local VEGA_CDN_URL = "https://cdn.jsdelivr.net/npm/vega@6"
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
-- For embedding text inside ordinary HTML content (e.g. the optional
-- .richmd-diagram-title), where `<`/`>`/`&` must be entity-escaped or the
-- browser's HTML parser would misinterpret them as markup.
local function html_escape(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- escape_script_close(text) -> string
--
-- A <script> element's content (regardless of its `type`) is raw text to
-- the HTML parser, never re-parsed as HTML — entity-escaping `<`/`>`/`&`
-- inside it is wrong and corrupts the JSON (e.g. a spec's `"a > b"` test
-- expression becomes the literal string "a &gt; b", which the JS/JSON
-- consumer then fails to parse or evaluates incorrectly). The ONLY real
-- hazard is a literal `</script` sequence inside the JSON breaking the
-- browser out of the script element early; escape only that.
local function escape_script_close(text)
  return (text:gsub("</[Ss][Cc][Rr][Ii][Pp][Tt]", "<\\/script"))
end

-- richmd_merge_config_js() -> string
--
-- A generic, recursive deep-merge JS function embedded once per diagram
-- (kept small and self-contained rather than pulled from a shared script,
-- since — unlike richmdDiagramTheme — this is pure logic with zero
-- CSS/DOM dependency, and mirrors mermaid.lua's own pattern of embedding
-- its small per-diagram JS helpers inline). `richmdMergeConfig(base,
-- override)` returns a new object with `base`'s keys as the starting
-- point, recursively replaced by any key `override` itself explicitly
-- sets — i.e. the AUTHOR'S OWN spec `config` (passed as `override`) always
-- wins over richmd's injected base config, at any nesting depth (e.g. the
-- author setting only `config.axis.labelColor` leaves richmd's own
-- `config.axis.gridColor` intact, rather than the author's partial `axis`
-- object clobbering richmd's whole `axis` block). This is a plain
-- structural merge, not vega-lite's own internal config-merge semantics —
-- investigated and intentionally not relied upon here, since vegaEmbed's
-- own `opts.config` + spec-`config` merge order is an internal
-- implementation detail of vega-lite's `mergeConfig`, not part of its
-- stable public contract; doing the merge explicitly in richmd's own JS
-- guarantees "author wins" regardless of vega-lite version behavior.
local function richmd_merge_config_js()
  return [[function richmdMergeConfig(base, override) {
    if (
      typeof base !== "object" ||
      base === null ||
      Array.isArray(base) ||
      typeof override !== "object" ||
      override === null ||
      Array.isArray(override)
    ) {
      return override !== undefined ? override : base;
    }
    var result = {};
    var key;
    for (key in base) {
      result[key] = base[key];
    }
    for (key in override) {
      result[key] = richmdMergeConfig(base[key], override[key]);
    }
    return result;
  }]]
end

-- richmd_measure_width_js() -> string
--
-- A small JS helper that measures the `.richmd-vega` target element's own
-- actual rendered content width via `getBoundingClientRect().width` — the
-- ONLY way to learn a container's real pixel width, since it depends on the
-- surrounding page's layout (`.richmd-container`/`.richmd-container--wide`,
-- design.md §07, plus the `.richmd-diagram` panel's own padding) which is not
-- knowable at Lua/build time (bug confirmed via direct browser inspection: a
-- chart in a 662px-wide `.richmd-diagram` panel rendered its actual canvas at
-- only ~218px, vega-lite's own ~200px built-in default, because no `width`
-- was ever injected here before this fix).
--
-- `.richmd-vega` (theme/default.css §10) is itself `display: block; width:
-- 100%` with NO padding of its own — the padding lives on its `.richmd-diagram`
-- ANCESTOR — so measuring the `.richmd-vega` target div directly already
-- yields the correct content width with nothing further to subtract;
-- confirmed with a real headless-browser check
-- (getComputedStyle(target).padding === "0px" on the actual rendered page).
--
-- Timing: investigated whether "measure too early returns 0" is a real
-- hazard here specifically, rather than assuming a naive fix works. This
-- function's caller (embedRichmdVega_<id>, below) already only ever runs
-- from two places: (1) synchronously, inline, as the very next sibling
-- <script> the HTML parser reaches right after this diagram's own
-- `<div class="richmd-vega">` — by that point in the document, the theme
-- stylesheet is already fully parsed (injected into <head>, which the parser
-- reaches before <body>) and the three vega CDN `<script src>` tags
-- immediately above this inline script are render-blocking (no async/defer),
-- so the browser has already computed layout for every element the parser
-- has reached so far; and (2) from `window.richmdRerenderDiagrams()`, called
-- long after DOMContentLoaded by the theme toggle. A real headless-browser
-- reproduction (chrome-devtools MCP) confirmed the container already reports
-- its correct final width at the synchronous call site (790px/982px in two
-- separate real-page checks, not 0) — because unlike an <img> or external
-- stylesheet, nothing this diagram's own layout depends on is still
-- in-flight when this script runs. This function still defensively treats a
-- non-positive measurement as "unknown" (returns null, meaning "do not
-- override") rather than ever injecting a bogus 0/negative width, in case a
-- consumer's own CSS produces a genuinely collapsed container (e.g. a
-- `display: none` ancestor) — safer to fall through to vega-lite's own
-- default than to force width:0.
local function richmd_measure_width_js()
  return [[function richmdMeasureVegaWidth(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return null;
    }
    var width = target.getBoundingClientRect().width;
    return width > 0 ? width : null;
  }]]
end

-- vega_lite_base_config_js() -> string
--
-- A JS expression that maps `window.richmdDiagramTheme()`'s live-CSS color
-- object into the `config` shape vega-lite's own spec.config accepts —
-- transparent background (the diagram panel already supplies one via
-- theme/default.css §10), muted-color axis/legend text, a low-contrast
-- grid line, and no view border (the outer `.richmd-diagram` panel already
-- draws one). No hex value is hardcoded here (design.md §00 principle P3 /
-- §07): every color comes from the shared `richmdDiagramTheme()` object.
local function vega_lite_base_config_js()
  return [[function (c) {
    return {
      background: "transparent",
      font: c.fontBody,
      axis: {
        labelColor: c.textMuted,
        titleColor: c.textMuted,
        gridColor: c.border,
        domainColor: c.border,
        tickColor: c.border,
        labelFontSize: 11,
        titleFontSize: 11,
      },
      legend: {
        labelColor: c.textMuted,
        titleColor: c.textMuted,
        labelFontSize: 11,
      },
      view: {
        stroke: "transparent",
      },
    };
  }]]
end

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Embeds the raw vega-lite JSON spec in a <div class="richmd-vega">
-- container (a <script type="application/json"> child holds the spec text
-- itself, so it is never parsed/executed as markup) and lets the
-- client-side vega-embed runtime render the chart in the reader's browser
-- on page load — never pre-rendered to a static image here, per design.md
-- §00/§07. The container's class is `richmd-vega`, matching the actual
-- selector theme/default.css §10 targets (`.richmd-vega svg, .richmd-vega
-- canvas { max-width: 100% }`) — NOT `richmd-vega-lite`, which the new CSS
-- does not reference at all. The `<script type="application/json"
-- class="richmd-vega-lite-spec">` data-carrier element is unchanged: it is
-- never styled/selected, only read via getElementById().nextElementSibling
-- at render time, so renaming it would be a pointless internal-detail
-- churn (confirmed "richmd-vega-lite-spec" does not appear anywhere in
-- theme/default.css).
--
-- The whole chart (optional title + the .richmd-vega target div) is now
-- wrapped in the shared `.richmd-diagram` panel (theme/default.css §10) —
-- the same outer panel concept mermaid.lua's render_fn wraps its own <pre>
-- in. The outer wrapper Div's own class changes from
-- `richmd-vega-lite-wrapper` to `richmd-diagram-wrapper`: `.richmd-diagram`
-- is now the single styled outer panel every diagram kind shares, so the
-- per-kind wrapper Div class is purely a pandoc-AST grouping device (never
-- itself selected by the new CSS) and should name the shared concept, not
-- the old per-kind one, for consistency with mermaid.lua's identical
-- wrapper-Div role.
--
-- Rendering is now an explicit, re-invokable function (embedRichmdVega_*)
-- rather than a fire-and-forget vegaEmbed() call: it re-parses the spec
-- from its <script type="application/json"> source each time (never
-- mutating a shared spec object across calls), builds a fresh `config`
-- object from the page's LIVE --richmd-* colors (via the shared
-- `window.richmdDiagramTheme()` helper, richmd-filter.lua's
-- diagram_theme_script_html()), deep-merges it with the author's OWN
-- spec.config if present (richmd_merge_config_js() above — author's
-- explicit settings always win), and calls `vegaEmbed(target, spec,
-- {actions:false})`. The same function is both called immediately AND
-- pushed onto the shared `window.richmdDiagramRerenders` array, so
-- clicking the theme toggle re-embeds the chart with freshly-read colors
-- — "render once" and "re-render on toggle" share one code path, never two
-- copies that could drift.
--
-- Default mode (RICHMD_OFFLINE unset, ADR-0004's default): three CDN
-- `<script src>` references (vega, vega-lite, vega-embed, in that
-- dependency order — vega-embed's own documented usage) followed by a
-- plain inline `<script>` that defines and calls the render function.
--
-- Width injection (bug fix): the author's own spec is embedded verbatim
-- with no `width` field of its own in the vast majority of real specs, so
-- without intervention vega-lite silently falls back to its own ~200px
-- built-in default, regardless of how wide the surrounding
-- `.richmd-diagram` panel actually is (confirmed via direct browser
-- inspection — see richmd_measure_width_js's own comment above). The target
-- container's actual rendered width is measured at call time (never at
-- Lua/build time, which cannot know it) via richmdMeasureVegaWidth, and
-- injected as the spec's `width` ONLY when the author's own spec did not
-- already set one explicitly (`typeof spec.width !== "undefined"` — the
-- author's explicit choice always wins, never overridden, exactly like
-- richmd_merge_config_js's "author wins" rule for `config`). A `window
-- .addEventListener("resize", ...)` (lightly debounced via
-- `requestAnimationFrame` so a drag-resize doesn't fire dozens of
-- back-to-back vegaEmbed calls) re-runs the SAME embedRichmdVega_<id>
-- function on every resize, re-measuring and re-injecting the width fresh
-- each time — reusing the identical "re-parse spec from source, rebuild
-- config/width, call vegaEmbed" code path the theme-toggle re-render already
-- uses (richmdDiagramRerenders), rather than a second, divergent resize-only
-- code path.
--
-- Offline bundling (RICHMD_OFFLINE=1) is not yet implemented for
-- vega-lite in this chunk — see the module-level note below.
local function render(block, resolved_attrs)
  local source = block.text or ""
  local container_id = "richmd-vega-" .. tostring(math.random(1, 1000000000))
  local fn_suffix = container_id:gsub("-", "_")

  local spec_html = "<div id=\""
    .. container_id
    .. "\" class=\"richmd-vega\"></div>\n"
    .. "<script type=\"application/json\" class=\"richmd-vega-lite-spec\">"
    .. escape_script_close(source)
    .. "</script>"

  local title_html = ""
  if resolved_attrs.title then
    title_html = "<div class=\"richmd-diagram-title\">" .. html_escape(resolved_attrs.title) .. "</div>"
  end

  local panel_html = "<div class=\"richmd-diagram\">" .. title_html .. spec_html .. "</div>"

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
    .. "    "
    .. richmd_merge_config_js()
    .. "\n"
    .. "    "
    .. richmd_measure_width_js()
    .. "\n"
    .. "    function embedRichmdVega_"
    .. fn_suffix
    .. "() {\n"
    .. "      var containerEl = document.getElementById('"
    .. container_id
    .. "');\n"
    .. "      var specEl = containerEl.nextElementSibling;\n"
    .. "      var spec = JSON.parse(specEl.textContent);\n"
    .. "      var colors = window.richmdDiagramTheme ? window.richmdDiagramTheme() : {};\n"
    .. "      var baseConfig = ("
    .. vega_lite_base_config_js()
    .. ")(colors);\n"
    .. "      var mergedConfig = richmdMergeConfig(baseConfig, spec.config || {});\n"
    .. "      var mergedSpec = Object.assign({}, spec, { config: mergedConfig });\n"
    .. "      if (typeof mergedSpec.width === 'undefined') {\n"
    .. "        var measuredWidth = richmdMeasureVegaWidth(containerEl);\n"
    .. "        if (measuredWidth !== null) {\n"
    .. "          mergedSpec.width = measuredWidth;\n"
    .. "        }\n"
    .. "      }\n"
    .. "      vegaEmbed('#"
    .. container_id
    .. "', mergedSpec, { actions: false });\n"
    .. "    }\n"
    .. "    window.richmdDiagramRerenders = window.richmdDiagramRerenders || [];\n"
    .. "    window.richmdDiagramRerenders.push(embedRichmdVega_"
    .. fn_suffix
    .. ");\n"
    .. "    embedRichmdVega_"
    .. fn_suffix
    .. "();\n"
    .. "    var resizeRaf_"
    .. fn_suffix
    .. " = null;\n"
    .. "    window.addEventListener('resize', function () {\n"
    .. "      if (resizeRaf_"
    .. fn_suffix
    .. " !== null) {\n"
    .. "        cancelAnimationFrame(resizeRaf_"
    .. fn_suffix
    .. ");\n"
    .. "      }\n"
    .. "      resizeRaf_"
    .. fn_suffix
    .. " = requestAnimationFrame(function () {\n"
    .. "        resizeRaf_"
    .. fn_suffix
    .. " = null;\n"
    .. "        embedRichmdVega_"
    .. fn_suffix
    .. "();\n"
    .. "      });\n"
    .. "    });\n"
    .. "  })();\n"
    .. "</script>"

  return pandoc.Div({
    pandoc.RawBlock("html", panel_html),
    pandoc.RawBlock("html", script_html),
  }, pandoc.Attr("", { "richmd-diagram-wrapper" }))
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
