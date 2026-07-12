-- richmd internal-heading scoping (design.md §00 invariant: slugs are a
-- pure, documented function of REAL headings).
--
-- WHY THIS FILE EXISTS: a `### heading` Header node can be authored inside
-- a block kind's own body content purely as that kind's internal
-- title-splitting syntax (cards.lua's one-`###`-per-card contract is the
-- only current example, but any future kind following the same pattern
-- gets this for free) — such a Header was never meant to be a real,
-- navigable section of the document. Left alone, Pandoc's Header AST node
-- type gives no structural way to tell "a real section heading" apart from
-- "a heading-shaped node that only ever meant to be a kind's own internal
-- syntax" — both are just `Header` nodes to any code walking the document.
--
-- ROOT-CAUSE INVESTIGATION (see the chunk report for full probe output):
-- Pandoc's `doc:walk({Div = ..., Header = ...})` visits a document
-- BOTTOM-UP by default — child nodes (including Header nodes nested inside
-- a Div's own `content`) are visited by the dispatch table's `Header` entry
-- BEFORE that Div's own `Div` entry ever runs. This means a block kind's
-- render_fn (e.g. cards.lua's, called via the Div dispatch) cannot prevent
-- richmd-filter.lua's shared `Header` handler from having ALREADY assigned
-- an `id` and mutated the shared `seen_slugs` duplicate-count table by the
-- time that render_fn gets a chance to discard the Header node from its own
-- output — the mutation already happened as a side effect of the walk
-- itself, independent of what the final rendered tree contains.
--
-- Pandoc's Lua filter API does offer a `traverse = "topdown"` walk option
-- (confirmed by direct probe) that would visit a Div's handler before
-- descending into its children, which WOULD let a kind pre-empt its own
-- internal headers this way. That option was rejected here: richmd's
-- render-phase walk is relied upon elsewhere to be bottom-up — see
-- filter/blocks/stat-grid.lua's own header comment, which documents (and
-- depends on, "proven by direct probe, not assumed") every nested
-- `.stat-tile` Div already being independently rendered by the time
-- stat-grid's own render_fn runs, which only holds under bottom-up
-- traversal. Flipping the shared walk to topdown would silently break
-- stat-grid.lua's nested-tile composition — an invasive, blast-radius-wide
-- change to fix a problem that is really scoped to one kind (cards.lua)
-- knowing which of ITS OWN headers are internal.
--
-- THE CHOSEN FIX INSTEAD: a separate, EARLIER pre-pass walk (its own
-- `doc:walk`, run once before the validate/render walk in
-- richmd-filter.lua, and independently again inside toc.lua's own
-- from-disk reparse) that only ever touches Div nodes, and only ever marks
-- — never removes or renders — a Header found as a DIRECT child of a Div
-- whose kind's schema opts in via `schema.owns_internal_headers = true`
-- (a generic, declarative schema field, checked the same way
-- `schema.validate`/`schema.body` already are elsewhere — never an
-- `if kind_name == "cards"` branch). The marker itself is an ordinary
-- class, `richmd-internal-heading`, added to the Header's own `.classes`
-- list — plain AST data that survives completely normally into the later
-- walk(s) (mutation-in-place on the same node reference, confirmed by
-- direct probe), and that both richmd-filter.lua's `render_only_header`
-- and toc.lua's `collect_headings` check for and skip, before either would
-- otherwise assign an id / add a TOC entry / touch `seen_slugs`.
--
-- A kind that opts in this way (cards.lua currently the only one) keeps
-- its EXISTING render_fn completely unchanged: it already extracts the
-- Header's text via `pandoc.utils.stringify` and re-emits a plain
-- non-Header `richmd-card-title` Div — this module's marking pass runs
-- BEFORE that render_fn ever sees the Div, purely to stop the Header from
-- ever being treated as a real heading upstream, in either of the two
-- places that independently walk Headers (richmd-filter.lua's render
-- phase, toc.lua's independent from-disk walk).

local HeadingScope = {}

-- INTERNAL_HEADING_CLASS: the marker class applied to a Header node that
-- is a direct child of an "owns_internal_headers" kind's body content.
-- Exported so a future block kind's own tests (or richmd-filter.lua/
-- toc.lua) can reference the exact same literal rather than restating it.
HeadingScope.INTERNAL_HEADING_CLASS = "richmd-internal-heading"

-- kind_owns_internal_headers(classes, registry) -> boolean
--
-- Mirrors richmd-filter.lua's own richmd_kind_of: the first class (of
-- possibly several) that matches a REGISTERED kind decides the block's
-- kind; this checks whether THAT kind's schema opted in. A Div with no
-- classes, or whose classes match no registered kind at all, never owns
-- internal headers (nothing here is cards-specific — any registered kind
-- can set `owns_internal_headers = true` on its own schema).
local function kind_owns_internal_headers(classes, registry)
  for _, class in ipairs(classes) do
    local schema = select(1, registry:lookup(class))
    if schema and schema.owns_internal_headers then
      return true
    end
  end
  return false
end

-- mark(doc, registry) -> doc
--
-- A single, self-contained pre-pass `doc:walk` over Div nodes only: for
-- every Div whose kind (via the shared registry, exactly like
-- richmd-filter.lua's own generic dispatch) declares
-- `schema.owns_internal_headers`, every Header found as a DIRECT child of
-- that Div's `.content` (not full recursion — matches cards.lua's own
-- split_cards, which only ever scans its own immediate body content, never
-- headers nested arbitrarily deep inside some other block) is tagged with
-- INTERNAL_HEADING_CLASS. Purely additive (a class appended to the
-- Header's existing `.classes` list) and side-effect-free with respect to
-- rendering — this pass never removes or transforms anything, so it is
-- always safe to run before validate, before render, or (independently)
-- against a freshly-parsed copy of the same document read from disk
-- (toc.lua's own use, since it cannot share AST node identity with
-- richmd-filter.lua's separately-parsed `doc`).
function HeadingScope.mark(doc, registry)
  return (doc:walk({
    Div = function(div)
      if #div.classes == 0 then
        return nil
      end
      if not kind_owns_internal_headers(div.classes, registry) then
        return nil
      end
      for _, blk in ipairs(div.content) do
        if blk.t == "Header" then
          blk.classes:insert(HeadingScope.INTERNAL_HEADING_CLASS)
        end
      end
      return div
    end,
  }))
end

-- is_internal(header) -> boolean
--
-- Checked by both richmd-filter.lua's render_only_header (to skip id
-- assignment / seen_slugs mutation) and toc.lua's collect_headings (to
-- skip the TOC entry) — the one place this literal class name is
-- interpreted, so the two call sites can never drift out of sync on what
-- "internal" means.
function HeadingScope.is_internal(header)
  for _, class in ipairs(header.classes) do
    if class == HeadingScope.INTERNAL_HEADING_CLASS then
      return true
    end
  end
  return false
end

return HeadingScope
