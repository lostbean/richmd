-- richmd extension directory loader (design.md §04 block kind registry;
-- ADR-0003: schema + Lua plugin pair for extension; §00 principle P4
-- "extend by composition, never by fork").
--
-- Scans a consumer-owned directory (default `.richmd/blocks/`) for pairs of
-- files that add new block kinds to the SAME registry instance used for
-- richmd's built-ins:
--
--   .richmd/blocks/<kind-name>.schema.json
--   .richmd/blocks/<kind-name>.lua
--
-- The schema file is plain JSON matching the exact shape every built-in
-- Lua schema table already has (see filter/blocks/callout.lua):
--   { "kind": "<kind-name>",
--     "attrs": { "<attr_name>": { "required": bool, "type": "enum",
--                                 "enum_values": [...] }, ... },
--     "body": "required" | "optional" | "forbidden" }
--
-- An attr may instead carry `"tokens": "<vocabulary>"`, opting it into a
-- token vocabulary (design.md §06, ADR-0011): its value is then exactly one
-- member of that vocabulary's closed set, validated against the set instead
-- of an inline enum. A consumer's JSON schema uses `tokens` exactly as a
-- built-in Lua schema does — the two shapes stay in step. `tokens` and the
-- enum mechanism are mutually exclusive on one attr (see
-- validate_attr_shape).
--
-- The Lua file is a module returning a table with a `render` function of
-- the EXACT SAME shape as callout.lua's: `render(block, resolved_attrs) ->
-- pandoc_ast_node`. It may be written as either
-- `return { render = render }` or `return render` directly (a bare
-- function) — both forms are accepted so a consumer's file can be as small
-- as possible.
--
-- After loading, a consumer-defined kind is registered via the exact same
-- `registry:register(kind_name, schema, render_fn)` call built-ins use —
-- indistinguishable to the rest of the filter from that point on. This
-- module never touches richmd's own filter/registry.lua or
-- filter/blocks/*.lua; a consumer's kind lives entirely under its own
-- extension directory.
--
-- Load-time errors (malformed JSON, a schema missing a required field, a
-- Lua file that fails to load or has no usable render function) are FATAL
-- at filter startup — distinct from a per-block validation error collected
-- during the validate phase. A broken extension must never be silently
-- skipped (design.md §04 failure behavior).

local ExtensionLoader = {}

-- DEFAULT_DIR: the extension directory name, relative to wherever it is
-- resolved against (see richmd-filter.lua's doc_dir / cwd resolution).
ExtensionLoader.DEFAULT_DIR = ".richmd/blocks"

-- fatal(message) — load-time errors refuse to run the filter entirely
-- (fail closed at startup), rather than being collected like a per-block
-- validation error. `error()` here is deliberate: it is NOT the same
-- mechanism as add_error/errors in richmd-filter.lua's validate phase.
local function fatal(message)
  error("richmd: " .. message, 0)
end

-- read_file(path) -> contents | nil
local function read_file(path)
  local file = io.open(path, "r")
  if not file then
    return nil
  end
  local contents = file:read("*a")
  file:close()
  return contents
end

-- list_schema_files(dir_path) -> { path, ... }
--
-- Lists every `*.schema.json` file directly inside dir_path. Lua has no
-- portable stdlib directory-listing function, so this shells out to `ls -1`
-- (available on every platform richmd targets: macOS/Linux dev shells and
-- CI) rather than adding a filesystem-globbing dependency for one narrow
-- need.
local function list_schema_files(dir_path)
  local handle = io.popen(
    "ls -1 "
      .. "'" .. dir_path:gsub("'", "'\\''") .. "'"
      .. "/*.schema.json 2>/dev/null"
  )
  if not handle then
    return {}
  end
  local output = handle:read("*a") or ""
  handle:close()

  local files = {}
  for line in output:gmatch("[^\r\n]+") do
    table.insert(files, line)
  end
  return files
end

-- validate_attr_shape(attr_schema, attr_name, schema_path)
--
-- Checks one attr's declaration. A consumer's JSON schema may opt an attr
-- into a token vocabulary with `"tokens": "<vocabulary>"` exactly as a
-- built-in Lua schema can (design.md §04 Interface, §06; ADR-0011) — the
-- JSON shape and the Lua shape stay in step, so this loader's only job is to
-- refuse a declaration that is self-contradictory.
--
-- `tokens` and the enum/`allowed`-values mechanism are MUTUALLY EXCLUSIVE:
-- an attr's value is drawn from a closed vocabulary OR from an inline
-- `allowed` list, never both (§04: validated against the set "instead of an
-- inline `allowed` list"). Declaring both contradicts itself about where the
-- value's truth lives, so it is fatal here rather than resolved by silently
-- letting one mechanism win — which would make which one wins a fact a
-- consumer could only learn by experiment.
--
-- Note richmd never checks that `tokens` names a vocabulary that EXISTS: a
-- schema is loaded once at startup, and whether a vocabulary is declared is
-- the tokens directory's business, checked per-attr during the validate
-- phase where the error can name the offending block (see richmd-filter.lua's
-- validate_attr_token).
local function validate_attr_shape(attr_schema, attr_name, schema_path)
  if type(attr_schema) ~= "table" then
    return
  end
  if attr_schema.tokens == nil then
    return
  end
  if type(attr_schema.tokens) ~= "string" or attr_schema.tokens == "" then
    fatal(
      "schema file '"
        .. schema_path
        .. "' has an invalid 'tokens' field on attr '"
        .. attr_name
        .. "' (must be the name of a token vocabulary)"
    )
  end
  if attr_schema.type == "enum" or attr_schema.enum_values ~= nil then
    fatal(
      "schema file '"
        .. schema_path
        .. "' declares both 'tokens' and enum values on attr '"
        .. attr_name
        .. "' (an attr draws its value from a token vocabulary or from an inline enum, never both)"
    )
  end
end

-- validate_schema_shape(schema, schema_path)
--
-- A malformed schema FILE (invalid JSON, or valid JSON missing a required
-- schema field) is a load-time error naming the offending file — fatal, not
-- a collected validation error (design.md §04 failure behavior).
local function validate_schema_shape(schema, schema_path)
  if type(schema) ~= "table" then
    fatal("could not parse schema file '" .. schema_path .. "' (invalid JSON)")
  end
  if type(schema.kind) ~= "string" or schema.kind == "" then
    fatal("schema file '" .. schema_path .. "' is missing required field 'kind'")
  end
  if schema.attrs == nil then
    fatal("schema file '" .. schema_path .. "' is missing required field 'attrs'")
  end
  if type(schema.attrs) ~= "table" then
    fatal("schema file '" .. schema_path .. "' has an invalid 'attrs' field (must be an object)")
  end
  for attr_name, attr_schema in pairs(schema.attrs) do
    validate_attr_shape(attr_schema, attr_name, schema_path)
  end
  local body = schema.body
  if body ~= "required" and body ~= "optional" and body ~= "forbidden" then
    fatal(
      "schema file '"
        .. schema_path
        .. "' has an invalid 'body' field (must be one of: required, optional, forbidden)"
    )
  end
end

-- load_render_fn(lua_path, kind_name) -> render_fn
--
-- Loads the paired `.lua` file as a Lua module. Accepts either
-- `return { render = function(block, resolved_attrs) ... end }` (mirroring
-- callout.lua's own `return { schema = ..., render = ..., register = ... }`
-- shape) or a bare `return function(block, resolved_attrs) ... end`.
local function load_render_fn(lua_path, kind_name)
  local chunk, load_err = loadfile(lua_path)
  if not chunk then
    fatal(
      "could not load Lua file '" .. lua_path .. "' for block kind '" .. kind_name .. "': " .. tostring(load_err)
    )
  end

  local ok, result = pcall(chunk)
  if not ok then
    fatal(
      "error running Lua file '" .. lua_path .. "' for block kind '" .. kind_name .. "': " .. tostring(result)
    )
  end

  local render_fn
  if type(result) == "function" then
    render_fn = result
  elseif type(result) == "table" and type(result.render) == "function" then
    render_fn = result.render
  end

  if not render_fn then
    fatal(
      "Lua file '"
        .. lua_path
        .. "' for block kind '"
        .. kind_name
        .. "' must return a render function, or a table with a 'render' function field"
    )
  end

  return render_fn
end

-- load(registry, dir_path)
--
-- Scans dir_path for <kind-name>.schema.json + <kind-name>.lua pairs and
-- registers each into `registry` via the exact same
-- registry:register(kind_name, schema, render_fn) built-ins use. Silently
-- does nothing if dir_path does not exist — the extension directory is
-- optional; most documents have no consumer-defined kinds at all.
function ExtensionLoader.load(registry, dir_path)
  local schema_files = list_schema_files(dir_path)

  for _, schema_path in ipairs(schema_files) do
    local kind_name = schema_path:match("([^/]+)%.schema%.json$")
    if not kind_name then
      fatal("could not derive a block kind name from schema file '" .. schema_path .. "'")
    end

    local json_text = read_file(schema_path)
    if not json_text then
      fatal("could not read schema file '" .. schema_path .. "'")
    end

    local ok, schema = pcall(pandoc.json.decode, json_text)
    if not ok or schema == nil then
      fatal("could not parse schema file '" .. schema_path .. "' (invalid JSON)")
    end

    validate_schema_shape(schema, schema_path)

    if schema.kind ~= kind_name then
      fatal(
        "schema file '"
          .. schema_path
          .. "' declares kind '"
          .. tostring(schema.kind)
          .. "', which does not match its filename-derived kind '"
          .. kind_name
          .. "'"
      )
    end

    local lua_path = dir_path .. "/" .. kind_name .. ".lua"
    if not read_file(lua_path) then
      fatal(
        "schema file '"
          .. schema_path
          .. "' has no matching Lua file '"
          .. lua_path
          .. "' (every schema needs a paired render function)"
      )
    end

    local render_fn = load_render_fn(lua_path, kind_name)

    registry:register(kind_name, schema, render_fn)
  end
end

return ExtensionLoader
