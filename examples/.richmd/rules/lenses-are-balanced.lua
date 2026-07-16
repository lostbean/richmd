-- Consumer-defined cross-block rule: lenses-are-balanced.
--
-- Demonstrates what a token vocabulary is FOR (design.md §06, ADR-0011):
-- this rule reads each `lens:` reference the document cites as a structured
-- token — its member and that member's properties — instead of regexing over
-- a block's flattened `body_text` and hardcoding the member set here, which
-- is what a consumer had to do before .richmd/tokens/ existed.
--
-- richmd already resolved every reference against the closed set declared in
-- this document's own .richmd/tokens/lens.json before this rule ran, so a
-- misspelled lens never reaches this code — it failed the document. That is
-- why the loop below reads `properties` DIRECTLY and never re-checks
-- membership (design.md §05: "a rule reads a token's properties directly,
-- never re-checking membership nor scanning body_text for a reference").
--
-- The check itself: a document that tags ANY of its blocks with a lens
-- should exercise at least one behavioral lens, not only structural ones.
-- `rigor` is not a richmd concept — it is a property THIS consumer put on
-- its own members, which richmd carried through without ever reading.
-- Interpreting it is the consumer's job, and this rule is that job.
--
-- A rules directory belongs to a CONFIG DIRECTORY, not to one document
-- (CONTEXT.md#term-rules-directory), so every rule here runs against every
-- example sharing examples/.richmd/ — including ones that cite no lens at
-- all. Hence the opt-in below: a document that cites no lens is simply not
-- making a claim this rule can judge, and is left alone. A rule that fired
-- on every document in its config directory would be a rule nobody could
-- afford to add.

return {
  check = function(block_projections, add_error)
    local structural_cited = 0
    local behavioral_cited = 0
    local last_lens_location = nil

    for _, projection in ipairs(block_projections) do
      for _, token in ipairs(projection.tokens) do
        if token.vocabulary == "lens" then
          last_lens_location = projection.location
          if token.properties.rigor == "behavioral" then
            behavioral_cited = behavioral_cited + 1
          else
            structural_cited = structural_cited + 1
          end
        end
      end
    end

    -- Opt-in: no lens cited in any block means this document does not use
    -- the vocabulary, so there is nothing here to judge.
    if structural_cited + behavioral_cited == 0 then
      return
    end

    if behavioral_cited == 0 then
      add_error(
        "rule:lenses-are-balanced",
        last_lens_location,
        "this document tags blocks with structural lenses only — a design that never names how it behaves under change (state, invariants, robustness) is usually missing a section"
      )
    end
  end,
}
