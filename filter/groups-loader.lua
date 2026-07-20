-- richmd group-render hook directory loader (design.md §11 Group render;
-- ADR-0015: the group hook is the fifth consumer-declarable contract —
-- structure-only, render-phase, per-KIND singleton; CONTEXT.md#term-group-
-- hook, #term-block-group, #term-groups-directory).
--
-- Scans a consumer-owned directory (default `.richmd/groups/`) for `.lua`
-- files. Each file is a module returning a table declaring which block KINDS
-- it claims and a single render function for its claimed runs:
--
--   return {
--     kinds = { "goal", "no-goal" },
--     render = function(kind, rendered_blocks)
--       return pandoc.Blocks{ ... }
--     end,
--   }
--
-- `kinds` is a list of block-kind name strings the hook claims. `render(kind,
-- rendered_blocks)` receives the run's kind (a string, one of the claimed
-- kinds) and the list of ALREADY-RENDERED AST nodes for that run in document
-- order, and returns pandoc.Blocks. In the RENDER phase richmd finds each
-- maximal run of CONSECUTIVE top-level blocks whose ORIGINAL kind is claimed
-- by a hook and replaces that run with the hook's returned blocks. richmd
-- injects the region's Blocks verbatim; a hook emits `richmd-*` classes and
-- the theme owns the look (P3) — this loader never styles or reads a hook's
-- content.
--
-- MULTIPLE hook files are allowed, as long as no two claim the same kind: the
-- collision unit is the block KIND, not the file (this differs from
-- shell-loader.lua's per-region singleton).
--
-- Load-time errors are FATAL at filter startup (fail closed), NOT collected
-- like a per-block validation error:
--   * a hook file with invalid Lua syntax, or a return value that is not a
--     table, or a `kinds` that is not a list of strings, or a `render` that
--     is not a function — naming the offending file;
--   * two files that both claim the same kind (the per-kind singleton
--     contract), naming BOTH offending files and the kind.
-- This is identical in spirit to how extension-loader.lua aborts on a
-- malformed block schema, rules-loader.lua on a malformed rule,
-- tokens-loader.lua on a malformed vocabulary, and shell-loader.lua on a
-- malformed shell hook.
--
-- A hook's own render-time failure (returning a non-Blocks/non-nil value, or
-- raising) is NOT this module's concern — it is a hard filter failure
-- surfaced at the render call site in richmd-filter.lua, past the gate.
--
-- This module deliberately does NOT share code with extension-loader.lua,
-- rules-loader.lua, tokens-loader.lua, or shell-loader.lua (sibling modules
-- for block kinds, rules, vocabularies, and the document shell) — the five are
-- similar by convention, not by a shared helper; see richmd-filter.lua's own
-- comments for why that refactor is out of scope.

local GroupsLoader = {}

-- DEFAULT_DIR: the groups directory name, relative to wherever it is resolved
-- against (see richmd-filter.lua's config_dir resolution, ADR-0009).
GroupsLoader.DEFAULT_DIR = ".richmd/groups"

-- fatal(message) — load-time errors refuse to run the filter entirely (fail
-- closed at startup), rather than being collected like a per-block validation
-- error. `error()` here is deliberate: it is NOT the same mechanism as
-- add_error/errors in richmd-filter.lua's validate phase.
local function fatal(message)
  error("richmd: " .. message, 0)
end

-- list_lua_files(dir_path) -> { path, ... }
--
-- Lists every `*.lua` file directly inside dir_path. Lua has no portable
-- stdlib directory-listing function, so this shells out to `ls -1`
-- (available on every platform richmd targets) — the exact same pattern
-- extension-loader.lua, rules-loader.lua, tokens-loader.lua, and
-- shell-loader.lua use for the identical narrow need.
local function list_lua_files(dir_path)
  local handle = io.popen(
    "ls -1 " .. "'" .. dir_path:gsub("'", "'\\''") .. "'" .. "/*.lua 2>/dev/null"
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

-- is_list_of_strings(value) -> boolean
--
-- A `kinds` field must be a non-empty list of strings (an array-part table
-- whose every element is a string). A table with a hole, a non-string
-- element, or no array part at all is malformed.
local function is_list_of_strings(value)
  if type(value) ~= "table" then
    return false
  end
  local count = 0
  for _ in pairs(value) do
    count = count + 1
  end
  if count == 0 or count ~= #value then
    return false -- empty, or has non-sequential/keyed entries
  end
  for _, item in ipairs(value) do
    if type(item) ~= "string" then
      return false
    end
  end
  return true
end

-- load_hook(lua_path) -> { kinds = {...}, render = fn }
--
-- Loads one hook file as a Lua module. A malformed file — invalid Lua syntax,
-- a return value that is not a table, a `kinds` that is not a list of strings,
-- or a `render` that is not a function — is fatal, naming the offending file.
local function load_hook(lua_path)
  local chunk, load_err = loadfile(lua_path)
  if not chunk then
    fatal(
      "could not load group hook file '" .. lua_path .. "': failed to load: " .. tostring(load_err)
    )
  end

  local ok, result = pcall(chunk)
  if not ok then
    fatal(
      "error running group hook file '" .. lua_path .. "': failed to load: " .. tostring(result)
    )
  end

  if type(result) ~= "table" then
    fatal(
      "group hook file '"
        .. lua_path
        .. "' returned a "
        .. type(result)
        .. ", not a table { kinds = {...}, render = function }"
    )
  end

  if not is_list_of_strings(result.kinds) then
    fatal(
      "group hook file '"
        .. lua_path
        .. "' has an invalid 'kinds' (must be a non-empty list of block-kind name strings)"
    )
  end

  if type(result.render) ~= "function" then
    fatal(
      "group hook file '"
        .. lua_path
        .. "' has an invalid 'render' (must be a function of (kind, rendered_blocks) returning"
        .. " pandoc.Blocks, got "
        .. type(result.render)
        .. ")"
    )
  end

  return { kinds = result.kinds, render = result.render }
end

-- load(dir_path) -> { [kind_name] = { fn = render_fn, file = lua_path }, ... }
--
-- Scans dir_path for `*.lua` files and builds a map from each claimed block
-- kind to its render function and source file path, enforcing the per-kind
-- singleton contract: if two different files both claim the same kind, that is
-- a fatal load-time error naming BOTH files and the kind (never a silent
-- last-loaded-wins merge). Each entry carries the source file path so the
-- render-time fatal in richmd-filter.lua can name the file. Silently returns
-- an empty table if dir_path does not exist at all — the groups directory is
-- optional, like the other four extension directories; most documents declare
-- no group hook, and the whole pass is then inert.
function GroupsLoader.load(dir_path)
  local lua_files = list_lua_files(dir_path)

  local hooks = {}

  for _, lua_path in ipairs(lua_files) do
    local hook = load_hook(lua_path)
    for _, kind in ipairs(hook.kinds) do
      if hooks[kind] ~= nil then
        fatal(
          "two group hook files both claim the kind '"
            .. kind
            .. "': '"
            .. hooks[kind].file
            .. "' and '"
            .. lua_path
            .. "' (a kind is claimed by at most one group hook)"
        )
      end
      hooks[kind] = { fn = hook.render, file = lua_path }
    end
  end

  return hooks
end

return GroupsLoader
