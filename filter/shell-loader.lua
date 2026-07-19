-- richmd document-shell hook directory loader (design.md §10 Document shell;
-- ADR-0014: the document-shell hook is the fourth consumer-declarable
-- contract — structure-only, render-phase, singleton; CONTEXT.md#term-shell-
-- hook, #term-shell-directory, #term-masthead, #term-colophon).
--
-- Scans a consumer-owned directory (default `.richmd/shell/`) for `.lua`
-- files. The directory holds AT MOST ONE hook across all its files: each
-- file is a module returning a table of optional REGION functions —
-- `masthead` and/or `colophon` — where each region is
-- `function(doc_meta) -> pandoc.Blocks`:
--
--   return {
--     masthead = function(doc_meta) return pandoc.Blocks{ ... } end,
--     colophon = function(doc_meta) return pandoc.Blocks{ ... } end,
--   }
--
-- Either region is optional; a hook may define one, both, or (uselessly)
-- neither. richmd calls each defined region during the RENDER phase, passing
-- the raw `doc.meta` metavalue tree (the SAME value the built-in
-- `richmd-layout` container read sees — never pre-stringified), and injects
-- the returned Blocks into `.richmd-container`: the masthead prepended (after
-- the leading anti-section guard RawBlock, before the document's own blocks),
-- the colophon appended at the container's end. richmd injects the region's
-- Blocks verbatim; a region emits `richmd-*` classes and the theme owns the
-- look (P3) — this loader never styles or reads a region's content.
--
-- Load-time errors are FATAL at filter startup (fail closed), NOT collected
-- like a per-block validation error:
--   * a hook file with invalid Lua syntax, or a return value that is not a
--     table, or whose `masthead`/`colophon` field is present but not a
--     function — naming the offending file;
--   * two files that both define the same region (two `masthead`s) — the
--     singleton contract, naming BOTH offending files.
-- This is identical in spirit to how extension-loader.lua aborts on a
-- malformed block schema, rules-loader.lua on a malformed rule, and
-- tokens-loader.lua on a malformed vocabulary.
--
-- A region's own render-time failure (returning a non-Blocks/non-nil value,
-- or raising) is NOT this module's concern — it is a hard filter failure
-- surfaced at the render call site in richmd-filter.lua, past the gate.
--
-- This module deliberately does NOT share code with extension-loader.lua,
-- rules-loader.lua, or tokens-loader.lua (sibling modules for block kinds,
-- rules, and vocabularies) — the four are similar by convention, not by a
-- shared helper; see richmd-filter.lua's own comments for why that refactor
-- is out of scope.

local ShellLoader = {}

-- DEFAULT_DIR: the shell directory name, relative to wherever it is resolved
-- against (see richmd-filter.lua's config_dir resolution, ADR-0009).
ShellLoader.DEFAULT_DIR = ".richmd/shell"

-- REGION_NAMES: the closed set of regions a hook may define. New regions are
-- added here (and injected in richmd-filter.lua) — nowhere else.
local REGION_NAMES = { "masthead", "colophon" }

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
-- (available on every platform richmd targets: macOS/Linux dev shells and
-- CI) — the exact same pattern extension-loader.lua's list_schema_files,
-- rules-loader.lua's list_lua_files, and tokens-loader.lua's list_json_files
-- use for the identical narrow need.
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

-- load_hook(lua_path) -> { [region_name] = fn, ... }
--
-- Loads one hook file as a Lua module. A malformed file — invalid Lua
-- syntax, a return value that is not a table, or a present `masthead`/
-- `colophon` field that is not a function — is fatal, naming the offending
-- file. Fields other than the known regions are ignored (forward-
-- compatibility: an unknown region name is inert, not an error).
local function load_hook(lua_path)
  local chunk, load_err = loadfile(lua_path)
  if not chunk then
    fatal(
      "could not load shell hook file '" .. lua_path .. "': failed to load: " .. tostring(load_err)
    )
  end

  local ok, result = pcall(chunk)
  if not ok then
    fatal(
      "error running shell hook file '" .. lua_path .. "': failed to load: " .. tostring(result)
    )
  end

  if type(result) ~= "table" then
    fatal(
      "shell hook file '"
        .. lua_path
        .. "' returned a "
        .. type(result)
        .. ", not a table of shell regions (masthead/colophon functions)"
    )
  end

  local regions = {}
  for _, region_name in ipairs(REGION_NAMES) do
    local value = result[region_name]
    if value ~= nil then
      if type(value) ~= "function" then
        fatal(
          "shell hook file '"
            .. lua_path
            .. "' has an invalid '"
            .. region_name
            .. "' region (must be a function of doc.meta returning pandoc.Blocks, got "
            .. type(value)
            .. ")"
        )
      end
      regions[region_name] = value
    end
  end

  return regions
end

-- load(dir_path) -> { masthead = fn|nil, colophon = fn|nil }
--
-- Scans dir_path for `*.lua` files and merges the regions each defines into a
-- single hook table, enforcing the singleton-per-region contract: if two
-- different files both define the same region, that is a fatal load-time
-- error naming BOTH files (never a silent last-loaded-wins merge). Silently
-- returns an empty table if dir_path does not exist at all — the shell
-- directory is optional, like the other three extension directories; most
-- documents declare no shell hook, and the whole pass is then inert.
function ShellLoader.load(dir_path)
  local lua_files = list_lua_files(dir_path)

  local regions = {}
  -- Tracks which file first defined each region, so a collision can name both.
  local defined_in = {}

  for _, lua_path in ipairs(lua_files) do
    local file_regions = load_hook(lua_path)
    for region_name, fn in pairs(file_regions) do
      if regions[region_name] ~= nil then
        fatal(
          "two shell hook files both define the '"
            .. region_name
            .. "' region: '"
            .. defined_in[region_name]
            .. "' and '"
            .. lua_path
            .. "' (the shell directory holds at most one hook per region)"
        )
      end
      regions[region_name] = fn
      defined_in[region_name] = lua_path
    end
  end

  return regions
end

return ShellLoader
