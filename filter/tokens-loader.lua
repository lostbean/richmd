-- richmd token vocabulary directory loader (design.md §06 Token vocabulary
-- resolution; ADR-0011: a token vocabulary is a closed set of members, and
-- every reference resolves one member; CONTEXT.md#term-token-vocabulary,
-- #term-tokens-directory).
--
-- Scans a consumer-owned directory (default `.richmd/tokens/`) for `.json`
-- files, each declaring one "token vocabulary": a named closed set of member
-- keys, each carrying arbitrary consumer-owned properties.
--
-- A vocabulary file declares EXACTLY ONE field — `members`, a map of member
-- key to that member's properties object:
--
--   { "members": { "modeling": { "order": 0 }, "state": { "order": 1 } } }
--
-- The vocabulary's NAME is its filename minus `.json` (`lens.json` declares
-- the vocabulary `lens`), exactly as `.richmd/blocks/` keys a block kind by
-- its filename — so the name is never a second fact the file could disagree
-- with. Deliberately absent, per ADR-0011: a `name` field (it would
-- duplicate the filename), and a `references` field (declaring where a
-- reference may appear is a placement rule, and placement is already a
-- cross-block rule's job).
--
-- richmd validates MEMBERSHIP and never reads a property's meaning: the
-- properties object is opaque payload, carried through to a resolved token
-- (CONTEXT.md#term-resolved-token) untouched. richmd ships no vocabulary of
-- its own — the set is always the consumer's.
--
-- Load-time errors (invalid JSON, a missing `members` field, or a `members`
-- field that is not an object) are FATAL at filter startup — identical in
-- spirit to how extension-loader.lua aborts on a malformed block schema and
-- rules-loader.lua on a malformed rule. A broken vocabulary must never be
-- silently skipped (design.md §06 failure behavior).
--
-- This module deliberately does NOT share code with extension-loader.lua or
-- rules-loader.lua (sibling modules for block kinds and rules, not
-- vocabularies) — the three are similar by convention, not by a shared
-- helper; see richmd-filter.lua's own comments for why that refactor is out
-- of scope.

local TokensLoader = {}

-- DEFAULT_DIR: the tokens directory name, relative to wherever it is
-- resolved against (see richmd-filter.lua's config_dir resolution,
-- ADR-0009).
TokensLoader.DEFAULT_DIR = ".richmd/tokens"

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

-- list_json_files(dir_path) -> { path, ... }
--
-- Lists every `*.json` file directly inside dir_path. Lua has no portable
-- stdlib directory-listing function, so this shells out to `ls -1`
-- (available on every platform richmd targets: macOS/Linux dev shells and
-- CI) — the exact same pattern extension-loader.lua's list_schema_files and
-- rules-loader.lua's list_lua_files use for the identical narrow need.
local function list_json_files(dir_path)
  local handle = io.popen(
    "ls -1 " .. "'" .. dir_path:gsub("'", "'\\''") .. "'" .. "/*.json 2>/dev/null"
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

-- validate_vocabulary_shape(vocabulary, json_path)
--
-- A malformed vocabulary FILE (invalid JSON, or valid JSON with a missing or
-- non-object `members` field) is a load-time error naming the offending file
-- — fatal, not a collected validation error (design.md §06 failure
-- behavior).
--
-- Note `members` must be an OBJECT, and pandoc.json.decode maps both a JSON
-- object and a JSON array onto a Lua table. An empty JSON array `[]` decodes
-- to an empty Lua table, indistinguishable from an empty object `{}` — and
-- an empty member set, while useless, is not malformed (every reference to
-- it simply fails closed), so it is accepted rather than special-cased. A
-- NON-empty array is rejected below by its integer keys: a member key is
-- always a string.
local function validate_vocabulary_shape(vocabulary, json_path)
  if type(vocabulary) ~= "table" then
    fatal("could not parse token vocabulary file '" .. json_path .. "' (invalid JSON)")
  end
  if vocabulary.members == nil then
    fatal("token vocabulary file '" .. json_path .. "' is missing required field 'members'")
  end
  if type(vocabulary.members) ~= "table" then
    fatal(
      "token vocabulary file '"
        .. json_path
        .. "' has an invalid 'members' field (must be an object mapping member key to that member's properties)"
    )
  end
  for member_key in pairs(vocabulary.members) do
    if type(member_key) ~= "string" then
      fatal(
        "token vocabulary file '"
          .. json_path
          .. "' has an invalid 'members' field (must be an object mapping member key to that member's properties)"
      )
    end
  end
end

-- load(dir_path) -> { [vocabulary_name] = { members = { [member_key] =
--                     <properties table>, ... } }, ... }
--
-- Scans dir_path for `*.json` files and loads each into the returned table,
-- keyed by the vocabulary's filename-derived name. Silently returns an empty
-- table if dir_path does not exist at all — the tokens directory is
-- optional, like rules-loader.lua's own `.richmd/rules/`
-- (CONTEXT.md#term-tokens-directory); most documents declare no vocabulary
-- at all, and the whole pass is then inert.
function TokensLoader.load(dir_path)
  local json_files = list_json_files(dir_path)

  local vocabularies = {}
  for _, json_path in ipairs(json_files) do
    local vocabulary_name = json_path:match("([^/]+)%.json$")
    if not vocabulary_name then
      fatal("could not derive a vocabulary name from token vocabulary file '" .. json_path .. "'")
    end

    local json_text = read_file(json_path)
    if not json_text then
      fatal("could not read token vocabulary file '" .. json_path .. "'")
    end

    local ok, vocabulary = pcall(pandoc.json.decode, json_text)
    if not ok or vocabulary == nil then
      fatal("could not parse token vocabulary file '" .. json_path .. "' (invalid JSON)")
    end

    validate_vocabulary_shape(vocabulary, json_path)

    -- Only `members` is carried forward: the vocabulary's one declared
    -- field. Each member's properties table is stored exactly as decoded —
    -- richmd never reads a property's meaning (ADR-0011).
    vocabularies[vocabulary_name] = { members = vocabulary.members }
  end

  return vocabularies
end

return TokensLoader
