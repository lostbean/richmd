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

-- One registry instance, shared across validate and render phases (and,
-- in later chunks, across consumer-registered kinds too).
local registry = Registry.new()

-- Built-in kinds register themselves into the shared registry at startup.
require("blocks.callout").register(registry)

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

-- The single entry point Pandoc calls with the whole parsed document. Both
-- phases live in this one function, in sequence: the render phase's
-- doc:walk call (below) is source-level unreachable unless the validate
-- phase's `#errors > 0` check above it has already fallen through — that
-- fallthrough IS the fail-closed gate.
function Pandoc(doc)
  -- --- Validate phase ---
  doc = doc:walk({ Div = validate_only_div })

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
  doc = doc:walk({ Div = render_only_div })

  -- Inject the theme stylesheet into the document head.
  doc.meta["header-includes"] = pandoc.List({ pandoc.MetaBlocks({
    pandoc.RawBlock("html", theme_style_html()),
  }) })

  return doc
end
