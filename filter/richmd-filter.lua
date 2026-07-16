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
local RulesLoader = require("rules-loader")
local TokensLoader = require("tokens-loader")
local HeadingScope = require("heading-scope")

-- One registry instance, shared across validate and render phases and
-- across consumer-registered kinds.
local registry = Registry.new()

-- Built-in kinds register themselves into the shared registry at startup.
require("blocks.callout").register(registry)
require("blocks.mermaid").register(registry)
require("blocks.vega-lite").register(registry)
require("blocks.cards").register(registry)
require("blocks.stat-tile").register(registry)
require("blocks.stat-grid").register(registry)
require("blocks.toc").register(registry)
require("blocks.labeled-block").register(registry)
require("blocks.embedded-svg").register(registry)
require("blocks.chart").register(registry)

-- process_cwd() -> path
--
-- The actual working directory the OS process (and therefore Pandoc, which
-- never chdirs) was launched from. Lua's stdlib has no portable getcwd(),
-- so this shells out to `pwd` — the same io.popen convention
-- extension-loader.lua's list_schema_files already uses for a filesystem
-- operation Lua's stdlib cannot do natively. Confirmed against a real
-- `pandoc --lua-filter` invocation: when richmd is invoked the ordinary way
-- (`richmd render doc.md` run from doc.md's own directory — every example
-- in USAGE_RULES.md, every existing test before this fix),
-- PANDOC_STATE.input_files[1] comes back as the bare relative filename
-- "doc.md" with no "/" in it at all, and bin/richmd.js's runFilter spawns
-- `pandoc` via spawnSync with no `cwd` override and passes the `<file>`
-- argument straight through untouched (see that file's own header comment:
-- "richmd does no cwd-relative path normalization anywhere else in this
-- codebase") — so `pwd` at the moment this filter runs is exactly the
-- directory a bare relative input path must be resolved against.
local function process_cwd()
  local handle = io.popen("pwd")
  if not handle then
    return "."
  end
  local cwd = handle:read("*l")
  handle:close()
  return cwd or "."
end

-- The current document's own directory, used both to resolve relative
-- `.md` link targets against the filesystem (§06 link resolver) AND as the
-- starting point for the config-directory upward walk (ADR-0009,
-- CONTEXT.md#term-config-directory, resolve_config_dir below). Pandoc
-- exposes the input file path via PANDOC_STATE.input_files; richmd is
-- always invoked with exactly one input file (bin/richmd.js).
--
-- input_path is resolved to an ABSOLUTE path before a directory is derived
-- from it. A bare relative filename like "doc.md" has no "/" to split on,
-- so the naive `"(.*)/[^/]*$" or "."` pattern used to fall through to the
-- literal string "." — a symbolic placeholder, not a real, climbable
-- filesystem path. resolve_config_dir's upward walk calls parent_dir on
-- whatever start_dir it's given; parent_dir(".") also has no "/" to split
-- on, so it returns nil immediately, and the walk terminated after checking
-- only "." itself, never actually reaching the real ancestor directories
-- above the process's real working directory (the bug this function fixes).
-- Resolving against process_cwd() first means doc_dir is always a genuine
-- absolute path parent_dir can keep climbing.
local function current_doc_dir()
  local input_files = PANDOC_STATE and PANDOC_STATE.input_files
  local input_path = input_files and input_files[1]
  if not input_path then
    return process_cwd()
  end

  local absolute_input_path = input_path
  if input_path:sub(1, 1) ~= "/" then
    absolute_input_path = process_cwd() .. "/" .. input_path
  end

  return absolute_input_path:match("(.*)/[^/]*$") or process_cwd()
end

local doc_dir = current_doc_dir()

-- dir_exists(path) -> boolean | nil
--
-- nil specifically means "exists, but could not be read" (a genuine
-- permission/stat error) as distinct from `false` ("no such directory") —
-- the upward walk below (resolve_config_dir) treats the two differently: a
-- `false` keeps climbing, a `nil` stops the walk exactly like reaching the
-- `.git` boundary (CONTEXT.md#term-config-directory: "a permission error
-- during the walk stops the walk exactly like reaching the boundary, never
-- silently skips past the unreadable directory to keep climbing"). Lua has
-- no portable stat() in its stdlib, so this shells out to `test -d`/`test
-- -r`, mirroring extension-loader.lua's own `io.popen("ls ...")` precedent
-- for filesystem checks this codebase has no other dependency for.
--
-- Order matters: `test -d` is checked FIRST. A path that doesn't exist at
-- all makes every `test` predicate (including `-r`/`-x`) fail identically
-- to a real permission error (confirmed against a real `pandoc lua`
-- invocation) — checking existence before readability is the only way to
-- tell "not there" apart from "there, but unreadable".
local function dir_exists(path)
  local quoted = "'" .. path:gsub("'", "'\\''") .. "'"
  local is_dir = os.execute("test -d " .. quoted .. " 2>/dev/null")
  if not is_dir then
    return false
  end
  -- It exists as a directory; now check it can actually be read/searched
  -- (listable) — a directory that exists but is not readable/searchable by
  -- this process must stop the walk like a boundary, not be silently
  -- skipped.
  local readable = os.execute("test -r " .. quoted .. " -a -x " .. quoted .. " 2>/dev/null")
  if not readable then
    return nil
  end
  return true
end

-- parent_dir(path) -> path | nil
--
-- Returns the parent of `path`, or nil when `path` is already a filesystem
-- root (no further "/" to split on) — the walk's own termination check for
-- "ran off the top of the filesystem" without ever finding a `.git`
-- boundary (an edge case ADR-0009 does not name explicitly, but the walk
-- must still terminate rather than loop forever).
local function parent_dir(path)
  local trimmed = path:match("(.-)/*$") -- strip trailing slashes
  if trimmed == "" then
    return nil
  end
  local parent = trimmed:match("(.*)/[^/]+$")
  if not parent then
    return nil
  end
  if parent == "" then
    return "/"
  end
  return parent
end

-- resolve_config_dir(start_dir) -> path
--
-- Walks upward from `start_dir` (inclusive) looking for a `.richmd/`
-- subdirectory (ADR-0009, CONTEXT.md#term-config-directory). "Nearest
-- wins, no merge": the first ancestor (including start_dir itself)
-- containing `.richmd/` is returned immediately. The walk stops at the
-- first of: a `.richmd/` is found; the directory being checked itself
-- contains `.git` (checked for its OWN `.richmd/` first, then the walk
-- stops regardless of whether it found one there — the repo root's
-- `.richmd/`, if present, still counts); or a directory cannot be read
-- (stops exactly like reaching the boundary, never skips past it). Falls
-- back to `start_dir` itself when none of the above ever finds a
-- `.richmd/` — byte-identical to richmd's pre-ADR-0009 behavior when no
-- `.git` exists anywhere above the document either.
local function resolve_config_dir(start_dir)
  local current = start_dir
  while current do
    local has_richmd = dir_exists(current .. "/.richmd")
    if has_richmd == nil then
      -- Permission/stat error reading this directory: stop exactly like a
      -- boundary, fall back to the document's own directory.
      return start_dir
    end
    if has_richmd then
      return current
    end

    local has_git = dir_exists(current .. "/.git")
    if has_git == nil then
      return start_dir
    end
    if has_git then
      -- Repo root reached; its own .richmd/ was already checked above (and
      -- was absent, or we would have returned already). Stop regardless.
      return start_dir
    end

    current = parent_dir(current)
  end
  return start_dir
end

-- The resolved config directory (ADR-0009, CONTEXT.md#term-config-directory):
-- module-level, computed once at startup — same timing/scope convention as
-- doc_dir above — so later code in this file (and, per the design's stated
-- intent, a future sibling `.richmd/rules/` loader) can read it without
-- re-deriving it. Printed to stderr on EVERY invocation (render and
-- validate alike) so which `.richmd/` a given call actually used is never a
-- silent fact (design.md §03).
local config_dir = resolve_config_dir(doc_dir)
io.stderr:write("richmd: config directory resolved to '" .. config_dir .. "'\n")

-- tree_paths: the `--tree=<path>` flag's path set (design.md §02/§06,
-- ADR-0005), read ONCE at filter startup — same timing convention as
-- doc_dir above and as RICHMD_VALIDATE_ONLY/RICHMD_OFFLINE elsewhere in this
-- file, never re-read per-link. bin/richmd.js joins every repeated
-- `--tree=` occurrence into one RICHMD_TREE env var, comma-delimited (see
-- that file's own comment for why comma was chosen over a null byte or
-- other separator); this splits it back into a Lua table used as a set
-- (`{[path]=true, ...}`) for O(1) membership checks in render_only_link,
-- below. Absent entirely (os.getenv returns nil, exactly like the other two
-- env vars when their flag is not passed), tree_paths is an empty table —
-- membership checks against it always miss, so render_only_link's output is
-- untouched, satisfying the "byte-identical when --tree is absent"
-- requirement.
--
-- Path-matching convention: a `--tree` value is compared VERBATIM (no
-- normalization, no re-resolution against doc_dir) against each link's own
-- resolved path, which IS built as `doc_dir .. "/" .. path_part` — the
-- exact same resolution validate_only_link already uses for the identical
-- link target. This means `--tree` values are expected to already be given
-- in a form that matches that resolution, i.e. either absolute paths, or
-- paths relative to the same directory doc_dir itself resolves from
-- (PANDOC_STATE's input file path, which bin/richmd.js passes through
-- untouched from argv). This mirrors bin/richmd.js's existing convention of
-- never rewriting a path it's handed (it passes the `<file>` argument
-- straight to Pandoc as given) — richmd does no cwd-relative path
-- normalization anywhere else in this codebase, so introducing it only for
-- `--tree` would be a new, inconsistent behavior. In practice this means a
-- caller passes `--tree` values in the same shape as the document's own
-- link targets (both relative to doc_dir) or as absolute paths for both —
-- either way, the comparison the caller sees is the same string-equality
-- check they can reason about from the interface alone, with no hidden
-- resolution step to keep track of.
local tree_paths = {}
do
  local raw = os.getenv("RICHMD_TREE")
  if raw then
    for entry in raw:gmatch("[^,]+") do
      tree_paths[entry] = true
    end
  end
end

-- Consumer-defined kinds (design.md §04, ADR-0003, §00 principle P4 "extend
-- by composition, never by fork") register into the SAME shared registry
-- instance as built-ins, from the consumer's own extension directory
-- (default `.richmd/blocks/`, resolved against the WALKED config_dir above —
-- ADR-0009 — not raw doc_dir; the consumer repo's root, not richmd's). A
-- malformed schema or Lua file here is a load-time error
-- (filter/extension-loader.lua calls `error(...)`), which aborts the whole
-- filter run before any AST walk begins — distinct from a per-block
-- validation error collected below.
ExtensionLoader.load(registry, config_dir .. "/" .. ExtensionLoader.DEFAULT_DIR)

-- Cross-block rules (design.md §05, ADR-0008, CONTEXT.md#term-cross-block-
-- rule) — consumer-authored `.lua` files under the rules directory (default
-- `.richmd/rules/`, resolved against the walked config_dir above, same
-- convention as ExtensionLoader.load just above). Loaded ONCE at filter
-- startup, same timing as ExtensionLoader.load. A malformed rule file
-- (filter/rules-loader.lua calls `error(...)`) aborts the whole filter run
-- before any AST walk begins — distinct from a per-block validation error
-- collected below. Each rule's `check` is actually invoked later, once per
-- document, as a step of the validate phase (see Pandoc(doc) below).
local rules = RulesLoader.load(config_dir .. "/" .. RulesLoader.DEFAULT_DIR)

-- Token vocabularies (design.md §06, ADR-0011, CONTEXT.md#term-token-
-- vocabulary) — consumer-authored `.json` files under the tokens directory
-- (default `.richmd/tokens/`, resolved against the walked config_dir above,
-- same convention as the two loaders just above). Loaded ONCE at filter
-- startup, same timing as ExtensionLoader.load / RulesLoader.load. A
-- malformed vocabulary file (filter/tokens-loader.lua calls `error(...)`)
-- aborts the whole filter run before any AST walk begins — distinct from a
-- validation error collected below. References are actually resolved later,
-- once per document, as a step of the validate phase (see Pandoc(doc)).
local token_vocabularies = TokensLoader.load(config_dir .. "/" .. TokensLoader.DEFAULT_DIR)

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

-- validate_attr_token(attr_schema, attr_name, value, kind_name, location)
--   -> resolved_token | nil
--
-- The SECOND token recognition surface (design.md §06 Interface, ADR-0011).
-- The first — an inline `<vocabulary>:<member>` code span — is recognized
-- STRUCTURALLY, wherever it appears, by resolve_tokens below. A block attr
-- is recognized BY DECLARATION instead: it is a reference only when its
-- block kind schema opts it in with `tokens=<vocabulary>`. richmd NEVER
-- infers a reference from an attr's NAME — an attr literally named `lens` on
-- a schema that does not opt it in is an ordinary string attr, untouched
-- (ADR-0011 "What richmd recognizes": inferring from the name "would make an
-- unrelated `lens=` attr silently token-validated, and would bind vocabulary
-- names to attr names across every consumer schema forever").
--
-- The attr's whole value is ONE member key, looked up EXACTLY — an opted-in
-- attr holds exactly one member (design.md §04 Interface). There is no
-- split, on any delimiter: `lens="state composition"` is one lookup of the
-- member `state composition`, failing closed unless that exact key is
-- declared, even when `state` and `composition` are both declared members.
-- Multiplicity is not this attr's to express (ADR-0011: there is no
-- combinator, by decision) — which is also why the attr carries the bare
-- member key and never the code span's `<vocabulary>:<member>` shape: the
-- vocabulary is already named by the schema, so repeating it in the value
-- would be a second fact the two could disagree about.
--
-- Errors here are sourced to the BLOCK'S OWN KIND via the same add_error
-- shape the enum branch below already uses, NOT to `token:<vocabulary>` as a
-- code span's error is. The distinction is what the error is ABOUT: a span's
-- error is about a reference standing on its own in prose, whose only
-- context is its vocabulary; an attr's error is about THIS block's attr
-- being wrong, exactly like a bad enum value or a missing required attr, and
-- it reads that way — `[lens-card] div.lens-card: attr 'lens' ...`.
local function validate_attr_token(attr_schema, attr_name, value, kind_name, location)
  local vocabulary_name = attr_schema.tokens
  local vocabulary = token_vocabularies[vocabulary_name]

  -- A schema opting an attr into a vocabulary that was never declared is a
  -- broken schema, and must fail LOUDLY rather than silently pass the attr
  -- through as an ordinary string (§00: a token reference resolves to a
  -- declared member, never to prose). Note this is the exact OPPOSITE of a
  -- code span naming an undeclared vocabulary, which IS ordinary prose: a
  -- span's prefix is a coincidence of text, whereas a schema's `tokens`
  -- field is a deliberate declaration that can only be a mistake if the
  -- vocabulary is missing.
  if not vocabulary then
    add_error(
      kind_name,
      location,
      "attr '"
        .. attr_name
        .. "' is opted into token vocabulary '"
        .. tostring(vocabulary_name)
        .. "', which is not declared"
    )
    return nil
  end

  local properties = vocabulary.members[value]
  if properties == nil then
    -- Fails closed, naming BOTH the vocabulary and the unknown member
    -- (design.md §06 Failure behavior).
    add_error(
      kind_name,
      location,
      "attr '"
        .. attr_name
        .. "' has unknown member '"
        .. value
        .. "' in token vocabulary '"
        .. vocabulary_name
        .. "'"
    )
    return nil
  end

  -- The SAME resolved-token shape a code span resolves to (see
  -- resolve_tokens, CONTEXT.md#term-resolved-token) — a flat value, never a
  -- live reference into the Pandoc AST. Returned rather than dropped so §06
  -- can hand it to the block projection builder in a later change; nothing
  -- consumes it yet.
  return {
    vocabulary = vocabulary_name,
    member = value,
    properties = properties,
    location = location,
  }
end

-- validate_attrs(schema, attrs, kind_name, location)
--   -> resolved_attrs, resolved_tokens
--
-- Checks the block's attrs against its schema's `attrs` table (required/
-- optional, enum values, token vocabulary membership) and returns the
-- resolved attr values regardless of whether errors were found — the render
-- phase is never reached when errors exist, so a partially-resolved table
-- here is harmless. `resolved_tokens` collects a resolved token per opted-in
-- attr that resolved cleanly (empty for the overwhelming majority of blocks,
-- whose schemas opt no attr in).
local function validate_attrs(schema, attrs, kind_name, location)
  local resolved = {}
  local resolved_tokens = {}
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
      if attr_schema.tokens then
        local resolved_token =
          validate_attr_token(attr_schema, attr_name, value, kind_name, location)
        if resolved_token then
          table.insert(resolved_tokens, resolved_token)
        end
      elseif attr_schema.type == "enum" then
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
  return resolved, resolved_tokens
end

-- validate_attrs_silently(schema, attrs, kind_name, location)
--   -> resolved_attrs, resolved_tokens
--
-- validate_attrs, run purely for its resolved_tokens, with any errors it
-- would report DISCARDED. Used only by build_block_projections, to re-derive
-- a block's OWN opted-in attr tokens (design.md §06's second recognition
-- surface) for the projection's `tokens` field.
--
-- The re-run is deliberate: the validate walk that ALREADY checked this
-- block ran over a separate doc:walk(), and Pandoc's AST-node identity is
-- not guaranteed to survive across two walks (see validate_only_div's own
-- comment), so a token resolved there cannot be handed forward by node
-- identity. Re-resolving from the schema is the same generic, deterministic
-- lookup and yields the identical result — but its ERRORS were already
-- collected by that first walk, and letting a second run append them again
-- would report every bad attr twice. So this discards whatever the re-run
-- appends, restoring `errors` to exactly the length it had on entry. It can
-- only ever discard duplicates: this runs after the validate walk covered
-- every one of these same blocks with the same schema.
local function validate_attrs_silently(schema, attrs, kind_name, location)
  if not schema then
    return {}, {}
  end
  local errors_before = #errors
  local resolved, resolved_tokens = validate_attrs(schema, attrs, kind_name, location)
  for index = #errors, errors_before + 1, -1 do
    table.remove(errors, index)
  end
  return resolved, resolved_tokens
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

  if schema.validate then
    schema.validate(block, kind_name, location, add_error)
  end

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

-- heading_anchor_id(header, seen_slugs) -> string
--
-- THE single source of truth for "this header's anchor id"
-- (CONTEXT.md#term-anchor-id, §00 invariant "a heading's anchor id is
-- deterministic: explicit id, else slug"): a heading's own explicit Pandoc
-- id — already parsed by Pandoc itself from `{#id}` syntax, so this never
-- re-parses attr syntax by hand — wins when present and non-empty;
-- otherwise its slug, computed by the identical Slugify.slugify function
-- either way. Called from BOTH the render phase (render_only_header, which
-- assigns the actual `id` a reader's browser sees) and the validate phase
-- (target_heading_slugs, below, which builds the set of ids a `#fragment`
-- link is allowed to resolve against) — one function, two callers, so the
-- two can never disagree (the whole point of the invariant this helper
-- exists to hold).
local function heading_anchor_id(header, seen_slugs)
  if header.identifier and header.identifier ~= "" then
    return header.identifier
  end
  local heading_text = pandoc.utils.stringify(header.content)
  return Slugify.slugify(heading_text, seen_slugs)
end

-- HTML_ID_ATTR_PATTERN: matches an `id="..."` (or `id='...'`) attribute
-- anywhere in a raw HTML string. Deliberately permissive about which tag
-- carries it (CONTEXT.md#term-anchor-id: "a raw HTML element's own
-- id=\"...\" attribute... richmd does not distinguish" which tag) — `<a
-- id="...">`, `<span id="...">`, `<div id="...">` are all equally valid
-- anchor sources, so this pattern matches the attribute itself, never a
-- specific tag name.
local function collect_html_ids(html_text, ids)
  for quote, id in html_text:gmatch("id=([\"'])(.-)%1") do
    ids[id] = true
  end
end

-- target_anchor_ids(resolved_path) -> { [id] = true, ... }
--
-- Parses the target `.md` file and computes every anchor id it will expose
-- once rendered: each heading's id via the SAME heading_anchor_id function
-- used to assign `id`s in the render phase (render_only_header, below) —
-- one source of truth, so a `#fragment` link and its target heading's id
-- can never disagree (§00 invariant) — plus every raw HTML `id="..."`
-- attribute found anywhere while walking the document (any tag, not just
-- `<a>` — §00 invariant "fragment resolution sees every authored anchor
-- id"). Used only to check that a `#fragment` names an anchor that actually
-- exists in the target document; widening the known-id set here never
-- narrows what a previously-valid link resolves to.
local function target_anchor_ids(resolved_path)
  local file = io.open(resolved_path, "r")
  if not file then
    return nil
  end
  local content = file:read("*a")
  file:close()

  -- "markdown-auto_identifiers", not plain "markdown": disables Pandoc's
  -- own built-in heading-id auto-assignment (see bin/richmd.js's identical
  -- comment on the CLI's own `-f` flag) so this independent re-parse
  -- produces the SAME empty-unless-explicit `header.identifier` the main
  -- document's own Pandoc invocation sees — otherwise heading_anchor_id
  -- would see a non-empty auto-slugified identifier here even for a
  -- heading with no authored `{#id}`, and wrongly treat it as explicit.
  local ok, target_doc = pcall(pandoc.read, content, "markdown-auto_identifiers")
  if not ok then
    return nil
  end

  -- Mark internal-only headers (e.g. cards.lua's per-card `### heading`
  -- titles) BEFORE collecting ids, exactly like the render phase does below
  -- (render_only_header) — a `#fragment` link must be checked against the
  -- SAME set of real headings the target document will actually assign ids
  -- to, never against a card title that never became an addressable
  -- heading in the rendered target page (§00 invariant: a `#fragment` link
  -- and its target heading's id can never disagree).
  target_doc = HeadingScope.mark(target_doc, registry)

  local ids = {}
  local target_seen_slugs = Slugify.new_seen()
  target_doc:walk({
    Header = function(header)
      if HeadingScope.is_internal(header) then
        return -- not a real heading; never contributes an id
      end
      ids[heading_anchor_id(header, target_seen_slugs)] = true
    end,
    -- A raw `id="..."` attribute survives Pandoc's own parse in one of two
    -- shapes, depending on the tag (confirmed by direct probe against a
    -- real `pandoc -t native`, not assumed): `<span id="...">...</span>`
    -- and `<div id="...">...</div>` (open/close tags wrapping content, even
    -- empty content) are collapsed into native Span/Div AST nodes carrying
    -- the id as `.identifier`, exactly like a Header's own explicit id —
    -- Pandoc never leaves these as raw HTML text to begin with. `<a
    -- id="...">` (and any tag Pandoc's HTML reader does NOT collapse to a
    -- native node — e.g. an unclosed/self-closing tag, or `<a>` specifically,
    -- which Pandoc keeps raw for link-parsing reasons) instead survives as a
    -- RawInline/RawBlock with format "html", whose id has to be pulled out
    -- of the literal tag text by hand. Both paths feed the SAME `ids` set —
    -- richmd does not distinguish which shape Pandoc happened to choose for
    -- a given tag, only that an author wrote an explicit id="..." somewhere.
    Span = function(span)
      if span.identifier and span.identifier ~= "" then
        ids[span.identifier] = true
      end
    end,
    Div = function(div)
      if div.identifier and div.identifier ~= "" then
        ids[div.identifier] = true
      end
    end,
    RawInline = function(raw)
      if raw.format == "html" then
        collect_html_ids(raw.text, ids)
      end
    end,
    RawBlock = function(raw)
      if raw.format == "html" then
        collect_html_ids(raw.text, ids)
      end
    end,
  })
  return ids
end

-- Pass 1 (validate phase): every relative `.md` link target must resolve to
-- an existing file on disk, relative to the CURRENT document's own
-- directory (§00 invariant: cross-document links always resolve). A
-- dangling target is collected via the same `add_error` mechanism used for
-- callout/registry errors — never a separate path. When the link also
-- carries a `#fragment`, that fragment is checked against the target
-- document's own heading slugs (computed via the identical slugify
-- function the render phase uses to assign heading ids).
local function validate_only_link(link)
  local path_part, fragment_part = split_target(link.target)
  if not is_relative_md_link(path_part) then
    return nil -- not a cross-document link; nothing to validate
  end

  local resolved_path = doc_dir .. "/" .. path_part
  local file = io.open(resolved_path, "r")
  if not file then
    add_error(
      "link",
      "link." .. link.target,
      "cross-document link target '" .. path_part .. "' does not exist (resolved to '" .. resolved_path .. "')"
    )
    return nil
  end
  file:close()

  if fragment_part then
    local ids = target_anchor_ids(resolved_path)
    if ids and not ids[fragment_part] then
      add_error(
        "link",
        "link." .. link.target,
        "cross-document link target '" .. path_part .. "' has no heading matching fragment '#" .. fragment_part .. "'"
      )
    end
  end
  return nil
end

-- richmd_kind_of(div) -> kind_name | nil, unknown_class | nil
--
-- A fenced div with no classes at all is never richmd-authored content and
-- is left completely untouched. A fenced div WITH classes, however, IS a
-- Block: per CONTEXT.md#term-block's explicit Div/CodeBlock distinction,
-- `::: {.kind}` is richmd's primary authoring syntax, so a Div's class is
-- always a kind attempt — a class with no registry match is a validation
-- error, never a silent pass-through (design.md §04's Interface field).
-- (CodeBlocks are read differently on purpose — see
-- richmd_kind_of_codeblock below.) The first class is used as the reported
-- kind name (arbitrary but stable choice when multiple classes are
-- present).
local function richmd_kind_of(div)
  if #div.classes == 0 then
    return nil, nil -- no classes at all; never a Block, leave untouched
  end
  for _, class in ipairs(div.classes) do
    local schema = select(1, registry:lookup(class))
    if schema then
      return class, nil
    end
  end
  return nil, div.classes[1]
end

-- Pass 1 (validate phase): walk the whole AST, collect every error. Never
-- renders, never transforms — Pandoc's AST-node identity is not guaranteed
-- to survive across two separate doc:walk() calls, so this phase does not
-- try to hand anything forward to the render phase; the render phase
-- (below) independently re-derives each block's kind via the same generic
-- registry:lookup, exactly like this phase does.
local function validate_only_div(div)
  local kind_name, unknown_class = richmd_kind_of(div)
  if not kind_name then
    if unknown_class then
      add_error(
        unknown_class,
        "div." .. unknown_class,
        "unknown block kind '" .. unknown_class .. "'"
      )
    end
    return nil -- not a richmd block kind (or already reported); leave untouched
  end
  validate_block(div, kind_name)
  return nil
end

-- richmd_kind_of_codeblock(code_block) -> kind_name | nil
--
-- Unlike richmd_kind_of (Divs) above, a CodeBlock's class is read
-- differently on purpose (CONTEXT.md#term-block, design.md §04's Interface
-- field): by universal Pandoc/CommonMark convention a code block's class
-- names a code sample's language for editor/viewer styling (` ```js `,
-- ` ```python `), not a kind attempt — richmd only treats a CodeBlock as a
-- Block when its class is one it explicitly recognizes (`mermaid`,
-- `vega-lite`, ...). A class with no registry match is always ordinary
-- code, left completely untouched, never a validation error.
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
    return nil -- not a recognized richmd block kind; ordinary code, leave untouched
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

-- build_block_projections(doc)
--   -> { { kind, attrs, location, body_text, tokens }, ... }
--
-- Builds the document's ordered block projection list
-- (CONTEXT.md#term-block-projection): a frozen snapshot of every recognized
-- richmd Block (Div with a known kind, or CodeBlock with a known kind),
-- taken once. Reuses the EXACT SAME kind-identification logic the validate
-- walk already uses (richmd_kind_of / richmd_kind_of_codeblock) and the
-- EXACT SAME location-string convention validate_block/
-- validate_only_codeblock already report errors with ("div." .. kind_name /
-- "codeblock." .. kind_name) — so a rule's reported <location> reads
-- identically to a per-block error's.
--
-- Called ONLY after the per-block/link/grammar validate walk above has
-- already completed (see Pandoc(doc) below) — every projection here
-- reflects a block that already passed its own schema (design.md §05
-- stated invariant, ADR-0008). Never a live reference into the Pandoc AST:
-- `attrs` is copied into a plain table, `body_text` is extracted via
-- pandoc.utils.stringify (the standard Pandoc idiom for AST-to-plain-text)
-- for a Div, or the CodeBlock's own `.text` field directly, and `tokens`
-- holds flat resolved-token values (CONTEXT.md#term-resolved-token).
--
-- --- How a token is associated with the block it was found WITHIN ---
--
-- `tokens` is "the resolved tokens found within it"
-- (CONTEXT.md#term-block-projection), gathered from BOTH recognition
-- surfaces (design.md §06 Interface) into ONE ordered list:
--
--   1. the block's OWN opted-in ATTRS — re-derived here via the same
--      validate_attrs the validate walk already ran, whose second return is
--      exactly this block's resolved attr tokens;
--   2. every `<vocabulary>:<member>` inline CODE SPAN within the block's
--      content — collected by a NESTED walk over that block's own content,
--      which is what makes the association structural rather than
--      positional.
--
-- The nested walk is the crux. resolve_tokens walks the WHOLE document for
-- Code inlines and cannot say which block each span sat in; this builder
-- walks blocks and knows nothing of spans. Rather than run both walks and
-- match their results up by position — which would silently couple two
-- traversal orders and break the moment either changed — each block simply
-- resolves its own content, so containment is read off the AST's actual
-- structure. Recognition cannot drift between the two: both go through the
-- one resolve_code_token. This walk passes `report = false` because
-- resolve_tokens already reported every span's errors document-wide;
-- reporting here too would double them.
--
-- Consequences worth naming, both deliberate:
--   * a reference OUTSIDE any recognized block (a plain paragraph, a
--     top-level heading) is resolved and validated by resolve_tokens but
--     lands in no projection's `tokens` — it is within no block;
--   * a NESTED block's tokens appear on BOTH the inner and the outer
--     block's projections, because they genuinely are within both — the
--     same containment `body_text` already reports, since stringify of a
--     Div's content likewise includes its nested blocks' text.
--
-- Order is DOCUMENT order — attr tokens first (the attr precedes the body
-- it labels), then spans as they appear. richmd never sorts, groups, or
-- dedupes by any property: it validates membership and never interprets a
-- property's meaning (ADR-0011). A block with no references gets an empty
-- list, never nil, so a rule never needs a nil check.
-- Forward declaration: resolve_code_token is defined below, next to
-- resolve_tokens (the pass that owns the inline surface's reporting), but is
-- called from here — the one recognition path both share.
local resolve_code_token

local function block_content_tokens(block_content, resolved_tokens)
  pandoc.Div(block_content):walk({
    Code = function(code)
      local resolved_token = resolve_code_token(code, false)
      if resolved_token then
        table.insert(resolved_tokens, resolved_token)
      end
      return nil
    end,
  })
end

local function build_block_projections(doc)
  local projections = {}

  doc:walk({
    Div = function(div)
      local kind_name = richmd_kind_of(div)
      if not kind_name then
        return nil
      end
      local attrs = {}
      for key, value in pairs(div.attributes) do
        attrs[key] = value
      end
      local schema = select(1, registry:lookup(kind_name))
      local location = "div." .. kind_name
      -- Surface 2 (the block's own opted-in attrs), then surface 1 (spans
      -- within the body) — see this function's comment for the ordering.
      local _, tokens = validate_attrs_silently(schema, div.attributes, kind_name, location)
      block_content_tokens(div.content, tokens)
      table.insert(projections, {
        kind = kind_name,
        attrs = attrs,
        location = location,
        body_text = pandoc.utils.stringify(div.content),
        tokens = tokens,
      })
      return nil
    end,
    CodeBlock = function(code_block)
      local kind_name = richmd_kind_of_codeblock(code_block)
      if not kind_name then
        return nil
      end
      local attrs = {}
      for key, value in pairs(code_block.attributes) do
        attrs[key] = value
      end
      local schema = select(1, registry:lookup(kind_name))
      local location = "codeblock." .. kind_name
      -- A CodeBlock's body is another grammar's source text and is NEVER
      -- scanned for references (design.md §06 Failure behavior), so its
      -- opted-in attrs are its only surface.
      local _, tokens = validate_attrs_silently(schema, code_block.attributes, kind_name, location)
      table.insert(projections, {
        kind = kind_name,
        attrs = attrs,
        location = location,
        body_text = code_block.text or "",
        tokens = tokens,
      })
      return nil
    end,
  })

  return projections
end

-- resolve_code_token(code, report) -> resolved_token | nil
--
-- Resolves ONE `Code` inline span against the declared vocabularies — the
-- single place the first recognition surface's rules live (design.md §06
-- Interface, ADR-0011). Factored out of resolve_tokens so the projection
-- builder can re-derive a block's OWN tokens with byte-identical
-- recognition, rather than duplicating the rules or matching the two walks'
-- results up by position (see build_block_projections).
--
-- `report` selects whether an undeclared member records a validation error.
-- resolve_tokens passes true — it is the pass that OWNS the document-wide
-- error reporting (design.md §06 Responsibility). The projection builder
-- passes false: every span it re-resolves was already resolved and already
-- reported by that pass, and reporting again would double every error.
-- Resolution itself is pure and deterministic, so the two agree by
-- construction.
function resolve_code_token(code, report)
  -- Split on the FIRST colon only: everything before it is the candidate
  -- vocabulary name, everything after is the member key verbatim.
  local vocabulary_name, member_key = code.text:match("^([^:]*):(.*)$")
  if not vocabulary_name then
    return nil
  end

  local vocabulary = token_vocabularies[vocabulary_name]
  if not vocabulary then
    return nil
  end

  -- The reference's location, following the same "<node-type>.<name>"
  -- convention every other validate-phase location string already uses
  -- (validate_block's "div." .. kind_name, validate_only_codeblock's
  -- "codeblock." .. kind_name).
  local location = "code." .. vocabulary_name

  local properties = vocabulary.members[member_key]
  if properties == nil then
    if report then
      -- Fails closed, naming BOTH the vocabulary and the unknown member
      -- (design.md §06 Failure behavior). Never short-circuits the walk:
      -- every later reference is still resolved, so two unknown members
      -- produce two collected errors (§00 all-errors-collected).
      add_error(
        "token:" .. vocabulary_name,
        location,
        "unknown member '" .. member_key .. "' in token vocabulary '" .. vocabulary_name .. "'"
      )
    end
    return nil
  end

  return {
    vocabulary = vocabulary_name,
    member = member_key,
    properties = properties,
    location = location,
  }
end

-- resolve_tokens(doc) -> { { vocabulary, member, properties, location }, ... }
--
-- The token resolution pass (design.md §06, ADR-0011,
-- CONTEXT.md#term-token-resolution-pass): walks the document ONCE for token
-- references and resolves each against its vocabulary's closed member set,
-- recording a validation error for any member not in the set.
--
-- A document-wide check (CONTEXT.md#term-document-wide-check): called only
-- after the per-block/link/grammar validate walk has already completed (so
-- an opted-in attr's block already passed its own schema) and before
-- run_rules, which will consume its output (design.md §06 Interface).
--
-- Recognition is STRUCTURAL and singular. A `Code` INLINE span whose text
-- matches `<vocabulary>:<member>` for a DECLARED vocabulary is a reference
-- wherever it appears — headings included, since a heading's code span is an
-- ordinary code span (ADR-0011: "What richmd recognizes"). Three deliberate
-- non-recognitions, each ordinary prose rather than an error:
--   * a span whose prefix names no DECLARED vocabulary (`foo:bar`) — richmd
--     recognizes references only for vocabularies a consumer actually
--     declared;
--   * a span with no colon at all;
--   * anything inside a fenced CodeBlock — a `Code` inline and a `CodeBlock`
--     are different Pandoc node types, and this walk only ever registers the
--     former, so a CodeBlock's text is never scanned. That text is another
--     grammar's source, holding the same line the directive lift already
--     holds (design.md §06, ADR-0011).
--
-- The `<vocabulary>:<member>` shape is richmd's OWN fixed syntax, identical
-- for every consumer and deliberately not a knob. It splits on the FIRST
-- colon only, so a member key may itself contain colons (`lens:a:b` is the
-- member `a:b`). A reference is SINGULAR: richmd never splits it on any
-- further delimiter, so `lens:state+composition` is ONE key lookup of the
-- member `state+composition`, failing closed unless that exact key is
-- declared. Multiplicity is repetition — two members cited means two spans
-- (ADR-0011; there is no combinator, by decision).
--
-- Returns the resolved tokens (never a live reference into the Pandoc AST —
-- a flat value, CONTEXT.md#term-resolved-token). This pass owns REPORTING
-- for the inline surface, document-wide: a reference outside any recognized
-- block (a plain paragraph, a top-level heading) is validated here and
-- nowhere else, since it belongs to no block projection. The projection
-- builder re-derives each block's own tokens for §05's `tokens` field
-- (see build_block_projections).
local function resolve_tokens(doc)
  local resolved_tokens = {}

  if next(token_vocabularies) == nil then
    return resolved_tokens
  end

  doc:walk({
    Code = function(code)
      local resolved_token = resolve_code_token(code, true)
      if resolved_token then
        table.insert(resolved_tokens, resolved_token)
      end
      return nil
    end,
  })

  return resolved_tokens
end

-- run_rules(doc)
--
-- Runs each loaded cross-block rule ONCE against the document's block
-- projection list (design.md §05 Responsibility). Contributes to the SAME
-- `errors` table the per-block/link/grammar checks already populate, via
-- the SAME add_error closure — a rule's own error source is its filename,
-- `rule:`-prefixed (CONTEXT.md#term-error-source) so it can never collide
-- with a same-named block kind's bare error source.
--
-- A rule's `check` raising a Lua runtime error (not a load-time error — this
-- is DURING the check call) is a hard filter failure (design.md §05 Failure
-- behavior): caught here via pcall so every error already collected up to
-- that point (per-block, link, grammar, or an earlier rule in this same
-- pass) is still printed by the caller's existing fail-closed gate below,
-- rather than being discarded by an uncaught error unwinding past it. The
-- crash itself is reported as an error naming the rule (its `rule:<name>`
-- identifier) as BOTH the error source and the location, since the failure
-- is document-wide, not tied to one block. Any rules after the crashing one
-- in load order are simply never run — this function returns immediately
-- after recording the crash, rather than continuing to the next rule.
local function run_rules(doc)
  if #rules == 0 then
    return
  end

  local block_projections = build_block_projections(doc)

  for _, rule in ipairs(rules) do
    local source = "rule:" .. rule.name
    local ok, err = pcall(rule.check, block_projections, add_error)
    if not ok then
      add_error(source, source, "rule crashed: " .. tostring(err))
      return
    end
  end
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

-- diagram_theme_script_html() -> string
--
-- A single shared inline <script>, emitted ONCE per page (alongside the
-- toggle/anti-flash scripts, not per-diagram — every mermaid/vega-lite
-- block on the page reuses the same global helper rather than each
-- embedding its own copy). Defines `window.richmdDiagramTheme()`, which
-- reads the page's LIVE `--richmd-*` custom property values via
-- `getComputedStyle(document.querySelector(".richmd-doc"))` and returns a
-- plain object with the small set of colors both diagram kinds need
-- (background/surface/border/text/text-muted/accent/accent2 plus the body
-- font stack) — never a hardcoded hex value (design.md §00 principle P3,
-- §07: "a diagram's own colors are read from the page's live --richmd-*
-- custom properties at render time... never hardcoded"). Because this
-- reads the CSS live, at call time, a consumer who overrides
-- theme/default.css's variables (or a reader flipping the theme toggle,
-- which changes which values the SAME variables resolve to) is
-- automatically reflected the next time this function is called — no
-- richmd-owned code needs to know light/dark exist as concepts at all,
-- only that the variables might change.
--
-- Also defines `window.richmdRerenderDiagrams()`: a tiny pub/sub the
-- mermaid/vega-lite render scripts each push their own per-page re-render
-- callback onto (`window.richmdDiagramRerenders`, an array), and
-- `richmdRerenderDiagrams()` simply calls every callback currently in that
-- array. The toggle handler (theme_toggle_script_html) calls this after it
-- flips `data-richmd-theme`, via a `richmd-theme-changed` DOM CustomEvent
-- this script also listens for — a custom event (rather than the toggle
-- script calling mermaid/vega-lite's re-render functions directly) is the
-- cleaner seam here because the toggle script has no reason to know either
-- diagram kind exists (it is not a block-kind concept, per design.md §00's
-- "filter core stays generic" invariant applied to this new script too);
-- any number of independent diagram render scripts can add themselves as
-- listeners without the toggle or each other ever being edited.
local function diagram_theme_script_html()
  return [[<script>
  window.richmdDiagramTheme = function () {
    var el = document.querySelector(".richmd-doc") || document.documentElement;
    var cs = getComputedStyle(el);
    function v(name, fallback) {
      var value = cs.getPropertyValue(name);
      value = value && value.trim();
      return value || fallback;
    }
    var accentSolid = v("--richmd-color-accent-solid", "#4f46e5");
    var accent2Solid = v("--richmd-color-accent2-solid", "#0891b2");
    return {
      bg: v("--richmd-color-bg", "#ffffff"),
      bgAlt: v("--richmd-color-bg-alt", "#f0f0f0"),
      surface: v("--richmd-color-surface", "#ffffff"),
      surface2: v("--richmd-color-surface-2", "#f0f0f0"),
      border: v("--richmd-color-border", "rgba(0,0,0,0.1)"),
      borderStrong: v("--richmd-color-border-strong", "rgba(0,0,0,0.22)"),
      text: v("--richmd-color-text", "#000000"),
      textMuted: v("--richmd-color-text-muted", "rgba(0,0,0,0.62)"),
      textFaint: v("--richmd-color-text-faint", "rgba(0,0,0,0.4)"),
      accentSolid: accentSolid,
      accentText: v("--richmd-color-accent-text", "#4f46e5"),
      accentTint: v("--richmd-color-accent-tint", "#eef0fe"),
      accent2Solid: accent2Solid,
      accent2Text: v("--richmd-color-accent2-text", "#0891b2"),
      categorical: [
        accentSolid,
        accent2Solid,
        v("--richmd-color-cat-3", "#16a34a"),
        v("--richmd-color-cat-4", "#b45309"),
        v("--richmd-color-cat-5", "#db2777"),
        v("--richmd-color-cat-6", "#b91c1c"),
      ],
      fontBody: v("--richmd-font-body", "sans-serif"),
    };
  };

  window.richmdDiagramRerenders = window.richmdDiagramRerenders || [];
  window.richmdRerenderDiagrams = function () {
    window.richmdDiagramRerenders.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
  };

  document.addEventListener("richmd-theme-changed", function () {
    window.richmdRerenderDiagrams();
  });
</script>]]
end

-- anti_flash_theme_script_html() -> string
--
-- A tiny inline <script>, emitted as the FIRST child of .richmd-doc (ahead
-- of the topbar and the container), so it runs before the browser paints
-- any of the doc's actual content. It reads a previously-persisted user
-- choice back out of localStorage and — if one exists — applies it to
-- .richmd-doc's data-richmd-theme attribute immediately, synchronously,
-- before first paint. Without this, a returning reader with a stored "dark"
-- preference would see a flash of the light theme (CSS's
-- prefers-color-scheme default) before the toggle script further down the
-- page ever got a chance to run. No dependency on DOMContentLoaded here on
-- purpose: .richmd-doc already exists in the parse tree by the time this
-- inline script tag itself runs (it's the previous sibling), so this can
-- run synchronously as the parser reaches it — that's what "before first
-- paint" requires.
local function anti_flash_theme_script_html()
  return [[<script>
  (function () {
    try {
      var stored = localStorage.getItem("richmd-theme");
      if (stored === "light" || stored === "dark") {
        document.currentScript.parentElement.setAttribute("data-richmd-theme", stored);
      }
    } catch (e) {}
  })();
</script>]]
end

-- theme_toggle_script_html() -> string
--
-- The toggle button's click-handling script (design.md §07's existing
-- "inject... into every rendered page" responsibility, extended to a small
-- inline behavior alongside the stylesheet — no CDN, no framework, matching
-- the plain-inline-<script> pattern filter/blocks/mermaid.lua already uses
-- for its own runtime). Reads/writes the SAME "richmd-theme" localStorage
-- key the anti-flash script above reads, toggles data-richmd-theme on the
-- nearest .richmd-doc ancestor, and updates the button's icon+label to
-- reflect the theme now active. Deferred to DOMContentLoaded (unlike the
-- anti-flash script) since it only needs to attach a click listener, not
-- race first paint.
local function theme_toggle_script_html()
  return [[<script>
  (function () {
    // Reflects the theme CURRENTLY ACTIVE, not the theme a click would
    // switch to: sun icon + "Light" label when light is active, moon icon +
    // "Dark" label when dark is active (acceptance criteria's exact
    // contract) — never the inverse "what you'd switch to" convention some
    // toggle designs use instead.
    function applyToggleLabel(button, activeTheme) {
      var icon = button.querySelector(".richmd-theme-toggle-icon");
      var label = button.querySelector(".richmd-theme-toggle-label");
      if (activeTheme === "dark") {
        if (icon) icon.textContent = "☽";
        if (label) label.textContent = "Dark";
      } else {
        if (icon) icon.textContent = "☀";
        if (label) label.textContent = "Light";
      }
    }

    function currentTheme(docEl) {
      var attr = docEl.getAttribute("data-richmd-theme");
      if (attr === "light" || attr === "dark") {
        return attr;
      }
      var prefersDark =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      return prefersDark ? "dark" : "light";
    }

    function init() {
      var docEl = document.querySelector(".richmd-doc");
      var button = document.querySelector(".richmd-theme-toggle");
      if (!docEl || !button) return;

      applyToggleLabel(button, currentTheme(docEl));

      button.addEventListener("click", function () {
        var next = currentTheme(docEl) === "dark" ? "light" : "dark";
        docEl.setAttribute("data-richmd-theme", next);
        try {
          localStorage.setItem("richmd-theme", next);
        } catch (e) {}
        applyToggleLabel(button, next);
        document.dispatchEvent(new CustomEvent("richmd-theme-changed"));
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();
</script>]]
end

-- theme_toggle_button_html() -> string
--
-- The toggle button's markup: theme/default.css's .richmd-theme-toggle rule
-- (§12 THEME TOGGLE) expects an inline-flex button containing a small icon
-- element followed by label text — this emits exactly that shape (an icon
-- span, then a label span), with no inline style/color of its own (§00
-- principle P3: style is swappable, never hardcoded — every visual property
-- comes from the .richmd-theme-toggle CSS rule this button's class
-- selects). Initial icon/label reflects the light default; the toggle
-- script corrects it immediately on load to match whatever theme (OS
-- preference or stored choice) is actually active, so there's no
-- user-visible mismatch even before JS runs (the button text is not part of
-- the anti-flash concern — only page background/text colors are, and those
-- are handled by the anti-flash script above and by CSS itself).
local function theme_toggle_button_html()
  return '<button type="button" class="richmd-theme-toggle" aria-label="Toggle color theme">'
    .. '<span class="richmd-theme-toggle-icon">\xE2\x98\x80</span>'
    .. '<span class="richmd-theme-toggle-label">Light</span>'
    .. "</button>"
end

-- topbar_html() -> string
--
-- The `.richmd-topbar` chrome (theme/default.css §12): brand text on the
-- left, the theme toggle button on the right. Plain RawBlock HTML, exactly
-- like every other kind's render_fn already emits (e.g.
-- filter/blocks/mermaid.lua's panel_html) — no new templating mechanism
-- introduced here.
local function topbar_html()
  return '<div class="richmd-topbar">'
    .. '<div class="richmd-brand">richmd</div>'
    .. theme_toggle_button_html()
    .. "</div>"
end

-- container_classes(doc_meta) -> { "richmd-container" } | { "richmd-container", "richmd-container--wide" }
--
-- Reads the document's OWN YAML frontmatter for a `richmd-layout` key
-- (design.md §07: "Container width is a per-document choice, authored as a
-- YAML frontmatter key... defaulting to `wide` when absent"). This is
-- document-level metadata, not a block-kind concept — read once per
-- document, here in the filter core, never through the
-- registry/schema-driven validate_attrs mechanism the block kinds use (§00
-- invariant: the filter core stays generic about block kinds, but frontmatter
-- is not a block kind at all, so that invariant does not apply to it).
--
-- Pandoc exposes YAML frontmatter via `doc.meta`, keyed by the frontmatter
-- field name; a present scalar key comes back as a MetaValue (a Lua table
-- wrapping the string), not a plain Lua string, so `pandoc.utils.stringify`
-- is the documented way to read it as text — confirmed with a real
-- `pandoc --lua-filter` run against both a `richmd-layout: narrow` document
-- (stringify returns "narrow") and a document with no frontmatter at all
-- (`doc.meta["richmd-layout"]` is plain Lua `nil`, never a table). Only the
-- literal value "narrow" opts out of wide — absent, "wide", or any other
-- value all fall through to the new wide default.
local function container_classes(doc_meta)
  local raw = doc_meta and doc_meta["richmd-layout"]
  local layout = raw ~= nil and pandoc.utils.stringify(raw) or nil
  if layout == "narrow" then
    return { "richmd-container" }
  end
  return { "richmd-container", "richmd-container--wide" }
end

-- wrap_blocks_in_page_shell(blocks, doc_meta) -> pandoc.List(Block)
--
-- Wraps the whole rendered document in the .richmd-doc / .richmd-container
-- shell theme/default.css already fully styles (§00: this is additive
-- structure only, never a new renderer/kind — every existing block-kind's
-- own output, already independently correct, is carried through completely
-- unchanged as the content of `.richmd-container`). The container's own
-- classes are derived from the document's `richmd-layout` frontmatter (see
-- container_classes above) — wide (`richmd-container richmd-container--wide`)
-- unless the document explicitly opts into the narrower `richmd-layout:
-- narrow` reading column (plain `richmd-container`, 760px, theme/default.css
-- §2).
--
-- Pandoc's Lua filter API has no hook that wraps the HTML writer's <body>
-- tag itself (the writer owns the <body>...</body> shell via its built-in
-- template; header-includes only reaches <head>). The documented way to
-- wrap the whole rendered page's content is the one used here: return a
-- modified top-level Blocks list from Pandoc(doc) with a single outer
-- pandoc.Div wrapping everything — the HTML writer renders a Div as a
-- <div>, so one Div with class "richmd-doc" containing the anti-flash
-- script + topbar + a nested Div with class "richmd-container" (holding the
-- ORIGINAL blocks, unmodified) produces exactly
-- <body><div class="richmd-doc">...<div class="richmd-container">...
-- ...</div></div></body> — this is real AST-level structure, not
-- string post-processing of Pandoc's own output (which would be fragile and
-- inconsistent with richmd's AST-based architecture everywhere else).
--
-- No data-richmd-theme attribute is set on .richmd-doc here: the CSS's
-- prefers-color-scheme media query is the correct default (theme/default.css
-- §1b) for a page nobody has interacted with yet, and forcing a literal
-- "light" or "dark" value here would override that OS-driven default for
-- every reader on first visit, which is not richmd's call to make. Once a
-- reader clicks the toggle, the toggle script (theme_toggle_script_html)
-- sets the attribute directly on the live DOM node and persists the choice;
-- the anti-flash script re-applies a stored choice, if any, on the next
-- load — but a first-ever render never carries a hardcoded value.
local function wrap_blocks_in_page_shell(blocks, doc_meta)
  -- Pandoc's HTML writer (Text.Pandoc.Shared.makeSections, run unconditionally
  -- inside every writer, independent of --section-divs) auto-converts ANY Div
  -- whose FIRST child block is a Header into an HTML <section> tag, merging
  -- the Div's classes onto that section and MOVING the header's own `id`
  -- attribute off the <h*> tag and onto the <section> instead. Almost every
  -- richmd document starts with a top-level heading, so `.richmd-container`
  -- (wrapping `blocks` directly) is exactly the shape this transform matches
  -- — left alone, it would silently rewrite `.richmd-container` into
  -- `<section class="richmd-container">` AND strip the `id` off the
  -- document's first heading, breaking any `#fragment` cross-document link
  -- resolved against that heading's slug (render_only_header/
  -- render_only_link above — a real regression, not cosmetic). A leading
  -- zero-content RawBlock defeats the pattern match (it requires the Div's
  -- first list element to literally be a Header) without affecting Pandoc's
  -- normal section/heading handling anywhere else in the document, and
  -- renders as an empty line with no visible or structural effect.
  local container_children = pandoc.List(blocks)
  container_children:insert(1, pandoc.RawBlock("html", ""))

  local shell_children = pandoc.List({
    pandoc.RawBlock("html", anti_flash_theme_script_html()),
    -- diagram_theme_script_html() MUST run before `.richmd-container`'s own
    -- content: every mermaid/vega-lite diagram inside the container calls
    -- `window.richmdDiagramTheme()` synchronously, at parse time, as soon as
    -- its own inline <script> tag runs (never deferred to
    -- DOMContentLoaded) — so if this script were emitted after the
    -- container (as it was before this fix), `window.richmdDiagramTheme`
    -- would still be undefined during every diagram's first render,
    -- silently falling back to `{}` and handing mermaid/vega-lite a
    -- themeVariables/config object full of `undefined` values (mermaid's
    -- own internal color-math then throws on `undefined`, confirmed via a
    -- real headless-browser reproduction). `window.richmdRerenderDiagrams`
    -- doesn't have this ordering constraint (the toggle only calls it long
    -- after DOMContentLoaded), but defining both in one place, this early,
    -- is simplest and keeps the "one shared script" contract intact.
    pandoc.RawBlock("html", diagram_theme_script_html()),
    pandoc.RawBlock("html", topbar_html()),
    pandoc.Div(container_children, pandoc.Attr("", container_classes(doc_meta))),
    pandoc.RawBlock("html", theme_toggle_script_html()),
  })
  return pandoc.List({
    pandoc.Div(shell_children, pandoc.Attr("", { "richmd-doc" })),
  })
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
-- Assigns the Header's `id` attribute via the single shared
-- heading_anchor_id function (above) — the SAME function
-- target_anchor_ids uses during validate to resolve `#fragment` targets, so
-- headings and links can never disagree. A pre-existing non-empty
-- `header.identifier` (Pandoc's own parse of `### Heading {#explicit-id}`
-- syntax) is preserved rather than discarded — heading_anchor_id itself
-- makes that choice, once, so this call site never re-implements the
-- explicit-id-else-slug branching.
--
-- A Header carrying HeadingScope's internal-heading marker (applied by the
-- mark_internal_headers pre-pass below, BEFORE this walk runs, to any
-- `owns_internal_headers` kind's own body headers — currently only
-- cards.lua's per-card `### heading` titles) is left completely untouched:
-- no `id` assigned, and — just as importantly — no mutation of the shared
-- `seen_slugs` table, which is what previously let a card's own title
-- silently consume the clean slug a real, same-named heading elsewhere in
-- the document needed (see filter/heading-scope.lua for the full
-- investigation of why this couldn't be fixed from inside cards.lua's own
-- render_fn alone).
local function render_only_header(header)
  if HeadingScope.is_internal(header) then
    return nil
  end
  header.identifier = heading_anchor_id(header, seen_slugs)
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
--
-- Also classifies the link as "in-tree" (design.md §06, ADR-0005,
-- CONTEXT.md#term-in-tree-link) when `--tree` was passed: the ORIGINAL
-- `.md` path_part (fragment already stripped by split_target above) is
-- resolved the SAME way validate_only_link resolves it —
-- `doc_dir .. "/" .. path_part` — and checked against tree_paths. A match
-- appends (never overwrites — Attr.classes is a list, and richmd-authored
-- markdown links never carry any class of their own, but this is written
-- defensively in case Pandoc ever attaches one) "richmd-intree-link" to the
-- Link's existing Attr classes. When tree_paths is empty (RICHMD_TREE
-- unset, i.e. `--tree` absent from argv), this membership check always
-- misses, so the Link's Attr is never touched at all and output is
-- byte-identical to before this feature existed.
local function render_only_link(link)
  local path_part, fragment_part = split_target(link.target)
  if not is_relative_md_link(path_part) then
    return nil -- not a cross-document link; leave untouched
  end

  local resolved_path = doc_dir .. "/" .. path_part
  if tree_paths[resolved_path] then
    link.classes:insert("richmd-intree-link")
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
  -- --- Pre-pass: internal-heading scoping ---
  --
  -- Runs before validate and before render, over the WHOLE document: tags
  -- every Header that is a direct child of an `owns_internal_headers`
  -- kind's body content (currently only cards.lua's per-card `### heading`
  -- titles) with HeadingScope's marker class, so neither the validate
  -- phase's link-fragment check (target_heading_slugs, used when THIS
  -- document is itself the target of another document's `#fragment` link)
  -- nor the render phase's render_only_header ever mistakes it for a real,
  -- addressable section heading. See filter/heading-scope.lua for why this
  -- is a separate pre-pass rather than a change to the render walk's
  -- traversal order (which filter/blocks/stat-grid.lua depends on staying
  -- bottom-up).
  doc = HeadingScope.mark(doc, registry)

  -- --- Validate phase ---
  doc = doc:walk({
    Div = validate_only_div,
    Link = validate_only_link,
    CodeBlock = validate_only_codeblock,
  })

  -- Token resolution (design.md §06, ADR-0011): a document-wide check that
  -- runs AFTER every per-block schema check above (so an opted-in attr's
  -- block already passed its own schema) and BEFORE the cross-block rules
  -- below, which consume its resolved tokens
  -- (CONTEXT.md#term-token-resolution-pass). Contributes to the SAME
  -- `errors` table via the SAME add_error closure. Its resolved tokens are
  -- not consumed yet — §06 hands them to the block projection builder in a
  -- later change.
  resolve_tokens(doc)

  -- Cross-block rules (design.md §05, ADR-0008): a document-wide check that
  -- runs AFTER every per-block, link, and grammar check above has already
  -- collected its errors (CONTEXT.md#term-document-wide-check), regardless
  -- of whether that walk found any — contributing to the SAME `errors`
  -- table, before the fail-closed gate below decides whether to proceed.
  run_rules(doc)

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

  -- Wrap the whole rendered document in the .richmd-doc/.richmd-topbar/
  -- .richmd-container page shell (theme/default.css §2/§12) — every
  -- block-kind's own already-correct output is carried through unchanged as
  -- the shell's content; see wrap_blocks_in_page_shell's own comment for why
  -- this is the correct (AST-level, not string-postprocessing) way to reach
  -- what would otherwise require wrapping Pandoc's own <body> tag.
  doc.blocks = wrap_blocks_in_page_shell(doc.blocks, doc.meta)

  return doc
end
