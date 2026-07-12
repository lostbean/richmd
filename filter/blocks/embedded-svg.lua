-- richmd built-in block kind: embedded-svg.
--
-- Inlines an SVG from a sibling file (design.md §04 registry card: "embed a
-- sibling `.svg` file"). This is the only file allowed to know that
-- "embedded-svg" exists as a concept — the filter core and the registry's
-- lookup loop stay generic.
--
-- "Embed" means the referenced file's actual `<svg>...</svg>` markup is
-- spliced directly into the page as a raw HTML block — never an `<img
-- src="...">` reference — so the SVG's contents become part of the page's
-- own DOM (stylable via CSS, inspectable, no extra network request).
--
-- Resolving `file` against the filesystem needs the CURRENT document's own
-- directory, exactly like richmd-filter.lua's link resolver (§06) resolves
-- relative `.md` link targets — this module computes that same doc_dir
-- itself (via PANDOC_STATE.input_files, the same source richmd-filter.lua
-- reads) rather than depending on richmd-filter.lua to pass it in, since
-- the render_fn/validate signatures are locked to (block, resolved_attrs)
-- and (block, kind_name, location, add_error) respectively — no extra
-- parameter to carry a path through.

local schema = {
  kind = "embedded-svg",
  attrs = {
    file = {
      required = true,
      type = "string",
    },
    -- Optional caption (design.md §04 registry card: "inline a sibling
    -- `.svg` file, with an optional caption rendered as a real
    -- `<figure>`/`<figcaption>` pair"). Omitting it renders exactly as
    -- before this attr existed — see render()'s comment.
    caption = {
      required = false,
      type = "string",
    },
  },
  -- The block's own content is never used — the visible output comes
  -- entirely from the referenced file on disk.
  body = "forbidden",
  validate = nil, -- set below, after `validate` is defined
}

-- current_doc_dir() -> string
--
-- Same derivation richmd-filter.lua's current_doc_dir uses: Pandoc exposes
-- the single input file path via PANDOC_STATE.input_files; richmd is always
-- invoked with exactly one input file (bin/richmd.js). Duplicated here
-- (rather than imported) because this module has no access to
-- richmd-filter.lua's local `doc_dir` variable — render_fn/validate are
-- only ever handed the block and its resolved attrs/kind/location, per the
-- locked interface contract.
local function current_doc_dir()
  local input_files = PANDOC_STATE and PANDOC_STATE.input_files
  local input_path = input_files and input_files[1]
  if not input_path then
    return "."
  end
  return input_path:match("(.*)/[^/]*$") or "."
end

-- resolve_svg_path(file_attr) -> string
--
-- Resolves the `file` attr's relative path against the current document's
-- own directory — the same base every cross-document link target resolves
-- against (§06).
local function resolve_svg_path(file_attr)
  return current_doc_dir() .. "/" .. file_attr
end

-- read_svg_file(path) -> contents | nil
local function read_svg_file(path)
  local file = io.open(path, "r")
  if not file then
    return nil
  end
  local contents = file:read("*a")
  file:close()
  return contents
end

-- html_escape(text) -> string
--
-- `caption` is spliced into a raw HTML block below (a `<figcaption>` built
-- via string concatenation, not a pandoc.Str/Span AST node whose own HTML
-- writer would escape it automatically) — an unescaped caption containing
-- `<`/`>`/`&` would either break the surrounding markup or, worse, let
-- authored attr text execute as live HTML (e.g. a `caption="<script>...`
-- value). Same escaping mermaid.lua's own html_escape applies to its
-- `title` attr for the exact same reason (that attr is also spliced into
-- raw HTML rather than going through Pandoc's writer).
local function html_escape(text)
  return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- validate(block, kind_name, location, add_error)
--
-- Called by the filter core's generic validate step alongside the
-- schema-driven attrs/body checks (this kind's `file` attr and forbidden
-- body are both already covered generically) — this function adds the ONE
-- check no generic schema field can express: that the referenced sibling
-- file actually exists on disk. A missing file is a validation error naming
-- the missing path, added to the SAME shared errors list every other kind's
-- errors use (via the add_error callback the filter core passes in), never
-- a separate error-collection path — exactly mermaid.lua's pattern for its
-- own custom grammar check.
local function validate(block, kind_name, location, add_error)
  local file_attr = block.attributes and block.attributes.file
  if not file_attr or file_attr == "" then
    -- Already caught by the generic "missing required attr 'file'" schema
    -- check; skip the existence check as unhelpfully redundant.
    return
  end

  local resolved_path = resolve_svg_path(file_attr)
  local contents = read_svg_file(resolved_path)
  if not contents then
    add_error(
      kind_name,
      location,
      "embedded SVG file '" .. file_attr .. "' does not exist (resolved to '" .. resolved_path .. "')"
    )
  end
end

schema.validate = validate

-- render_fn(block, resolved_attrs) -> pandoc_ast_node
--
-- Reads the referenced sibling SVG file's contents and splices them
-- directly into the page as a raw HTML block — the real <svg> markup, not
-- an <img> reference. Only reachable once the validate phase has already
-- confirmed the file exists (the fail-closed gate, §00) — a read failure
-- here would be a genuinely exceptional, previously-unseen condition (e.g.
-- the file was deleted between validate and render within the same
-- process), so it is a hard filter failure rather than a silently empty
-- tile.
--
-- `caption` (optional, design.md §04): when present, the `.richmd-embedded-
-- svg` div is wrapped in a real `<figure>` with a trailing `<figcaption>`
-- holding the caption text (theme/default.css's `.richmd-doc figcaption`
-- rule, already styled for exactly this — small, faint, centered text
-- below a figure). When absent, the output is byte-for-byte identical to
-- before this attr existed: just the bare `.richmd-embedded-svg` div, no
-- `<figure>` wrapper at all.
local function render(_block, resolved_attrs)
  local resolved_path = resolve_svg_path(resolved_attrs.file)
  local svg_source = read_svg_file(resolved_path)
  if not svg_source then
    error("richmd: embedded-svg file '" .. resolved_attrs.file .. "' could not be read at render time (resolved to '" .. resolved_path .. "')")
  end

  local caption = resolved_attrs.caption
  if not caption or caption == "" then
    return pandoc.Div(
      { pandoc.RawBlock("html", svg_source) },
      pandoc.Attr("", { "richmd-embedded-svg" })
    )
  end

  -- With a caption, the real <figure> element itself must be the outer
  -- tag (not a further `.richmd-embedded-svg`-classed div wrapping a
  -- `<figure>`) so theme/default.css's plain `.richmd-doc figure` /
  -- `.richmd-doc figcaption` rules apply directly. A Pandoc Div always
  -- renders as `<div>`, so the whole figure is emitted as one raw HTML
  -- block rather than composed from Div/RawBlock nodes.
  return pandoc.RawBlock(
    "html",
    '<figure><div class="richmd-embedded-svg">'
      .. svg_source
      .. "</div><figcaption>"
      .. html_escape(caption)
      .. "</figcaption></figure>"
  )
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("embedded-svg", schema, render)
end

return {
  schema = schema,
  render = render,
  validate = validate,
  register = register,
}
