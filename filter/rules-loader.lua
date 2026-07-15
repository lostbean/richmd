-- richmd cross-block rules directory loader (design.md §05 Cross-block
-- rules; ADR-0008: block projection over raw AST; CONTEXT.md#term-
-- cross-block-rule, #term-rules-directory).
--
-- Scans a consumer-owned directory (default `.richmd/rules/`) for `.lua`
-- files, each a "cross-block rule": a document-wide check spanning more
-- than one block — ordering, cardinality, a required cross-link, a
-- document-wide enum.
--
-- Each rule file is a module returning EITHER a bare function, OR a table
-- with a `check` function field — same acceptance shape extension-
-- loader.lua's load_render_fn already uses for block-kind render
-- functions:
--
--   return { check = function(block_projections, add_error) ... end }
--   return function(block_projections, add_error) ... end
--
-- A rule's `check` receives the document's ordered block projection list
-- (CONTEXT.md#term-block-projection) and the SAME `add_error` closure
-- per-block checks already call into, so a rule's violations land in the
-- identical collected-errors list. richmd-filter.lua is the one that
-- actually invokes each rule's `check` (this module only loads and returns
-- the list) — it prefixes the rule's reported error source with `rule:`
-- (CONTEXT.md#term-error-source) so a rule can never collide with a
-- same-named block kind.
--
-- Load-time errors (invalid Lua syntax, OR a loaded value that is neither a
-- bare function nor a table with a `check` function field) are FATAL at
-- filter startup — identical in spirit to how extension-loader.lua aborts
-- on a malformed block schema/render pair. A broken rule must never be
-- silently skipped (design.md §05 failure behavior).
--
-- This module deliberately does NOT share code with extension-loader.lua
-- (a sibling module for block kinds, not rules) — the two are similar by
-- convention, not by a shared helper; see richmd-filter.lua's own comments
-- for why that refactor is out of scope.

local RulesLoader = {}

-- DEFAULT_DIR: the rules directory name, relative to wherever it is
-- resolved against (see richmd-filter.lua's config_dir resolution,
-- ADR-0009).
RulesLoader.DEFAULT_DIR = ".richmd/rules"

-- fatal(message) — load-time errors refuse to run the filter entirely
-- (fail closed at startup), rather than being collected like a per-block
-- validation error. `error()` here is deliberate: it is NOT the same
-- mechanism as add_error/errors in richmd-filter.lua's validate phase.
local function fatal(message)
  error("richmd: " .. message, 0)
end

-- list_lua_files(dir_path) -> { path, ... }
--
-- Lists every `*.lua` file directly inside dir_path. Lua has no portable
-- stdlib directory-listing function, so this shells out to `ls -1`
-- (available on every platform richmd targets: macOS/Linux dev shells and
-- CI) — the exact same pattern extension-loader.lua's list_schema_files
-- uses for the identical narrow need.
local function list_lua_files(dir_path)
  local handle = io.popen(
    "ls -1 "
      .. "'" .. dir_path:gsub("'", "'\\''") .. "'"
      .. "/*.lua 2>/dev/null"
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

-- load_check_fn(lua_path, rule_name) -> check_fn
--
-- Loads the rule file as a Lua module. Accepts either
-- `return { check = function(block_projections, add_error) ... end }` or a
-- bare `return function(block_projections, add_error) ... end`. A
-- malformed file — invalid Lua syntax, or a loaded value that is neither of
-- those two shapes — is fatal, naming the offending file AND which illegal
-- shape was found.
local function load_check_fn(lua_path, rule_name)
  local chunk, load_err = loadfile(lua_path)
  if not chunk then
    fatal(
      "could not load rule file '" .. lua_path .. "' for rule 'rule:" .. rule_name .. "': failed to load: " .. tostring(load_err)
    )
  end

  local ok, result = pcall(chunk)
  if not ok then
    fatal(
      "error running rule file '" .. lua_path .. "' for rule 'rule:" .. rule_name .. "': failed to load: " .. tostring(result)
    )
  end

  local check_fn
  if type(result) == "function" then
    check_fn = result
  elseif type(result) == "table" and type(result.check) == "function" then
    check_fn = result.check
  end

  if not check_fn then
    fatal(
      "rule file '"
        .. lua_path
        .. "' for rule 'rule:"
        .. rule_name
        .. "' returned neither a function nor a table with a 'check' function field"
    )
  end

  return check_fn
end

-- load(dir_path) -> { { name = "<filename-without-.lua>", check = fn }, ... }
--
-- Scans dir_path for `*.lua` files and loads each into a
-- `{ name = ..., check = ... }` entry. Silently returns an empty list if
-- dir_path does not exist at all — the rules directory is optional, like
-- extension-loader.lua's own `.richmd/blocks/` (most documents have no
-- cross-block rules at all). Order is whatever `ls -1` returns; callers
-- must not depend on a particular rule execution order across DIFFERENT
-- rule files (design.md §05 does not require it).
function RulesLoader.load(dir_path)
  local lua_files = list_lua_files(dir_path)

  local rules = {}
  for _, lua_path in ipairs(lua_files) do
    local rule_name = lua_path:match("([^/]+)%.lua$")
    if not rule_name then
      fatal("could not derive a rule name from rule file '" .. lua_path .. "'")
    end

    local check_fn = load_check_fn(lua_path, rule_name)

    table.insert(rules, { name = rule_name, check = check_fn })
  end

  return rules
end

return RulesLoader
