-- richmd heading slugifier (design.md §06, §00 invariant "slugs are a pure,
-- documented function").
--
-- ONE function, GitHub-flavored rules (CONTEXT.md#term-slug): lowercase the
-- text, strip punctuation except hyphens/underscores, collapse whitespace
-- runs to a single hyphen, and — within one document — suffix the 2nd, 3rd,
-- ... occurrence of an identical slug with -1, -2, etc.
--
-- This module is called from BOTH the render phase (assigning `id`s to
-- Header AST nodes) and #fragment link resolution during validate/render —
-- same function, one source of truth, so headings and links can never
-- disagree.

local Slugify = {}

-- base_slug(text) -> string
--
-- The pure, text-only half of the rule (no duplicate tracking): lowercase,
-- strip punctuation except hyphens/underscores, collapse whitespace to
-- single hyphens, trim leading/trailing hyphens.
local function base_slug(text)
  local s = text:lower()
  -- Strip anything that is not a letter, digit, space, hyphen, or
  -- underscore (GitHub-flavored: punctuation stripped except hyphens).
  s = s:gsub("[^%w%s%-_]", "")
  -- Collapse any run of whitespace into a single hyphen.
  s = s:gsub("%s+", "-")
  -- Trim leading/trailing hyphens left over from stripped punctuation at
  -- the edges of the text.
  s = s:gsub("^%-+", ""):gsub("%-+$", "")
  return s
end

Slugify.base_slug = base_slug

-- new_seen() -> seen_slugs_table
--
-- The table shape threaded through one document run: maps a base slug to
-- the count of times it has been assigned so far (0 = not yet seen).
function Slugify.new_seen()
  return {}
end

-- slugify(heading_text, seen_slugs_table) -> slug_string
--
-- seen_slugs_table is mutated in place: the first occurrence of a given
-- base slug gets no suffix, the second gets -1, the third -2, etc.
-- (CONTEXT.md#term-slug duplicate-heading rule.)
function Slugify.slugify(heading_text, seen_slugs_table)
  local slug = base_slug(heading_text or "")
  local count = seen_slugs_table[slug] or 0

  local result
  if count == 0 then
    result = slug
  else
    result = slug .. "-" .. tostring(count)
  end

  seen_slugs_table[slug] = count + 1
  return result
end

return Slugify
