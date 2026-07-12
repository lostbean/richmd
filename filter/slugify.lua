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

-- Non-ASCII punctuation GitHub strips from slugs the same as ASCII
-- punctuation (en/em dash, curly quotes, ellipsis, etc.) — codepoint set,
-- not a byte range, so multi-byte UTF-8 sequences are matched whole.
local NON_ASCII_PUNCTUATION = {
  [0x2010] = true, -- ‐ hyphen
  [0x2011] = true, -- ‑ non-breaking hyphen
  [0x2012] = true, -- ‒ figure dash
  [0x2013] = true, -- – en dash
  [0x2014] = true, -- — em dash
  [0x2015] = true, -- ― horizontal bar
  [0x2018] = true, -- ' left single quote
  [0x2019] = true, -- ' right single quote
  [0x201C] = true, -- " left double quote
  [0x201D] = true, -- " right double quote
  [0x2026] = true, -- … ellipsis
}

-- base_slug(text) -> string
--
-- The pure, text-only half of the rule (no duplicate tracking): lowercase,
-- strip punctuation except hyphens/underscores, collapse whitespace to
-- single hyphens, trim leading/trailing hyphens.
local function base_slug(text)
  -- Lowercase ASCII A-Z bytes only, by explicit byte range. Lua's built-in
  -- string:lower() (and the locale-dependent %u/%l classes) is a C-locale
  -- byte-wise fold that also rewrites bytes >= 0x80 (e.g. 0xC3, a common
  -- UTF-8 lead byte, folds to 0xE3), corrupting multi-byte sequences before
  -- they are ever walked as codepoints.
  local s = text:gsub("[\65-\90]", function(c)
    return string.char(c:byte() + 32)
  end)
  -- Strip anything that is not a letter, digit, space, hyphen, or
  -- underscore (GitHub-flavored: punctuation stripped except hyphens).
  -- Must walk UTF-8 codepoints, not bytes: a byte-wise gsub splits a
  -- multi-byte punctuation character (e.g. em-dash, U+2014) mid-sequence,
  -- leaving a truncated byte string that browsers render as U+FFFD.
  local kept = {}
  for _, cp in utf8.codes(s) do
    if cp < 128 then
      local ch = string.char(cp)
      if ch:match("[%w%s%-_]") then
        kept[#kept + 1] = ch
      end
    elseif not NON_ASCII_PUNCTUATION[cp] then
      -- Other non-ASCII codepoints are treated as letters (GitHub-flavored
      -- slugs keep e.g. accented letters), so keep the whole codepoint.
      kept[#kept + 1] = utf8.char(cp)
    end
  end
  s = table.concat(kept)
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
