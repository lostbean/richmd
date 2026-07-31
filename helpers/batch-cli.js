// Shared batch stdin/stdout protocol for the grammar validators
// (design.md §07, ADR-0018).
//
// Both grammar-check helpers — mermaid-check.js and vega-lite-check.js —
// are invoked as ONE subprocess per document per kind, and both speak the
// identical wire protocol. That protocol lives here, in one place, rather
// than being copy-pasted into each helper's own CLI entry point: the two
// helpers differ only in WHICH check function they run per block, never in
// how a batch is read, paired, or reported, and a silent divergence between
// the two (say, one of them pairing verdicts by array position) would be a
// real defect the Lua caller could not detect.
//
// Wire protocol
// -------------
// stdin (exactly one JSON document):
//   {"blocks": [{"id": "<opaque string>", "source": "<block source text>"}, ...]}
//
// stdout (exactly one JSON document):
//   {"results": [{"id": "<the same id>", "valid": true}, ...]}
//   with a rejection carrying the parser's own reason instead:
//   {"id": "<the same id>", "valid": false, "reason": "<parser's reason>"}
//
// Every id sent comes back exactly once, so the caller pairs verdicts BY ID
// and never by array position — that pairing is what lets a grammar
// rejection still name the specific block it came from, which is the whole
// reason ids are on the wire at all.
//
// Exit codes (three outcomes, unchanged in meaning from the pre-batch
// per-block contract):
//   0 — every block in the set is valid
//   1 — at least one block was rejected on grammar
//   2 — the helper itself failed (crash, malformed input, IO error)
//
// Outcome 2 is deliberately distinct from outcome 1: per design.md §07's
// failure behavior, "a validator subprocess crashing unexpectedly is itself
// a hard filter failure, distinct from a normal grammar rejection". Nothing
// in this module may ever collapse a helper failure into a per-block
// rejection verdict, because the caller cannot tell the two apart once they
// share a shape.

export const EXIT_ALL_VALID = 0;
export const EXIT_GRAMMAR_REJECTION = 1;
export const EXIT_HELPER_FAILURE = 2;

// readStdin() -> Promise<string>
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// parseBatch(text) -> { blocks } | throws Error
//
// Parse-at-the-boundary: stdin is untrusted input, so the batch document's
// shape is checked here, once, before any block reaches a check function.
// Anything that isn't a well-formed batch throws, and the caller turns that
// into exit 2 (a helper failure) — never into a grammar rejection, which
// would wrongly blame the author's diagram for the caller's malformed pipe.
function parseBatch(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin is not a valid JSON batch document: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin batch document must be a JSON object");
  }
  if (!Array.isArray(parsed.blocks)) {
    throw new Error("stdin batch document must carry a 'blocks' array");
  }

  const seen = new Set();
  for (const block of parsed.blocks) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      throw new Error("each entry of 'blocks' must be a JSON object");
    }
    if (typeof block.id !== "string" || block.id === "") {
      throw new Error("each block must carry a non-empty string 'id'");
    }
    if (typeof block.source !== "string") {
      throw new Error(`block '${block.id}' must carry a string 'source'`);
    }
    // A duplicate id would make the returned verdicts unpairable by the
    // caller (two verdicts claiming the same block), so reject the batch
    // outright rather than emitting an ambiguous result set.
    if (seen.has(block.id)) {
      throw new Error(`duplicate block id '${block.id}' in batch`);
    }
    seen.add(block.id);
  }

  return { blocks: parsed.blocks };
}

// runBatchCli(checkFn, helperName) -> Promise<exit_code>
//
// The whole CLI entry point for a grammar-check helper: read one batch off
// stdin, run `checkFn(source)` once per block IN THE SAME PROCESS — which is
// exactly what makes each helper's module-level setup cache (mermaid's
// linkedom DOM, vega-lite's compiled ajv schema validator) pay once per
// document instead of once per block (ADR-0018) — and write one verdict per
// id back out.
//
// Blocks are checked sequentially rather than concurrently: both check
// functions share one lazily-initialized module-level cache, and running
// the first calls in parallel would race several concurrent initializations
// of that cache against each other for no gain (the work is CPU-bound in
// one process either way).
//
// A rejection of one block never suppresses the checking or reporting of
// another (design.md §00: all validation errors are collected) — the loop
// always runs to completion and every block gets a verdict.
export async function runBatchCli(checkFn, helperName) {
  let text;
  try {
    text = await readStdin();
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        error: `${helperName}: failed to read stdin: ${err.message || String(err)}`,
      }) + "\n",
    );
    return EXIT_HELPER_FAILURE;
  }

  let batch;
  try {
    batch = parseBatch(text);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: `${helperName}: ${err.message}` }) + "\n",
    );
    return EXIT_HELPER_FAILURE;
  }

  const results = [];
  for (const block of batch.blocks) {
    let verdict;
    try {
      verdict = await checkFn(block.source);
    } catch (err) {
      // The helper itself crashed on this block (not a grammar rejection —
      // a check function reports THAT by returning {valid:false}). Abort
      // the whole batch with the helper-failure exit code rather than
      // recording a rejection verdict, so the caller keeps the two
      // outcomes distinguishable (design.md §07 failure behavior).
      process.stdout.write(
        JSON.stringify({
          error: `${helperName} crashed on block '${block.id}': ${err.message || String(err)}`,
        }) + "\n",
      );
      return EXIT_HELPER_FAILURE;
    }
    results.push(
      verdict.valid
        ? { id: block.id, valid: true }
        : { id: block.id, valid: false, reason: verdict.reason },
    );
  }

  process.stdout.write(JSON.stringify({ results }) + "\n");
  return results.every((verdict) => verdict.valid)
    ? EXIT_ALL_VALID
    : EXIT_GRAMMAR_REJECTION;
}
