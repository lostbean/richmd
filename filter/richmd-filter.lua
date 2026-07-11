-- richmd filter core (design.md §03).
--
-- One Lua filter, loaded by Pandoc, that walks the document's AST once and
-- runs two internal phases in sequence: validate, then render — never two
-- Pandoc invocations (ADR-0002). The render phase is unreachable code
-- unless the validate phase's error list is empty (§00 fail-closed gate
-- invariant).
--
-- This module owns the phase boundary itself; it must never contain an
-- `if kind == "callout"` branch — per-kind behavior lives entirely behind
-- registry:lookup(kind_name), in filter/blocks/*.lua.

-- Make `require` find sibling modules regardless of the caller's cwd:
-- Pandoc sets PANDOC_SCRIPT_FILE to this filter's own path.
local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"
package.path = script_dir .. "?.lua;" .. package.path

local Registry = require("registry")
local Slugify = require("slugify")
local ExtensionLoader = require("extension-loader")

-- One registry instance, shared across validate and render phases and
-- across consumer-registered kinds.
local registry = Registry.new()

-- Built-in kinds register themselves into the shared registry at startup.
require("blocks.callout").register(registry)
require("blocks.mermaid").register(registry)

-- The current document's own directory, used to resolve relative `.md`
-- link targets against the filesystem (§06 link resolver). Pandoc exposes
-- the input file path via PANDOC_STATE.input_files; richmd is always
-- invoked with exactly one input file (bin/richmd.js).
local function current_doc_dir()
  local input_files = PANDOC_STATE and PANDOC_STATE.input_files
  local input_path = input_files and input_files[1]
  if not input_path then
    return "."
  end
  return input_path:match("(.*)/[^/]*$") or "."
end

local doc_dir = current_doc_dir()

-- Consumer-defined kinds (design.md §04, ADR-0003, §00 principle P4 "extend
-- by composition, never by fork") register into the SAME shared registry
-- instance as built-ins, from the consumer's own extension directory
-- (default `.richmd/blocks/`, resolved relative to the input document's own
-- directory — the consumer repo's root, not richmd's). A malformed schema
-- or Lua file here is a load-time error (filter/extension-loader.lua calls
-- `error(...)`), which aborts the whole filter run before any AST walk
-- begins — distinct from a per-block validation error collected below.
ExtensionLoader.load(registry, doc_dir .. "/" .. ExtensionLoader.DEFAULT_DIR)

-- All validation errors collected across the whole document (§00 invariant:
-- never fail-fast on the first error).
local errors = {}

local function add_error(kind_name, location, reason)
  table.insert(errors, {
    kind = kind_name or "(unknown)",
    location = location,
    reason = reason,
  })
end

-- validate_attrs(schema, attrs, kind_name, location) -> resolved_attrs
--
-- Checks the block's attrs against its schema's `attrs` table (required/
-- optional, enum values) and returns the resolved attr values regardless
-- of whether errors were found — the render phase is never reached when
-- errors exist, so a partially-resolved table here is harmless.
local function validate_attrs(schema, attrs, kind_name, location)
  local resolved = {}
  for attr_name, attr_schema in pairs(schema.attrs or {}) do
    local value = attrs[attr_name]
    if value == nil or value == "" then
      if attr_schema.required then
        add_error(
          kind_name,
          location,
          "missing required attr '" .. attr_name .. "'"
        )
      end
    else
      if attr_schema.type == "enum" then
        local allowed = false
        for _, candidate in ipairs(attr_schema.enum_values or {}) do
          if value == candidate then
            allowed = true
            break
          end
        end
        if not allowed then
          add_error(
            kind_name,
            location,
            "attr '"
              .. attr_name
              .. "' has invalid value '"
              .. value
              .. "' (allowed: "
              .. table.concat(attr_schema.enum_values or {}, ", ")
              .. ")"
          )
        end
      end
      resolved[attr_name] = value
    end
  end
  return resolved
end

-- validate_body(schema, block, kind_name, location)
local function validate_body(schema, block, kind_name, location)
  local has_body = block.content and #block.content > 0
  if schema.body == "required" and not has_body then
    add_error(kind_name, location, "body is required but was empty")
  elseif schema.body == "forbidden" and has_body then
    add_error(kind_name, location, "body is forbidden but content was present")
  end
end

-- validate_block(block, kind_name) -> resolved_attrs | nil
--
-- Generic per-block validate step: one registry:lookup call, schema-driven
-- attr/body checks. Never an `if kind_name == "..."` branch here — that
-- would violate the schema-driven-validation invariant (§00).
local function validate_block(block, kind_name)
  local location = "div." .. kind_name
  local schema, render_fn = registry:lookup(kind_name)

  if not schema then
    add_error(kind_name, location, "unknown block kind '" .. kind_name .. "'")
    return nil, nil
  end

  local resolved_attrs = validate_attrs(schema, block.attributes, kind_name, location)
  validate_body(schema, block, kind_name, location)

  return resolved_attrs, render_fn
end

-- split_target(target) -> path_part, fragment_part_or_nil
--
-- Splits a link target into its path and (optional) `#fragment`, without
-- otherwise interpreting either. `fragment_part_or_nil` excludes the `#`.
local function split_target(target)
  local path_part, fragment_part = target:match("^([^#]*)#(.*)$")
  if path_part then
    return path_part, fragment_part
  end
  return target, nil
end

-- is_relative_md_link(path_part) -> boolean
--
-- A cross-document link (CONTEXT.md#term-cross-document-link) is a relative
-- link whose target ends in `.md`. Absolute URLs (with a scheme like
-- `https://`) and non-`.md` targets are never cross-document links.
local function is_relative_md_link(path_part)
  if path_part == "" then
    return false
  end
  if path_part:match("^%a[%w+.-]*://") then
    return false -- has a URL scheme (http://, https://, mailto:, etc.)
  end
  return path_part:match("%.md$") ~= nil
end

-- Pass 1 (validate phase): every relative `.md` link target must resolve to
-- an existing file on disk, relative to the CURRENT document's own
-- directory (§00 invariant: cross-document links always resolve). A
-- dangling target is collected via the same `add_error` mechanism used for
-- callout/registry errors — never a separate path.
local function validate_only_link(link)
  local path_part = split_target(link.target)
  if not is_relative_md_link(path_part) then
    return nil -- not a cross-document link; nothing to validate
  end

  local resolved_path = doc_dir .. "/" .. path_part
  local file = io.open(resolved_path, "r")
  if file then
    file:close()
  else
    add_error(
      "link",
      "link." .. link.target,
      "cross-document link target '" .. path_part .. "' does not exist (resolved to '" .. resolved_path .. "')"
    )
  end
  return nil
end

-- Richmd-recognized classes are those with a registry entry; a Div with no
-- richmd-recognized class is left untouched (ordinary Pandoc content).
local function richmd_kind_of(div)
  for _, class in ipairs(div.classes) do
    local schema = select(1, registry:lookup(class))
    if schema then
      return class
    end
  end
  return nil
end

-- Pass 1 (validate phase): walk the whole AST, collect every error. Never
-- renders, never transforms — Pandoc's AST-node identity is not guaranteed
-- to survive across two separate doc:walk() calls, so this phase does not
-- try to hand anything forward to the render phase; the render phase
-- (below) independently re-derives each block's kind via the same generic
-- registry:lookup, exactly like this phase does.
local function validate_only_div(div)
  local kind_name = richmd_kind_of(div)
  if not kind_name then
    return nil -- not a richmd block kind; leave untouched
  end
  validate_block(div, kind_name)
  return nil
end

-- richmd_kind_of_codeblock(code_block) -> kind_name | nil
--
-- The CodeBlock equivalent of richmd_kind_of above: a fenced code block
-- (` ```mermaid `) is richmd-recognized by the SAME generic registry:lookup
-- mechanism used for Divs — a class with no registry entry is left as
-- ordinary Pandoc content (e.g. ` ```js ` code samples are untouched).
local function richmd_kind_of_codeblock(code_block)
  for _, class in ipairs(code_block.classes) do
    local schema = select(1, registry:lookup(class))
    if schema then
      return class
    end
  end
  return nil
end

-- validate_only_codeblock(code_block) -> nil
--
-- The CodeBlock equivalent of validate_only_div: same generic
-- registry:lookup, schema-driven attrs check, plus this block kind's own
-- `schema.validate` hook if present (mermaid's real grammar check — see
-- filter/blocks/mermaid.lua) — called generically for ANY kind that
-- declares one, never an `if kind_name == "mermaid"` branch here. A
-- CodeBlock's body is its `.text` string (unlike a Div's `.content` list of
-- AST blocks), so body presence is checked accordingly.
local function validate_only_codeblock(code_block)
  local kind_name = richmd_kind_of_codeblock(code_block)
  if not kind_name then
    return nil -- not a richmd block kind; leave untouched
  end

  local location = "codeblock." .. kind_name
  local schema = select(1, registry:lookup(kind_name))

  local resolved_attrs = validate_attrs(schema, code_block.attributes, kind_name, location)

  local has_body = code_block.text and code_block.text ~= ""
  if schema.body == "required" and not has_body then
    add_error(kind_name, location, "body is required but was empty")
  elseif schema.body == "forbidden" and has_body then
    add_error(kind_name, location, "body is forbidden but content was present")
  end

  if schema.validate then
    schema.validate(code_block, kind_name, location, add_error)
  end

  return nil
end

-- theme_style_html() -> string
--
-- Reads the default theme stylesheet asset and wraps it in a <style> tag.
-- The actual color/spacing values live entirely in theme/default.css
-- (§00 principle P3) — this function only ever moves bytes, never emits a
-- literal hex code or hardcoded value itself.
local function theme_style_html()
  local theme_path = script_dir .. "../theme/default.css"
  local file = io.open(theme_path, "r")
  if not file then
    error("richmd: could not open theme stylesheet at " .. theme_path)
  end
  local css = file:read("*a")
  file:close()
  return "<style>\n" .. css .. "\n</style>"
end

-- Pass 2 (render phase): only reachable once the caller has already
-- confirmed #errors == 0 (see Pandoc(doc) below). Independently re-derives
-- each Div's kind via the same generic registry:lookup used in validate,
-- then hands the block to its render_fn. Re-running validate_attrs here is
-- safe and side-effect-free with respect to the gate: errors is already
-- known empty, and any (impossible, since validate already passed) error
-- appended here would just be inert dead data at this point in the run.
local function render_only_div(div)
  local kind_name = richmd_kind_of(div)
  if not kind_name then
    return nil -- not a richmd block kind; leave untouched
  end

  local schema, render_fn = registry:lookup(kind_name)
  local resolved_attrs = validate_attrs(schema, div.attributes, kind_name, "div." .. kind_name)
  return render_fn(div, resolved_attrs)
end

-- render_only_codeblock(code_block) -> pandoc_ast_node
--
-- The CodeBlock equivalent of render_only_div: same generic
-- registry:lookup, then hands the block to its render_fn (e.g. mermaid's,
-- which embeds the raw source in a client-side-rendered container — see
-- filter/blocks/mermaid.lua). Only reachable once #errors == 0, exactly
-- like render_only_div.
local function render_only_codeblock(code_block)
  local kind_name = richmd_kind_of_codeblock(code_block)
  if not kind_name then
    return nil -- not a richmd block kind; leave untouched
  end

  local schema, render_fn = registry:lookup(kind_name)
  local resolved_attrs =
    validate_attrs(schema, code_block.attributes, kind_name, "codeblock." .. kind_name)
  return render_fn(code_block, resolved_attrs)
end

-- Table threaded through every Header node processed in this one filter
-- run (§00 invariant: slugs are a pure, documented function) — tracks
-- slugs already assigned so the 2nd/3rd/... occurrence of the same heading
-- text gets the -1/-2 suffix. One table per Pandoc(doc) invocation, i.e.
-- per document, matching CONTEXT.md#term-slug's "within one document" rule.
local seen_slugs = Slugify.new_seen()

-- render_only_header(header) -> pandoc_ast_node
--
-- Assigns the Header's `id` attribute via the single documented slugify
-- function — the SAME function used by render_only_link below to resolve
-- `#fragment` targets, so headings and links can never disagree.
local function render_only_header(header)
  local heading_text = pandoc.utils.stringify(header.content)
  header.identifier = Slugify.slugify(heading_text, seen_slugs)
  return header
end

-- render_only_link(link) -> pandoc_ast_node
--
-- Rewrites every relative `.md` link target (with or without a `#fragment`)
-- to its sibling `.html` target (§06 link resolver). The fragment itself is
-- passed through unchanged: Pandoc already writes heading anchors matching
-- this filter's own slugify output (render_only_header, above), so the two
-- can never disagree. Non-`.md` targets (external URLs, images, etc.) are
-- left completely untouched.
local function render_only_link(link)
  local path_part, fragment_part = split_target(link.target)
  if not is_relative_md_link(path_part) then
    return nil -- not a cross-document link; leave untouched
  end

  local html_path = path_part:gsub("%.md$", ".html")
  if fragment_part then
    link.target = html_path .. "#" .. fragment_part
  else
    link.target = html_path
  end
  return link
end

-- The single entry point Pandoc calls with the whole parsed document. Both
-- phases live in this one function, in sequence: the render phase's
-- doc:walk call (below) is source-level unreachable unless the validate
-- phase's `#errors > 0` check above it has already fallen through — that
-- fallthrough IS the fail-closed gate.
function Pandoc(doc)
  -- --- Validate phase ---
  doc = doc:walk({
    Div = validate_only_div,
    Link = validate_only_link,
    CodeBlock = validate_only_codeblock,
  })

  if #errors > 0 then
    -- Fail-closed gate: render phase is unreachable from here. Print every
    -- collected error (never fail-fast on the first) and hard-fail the
    -- filter so no partial HTML is ever written.
    for _, err in ipairs(errors) do
      io.stderr:write(
        "richmd: [" .. err.kind .. "] " .. err.location .. ": " .. err.reason .. "\n"
      )
    end
    os.exit(1)
  end

  -- `richmd validate` (bin/richmd.js) sets this env var to stop right here,
  -- after the validate phase has already run to completion with zero
  -- errors. Same success/failure exit-code contract as render, but the
  -- render phase below — and therefore any HTML output — is unreachable
  -- from this branch regardless of validation outcome.
  if os.getenv("RICHMD_VALIDATE_ONLY") then
    os.exit(0)
  end

  -- --- Render phase (only reachable because #errors == 0 above) ---
  doc = doc:walk({
    Div = render_only_div,
    Header = render_only_header,
    Link = render_only_link,
    CodeBlock = render_only_codeblock,
  })

  -- Inject the theme stylesheet into the document head.
  doc.meta["header-includes"] = pandoc.List({ pandoc.MetaBlocks({
    pandoc.RawBlock("html", theme_style_html()),
  }) })

  return doc
end
