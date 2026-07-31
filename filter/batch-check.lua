-- Shared batch invocation of a Node grammar-validator helper
-- (design.md §07, ADR-0018).
--
-- The two block kinds with no native Lua grammar — mermaid and vega-lite —
-- each shell out to their own small Node helper script. What they share is
-- exactly this: how a whole document's worth of blocks is handed to a helper
-- over stdin, how the helper's verdicts come back, and how a helper that
-- fails to run at all is told apart from one that rejected a diagram. That
-- shared "how" lives here, once, so filter/blocks/mermaid.lua and
-- filter/blocks/vega-lite.lua can never drift into two subtly different
-- copies of a protocol whose other half (helpers/batch-cli.js) has only one.
--
-- ONE subprocess per document per kind, not one per block: each helper pays
-- expensive per-process setup (mermaid's linkedom DOM, vega-lite's compiled
-- ajv schema validator) that its own module-level cache is written to reuse,
-- and a one-block process discards that setup immediately (ADR-0018).
--
-- The helper is reached as a bare `node` resolved through PATH (ADR-0001) —
-- never an absolute interpreter path, never a persistent process or daemon.

local BatchCheck = {}

-- ENTRY QUEUE SHAPE
--
-- Each queue entry is `{ id = <string>, source = <string>, report = <fn> }`.
-- `report(reason)` is called with the parser's own rejection reason, and
-- with nothing else — it is the enqueuing kind's own closure over whatever
-- (kind_name, location, add_error) triple that block was collected under, so
-- this module never needs to know how an error is worded or sourced. That is
-- what lets a chart block's expanded spec ride in the SAME vega-lite batch
-- as a hand-authored ```vega-lite block while still reporting under its own
-- kind and location.

-- run(helper_path, helper_name, entries)
--
-- Invokes the helper once with every queued entry, then reports each
-- rejection through that entry's own `report` closure. Returns nothing:
-- every outcome is delivered as a reported error or as silence (valid).
--
-- Three outcomes, matching the helper's own three exit codes exactly
-- (helpers/batch-cli.js):
--
--   valid            — nothing is reported for that block.
--   grammar reject   — that block's `report` is called with the parser's own
--                      reason, verbatim, never a generic "invalid" message.
--   helper failure   — the helper crashed, never ran, or returned something
--                      unparseable. Per design.md §07 this is a HARD FILTER
--                      FAILURE, distinct from a grammar rejection, so it is
--                      reported against EVERY block in the batch (naming the
--                      helper and the raw problem) rather than silently
--                      passing the set through. Failing closed is the point:
--                      a validator that could not run must never read as
--                      "everything checked out".
function BatchCheck.run(helper_path, helper_name, entries)
  if #entries == 0 then
    -- No block of this kind in this document: never spawn the helper at
    -- all. Skipping the subprocess is not just an optimization — it is what
    -- keeps a document with no diagrams free of the helper's setup cost
    -- entirely (design.md §07).
    return
  end

  -- flatten(text) -> string
  --
  -- A parser's own rejection reason is frequently multi-line (mermaid's
  -- "Parse error on line 2: ... ^ Expecting ..." is three lines with a caret
  -- ruler), and a crashed helper's raw output is a whole stack trace. The
  -- filter core prints one collected error per stderr line, so a raw newline
  -- inside a reason would split one error across several lines and misalign
  -- the "richmd: [kind] location:" prefix that identifies it. Collapsing to
  -- spaces keeps the parser's own wording verbatim while keeping one error
  -- to one line — the same normalization the pre-batch per-block path
  -- performed when it unescaped the helper's `\n` sequences.
  local function flatten(text)
    return (tostring(text):gsub("[\r\n]+", " "))
  end

  -- Fail every block in the batch with one message. Used for every
  -- helper-failure path below, so a crashed helper always reads the same
  -- way regardless of HOW it failed, and no block is ever left unreported.
  local function fail_whole_batch(problem)
    for _, entry in ipairs(entries) do
      entry.report(flatten(problem))
    end
  end

  local blocks = {}
  for _, entry in ipairs(entries) do
    table.insert(blocks, { id = entry.id, source = entry.source })
  end

  -- Write the batch document to a temp file rather than piping it through
  -- the shell, to avoid any quoting/escaping hazards with arbitrary block
  -- source text (backticks, quotes, newlines) — the same reason the
  -- pre-batch per-block invocation used a temp file.
  local tmp_path = os.tmpname()
  local tmp_file = io.open(tmp_path, "w")
  if not tmp_file then
    fail_whole_batch("could not create temp file to invoke " .. helper_name .. " helper")
    return
  end
  tmp_file:write(pandoc.json.encode({ blocks = blocks }))
  tmp_file:close()

  local handle = io.popen("node " .. helper_path .. " < " .. tmp_path .. " 2>&1")
  local output = ""
  if handle then
    output = handle:read("*a") or ""
    handle:close()
  end
  os.remove(tmp_path)

  if not handle then
    fail_whole_batch("could not invoke " .. helper_name .. " helper (node not found?)")
    return
  end

  -- Parse at the boundary: the helper's stdout is untrusted here in exactly
  -- the sense that a crashed helper can put anything on it (stderr is folded
  -- in via 2>&1, so a stack trace lands here too). Anything that is not a
  -- well-formed verdict set is a helper failure, never a rejection.
  local decoded = pandoc.json.decode(output, false)
  if type(decoded) ~= "table" or type(decoded.results) ~= "table" then
    if output == "" then
      fail_whole_batch(helper_name .. " helper produced no output")
    else
      fail_whole_batch(helper_name .. " helper produced unexpected output: " .. output)
    end
    return
  end

  -- Pair verdicts BY ID, never by array position — the id is the only thing
  -- tying a verdict back to the block it came from, and position would
  -- silently misattribute a rejection to the wrong diagram the moment the
  -- helper reordered anything.
  local verdict_by_id = {}
  for _, verdict in ipairs(decoded.results) do
    if type(verdict) == "table" and type(verdict.id) == "string" then
      verdict_by_id[verdict.id] = verdict
    end
  end

  for _, entry in ipairs(entries) do
    local verdict = verdict_by_id[entry.id]
    if not verdict then
      -- A block sent but not answered for. The helper's contract is that
      -- every id comes back exactly once, so this is a helper failure for
      -- that block — reported rather than treated as "valid", so a helper
      -- that silently drops blocks can never widen what passes the gate.
      entry.report(helper_name .. " helper returned no verdict for this block")
    elseif not verdict.valid then
      entry.report(flatten(verdict.reason or "unknown error"))
    end
  end
end

return BatchCheck
