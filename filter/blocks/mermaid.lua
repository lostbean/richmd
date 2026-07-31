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
-- no browser/Puppeteer — design.md §07) to catch malformed mermaid syntax
-- before the render phase is ever reached — ONCE PER DOCUMENT with every
-- mermaid block in it, not once per block (ADR-0018): see `pending` /
-- `validate` / `validate_batch` below.
--
-- Rendering never turns the diagram into a picture at build time (a named
-- no-goal, design.md §00/§07): the raw source is embedded in a
-- runtime-recognizable container (<pre class="mermaid">) and the mermaid.js
-- CDN runtime renders it client-side, in the reader's browser, on page
-- load.

local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"

local BatchCheck = require("batch-check")

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
  -- Companion document-wide hook (design.md §07, ADR-0018): the filter core
  -- calls `schema.validate_batch()` generically, if present, for ANY
  -- registered kind, once after the whole validate walk has finished — the
  -- point at which every block of this kind has been collected. `validate`
  -- above queues; this one runs the single subprocess. Kinds with no
  -- document-wide half (callout, cards, ...) simply do not declare it.
  validate_batch = nil, -- set below, after `validate_batch` is defined
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

-- pending / validate / validate_batch: the two halves of ONE grammar check,
-- split across the filter core's validate phase (design.md §07, ADR-0018).
--
-- `validate` no longer shells out. It only ENQUEUES the block's source, so
-- that `validate_batch` — called once, after the whole document has been
-- walked — can hand every mermaid block in the document to a SINGLE
-- mermaid-check.js subprocess. That is the entire point: the helper
-- initializes a linkedom DOM before it can parse anything, and a
-- one-block-per-process invocation threw that setup away immediately; one
-- process for the document lets the helper's own module-level cache do the
-- job it was written for.
--
-- Module-level state is per-DOCUMENT here for the same reason
-- next_ordinal()'s counter below is: bin/richmd.js spawns one `pandoc`
-- process per document, so this Lua state is created fresh per document and
-- dies with it. The queue is drained by validate_batch, so it is also empty
-- again by the time the render phase runs.
local pending = {}

-- validate(block, kind_name, location, add_error)
--
-- Called by the filter core's generic validate step alongside the
-- schema-driven attr/body checks (this kind has no attrs and a required
-- body, both already covered generically) — this hook covers the ONE check
-- no generic schema field can express: real mermaid grammar validity.
--
-- Queues rather than checks. Each entry carries its own `report` closure
-- over the (kind_name, location, add_error) triple this block was collected
-- under, so a rejection still names THIS block, with the parser's own
-- reason, in the SAME shared errors list callout's errors use — never a
-- separate error-collection path, and never attributed to whichever block
-- happens to be checked alongside it.
local function validate(block, kind_name, location, add_error)
  local source = block.text or ""
  if source == "" then
    -- Already caught by the generic "body is required" schema check; skip
    -- the grammar check as unhelpfully redundant when there is no body.
    return
  end

  table.insert(pending, {
    -- The id only has to be unique within this batch and stable across the
    -- round trip; the ordinal makes it both, and reads back usefully if it
    -- ever surfaces in a diagnostic.
    id = "mermaid-" .. tostring(#pending + 1),
    source = source,
    report = function(reason)
      add_error(kind_name, location, "invalid mermaid syntax: " .. reason)
    end,
  })
end

-- validate_batch()
--
-- The document-wide half: one mermaid-check.js subprocess for every mermaid
-- block collected during the walk, verdicts paired back by id. Called by
-- the filter core generically, for ANY registered kind that declares one,
-- after the validate walk completes — never via an `if kind == "mermaid"`
-- branch in the core.
--
-- A document with no mermaid blocks leaves `pending` empty, and
-- BatchCheck.run spawns nothing at all. Draining the queue makes this
-- idempotent: a second call has nothing left to check.
local function validate_batch()
  local entries = pending
  pending = {}
  BatchCheck.run(script_dir .. "../helpers/mermaid-check.js", "mermaid-check", entries)
end

schema.validate = validate
schema.validate_batch = validate_batch

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

-- diagram_ordinal / next_ordinal() -> integer
--
-- A per-document counter handing each mermaid diagram on the page its own
-- ordinal, in document order: 1, 2, 3... The ordinal is the ONLY varying
-- part of the ids below, which makes the whole rendered page a pure function
-- of its source — the property design.md §02's `--check` contract depends on
-- ("byte-compares that same result against the existing sibling `.html`":
-- impossible to satisfy if two renders of one source disagree). This
-- replaces a per-render `math.random(1, 1000000000)` id, under which every
-- render of a diagram-bearing document differed from the last and `--check`
-- could never exit 0 however fresh the committed file was (issue #22).
--
-- Uniqueness holds within a page (the only scope an HTML id must be unique
-- in) on two counts: the counter increments per diagram, and the
-- "richmd-mermaid-" prefix keeps this sequence in its own namespace, so
-- vega-lite.lua's identically-shaped `richmd-vega-N` sequence can never
-- collide with it.
--
-- This module-level state is per-DOCUMENT, not global-and-growing, because
-- bin/richmd.js spawns one `pandoc` process per document (spawnSync): the
-- Lua state is created fresh for each document and dies with the process, so
-- one document's ids can never depend on what was rendered before it. That
-- process model is load-bearing for this counter's correctness — a future
-- move to one long-lived pandoc process across many documents would need a
-- per-document reset here.
local diagram_ordinal = 0

local function next_ordinal()
  diagram_ordinal = diagram_ordinal + 1
  return diagram_ordinal
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
  local diagram_id = "richmd-mermaid-" .. tostring(next_ordinal())
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
  validate_batch = validate_batch,
  register = register,
}
