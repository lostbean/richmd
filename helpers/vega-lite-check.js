#!/usr/bin/env node
// vega-lite grammar validator (design.md §05).
//
// A small, tightly-scoped Node.js helper the Lua filter shells out to for
// vega-lite — the other block kind with no native Lua grammar, alongside
// mermaid. Unlike mermaid, vega-lite validation is JSON-schema based, not a
// custom grammar parser: a vega-lite spec is just JSON, checked against the
// published vega-lite JSON schema. No DOM, no browser, no Puppeteer — this
// is simpler than mermaid's DOMPurify situation, since JSON-schema
// validation is inherently DOM-free.
//
// Schema source: rather than depending on the full `vega-lite` npm package
// (which pulls in the whole vega/d3 rendering stack — ~76 transitive
// packages, ~24MB — purely to reach one bundled asset file), this helper
// vendors that one file directly: helpers/vega-lite-schema.json is a
// verbatim copy of vega-lite@6.4.3's own
// `build/vega-lite-schema.json` (the same file the `vega-lite` package
// itself exports via its `"./vega-lite-schema.json"` package.json subpath
// export) — a static JSON Schema draft-07 document, not executable code.
// Validated with `ajv`, a small, widely-used, DOM-free JSON-schema
// validator (confirmed via `npm ls --all`: no puppeteer/chromium/jsdom/
// browser dependency anywhere in ajv's own dependency tree — just
// fast-deep-equal, fast-uri, json-schema-traverse, require-from-string).
//
// Usage as a CLI (stdin -> JSON on stdout, distinct exit code):
//   node helpers/vega-lite-check.js < spec.vl.json
//   echo '{"mark":"bar", ...}' | node helpers/vega-lite-check.js
//
// Exit code 0: valid vega-lite spec, stdout is {"valid":true}
// Exit code 1: invalid (malformed JSON or schema-invalid), stdout is
//   {"valid":false,"reason":"..."}
// Exit code 2: usage/IO error (e.g. helper itself crashed unexpectedly) —
//   distinct from a normal grammar rejection, per design.md §05 failure
//   behavior ("a validator subprocess crashing unexpectedly is itself a
//   hard filter failure, distinct from a normal grammar rejection").

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "vega-lite-schema.json");

// Lazy, once-per-process compile: the cost is paying for ajv's schema
// compilation, not the per-call validate() itself — a document with no
// vega-lite blocks should never pay it. Module-level cache so repeated
// calls to checkVegaLite() within the same process (many vega-lite blocks
// in one document, or repeated test calls) only compile the schema once.
let _validateFn = null;

async function getValidateFn() {
  if (_validateFn) return _validateFn;

  const { default: Ajv } = await import("ajv");
  const schemaSource = await readFile(SCHEMA_PATH, "utf8");
  const schema = JSON.parse(schemaSource);

  // strict: false — the vendored schema uses "format" keywords (uri,
  // color-hex, uri-reference) ajv's core doesn't ship validators for
  // without the separate ajv-formats package; those formats are advisory
  // only (e.g. "is $schema a well-formed URI") and irrelevant to whether a
  // richmd author's chart spec has the right shape, so leaving them
  // unvalidated (ajv's default under strict:false: silently skip unknown
  // formats) is the correct trade-off here, not a hidden gap in the check
  // that matters for this validator's stated scope (design.md §05: shape
  // conformance, not semantic/content validation).
  //
  // logger: false — ajv's default logger prints an "unknown format ...
  // ignored" line (via console.warn) for every one of those format
  // keywords it encounters while compiling the schema, on every process
  // that imports this module. That's expected/intentional noise given the
  // strict:false trade-off above, not a real problem worth surfacing on
  // every render/validate invocation's stderr.
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  _validateFn = ajv.compile(schema);
  return _validateFn;
}

// pick_primary_error(errors) -> ajv error object
//
// vega-lite's top-level schema is `anyOf` a unit spec, a facet spec, a
// layer spec, a concat spec, etc. (design.md §05's "vega-lite JSON schema"
// is one schema covering every valid top-level shape). When a spec doesn't
// conform to ANY of those branches, ajv (with allErrors:true) reports every
// branch's own missing-property/type errors, which reads as a wall of noise
// rather than "a clear error naming the specific problem" (acceptance
// criteria). Heuristic: prefer a top-level "required" error over a nested
// "anyOf" grouping error, and among "required" errors prefer the one from
// the shortest schemaPath (closest to the top-level "unit spec" branch,
// which is what nearly every richmd author's ```vega-lite block will
// actually be attempting) — this is display-only, it never changes whether
// validation passed or failed.
function pick_primary_error(errors) {
  if (!errors || errors.length === 0) return null;

  const required = errors.filter((e) => e.keyword === "required");
  const pool = required.length > 0 ? required : errors;

  return pool.reduce((best, candidate) => {
    if (!best) return candidate;
    return candidate.schemaPath.length < best.schemaPath.length
      ? candidate
      : best;
  }, null);
}

// format_error(error) -> string
//
// Turns one ajv error object into a human-readable, specific reason —
// naming the missing/invalid field, not just "schema validation failed".
function format_error(error) {
  const where =
    error.instancePath && error.instancePath !== ""
      ? `at '${error.instancePath}'`
      : "at the top level";
  if (error.keyword === "required") {
    return `missing required field '${error.params.missingProperty}' (${where})`;
  }
  return `${where}: ${error.message}`;
}

// checkVegaLite(source) -> Promise<{valid: true} | {valid: false, reason: string}>
//
// Two distinct failure modes, checked in order per the acceptance criteria:
//   (a) the source isn't even valid JSON — a JSON.parse error, reported as
//       such (never conflated with a schema error);
//   (b) the source parses as JSON but the parsed object doesn't conform to
//       the vega-lite JSON schema — reported with the specific
//       missing/invalid field named.
// Never checks field references against actual data, or any other semantic
// concern — the "not a semantic validator" no-goal (design.md §00), same
// as mermaid's syntax-only check.
export async function checkVegaLite(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return {
      valid: false,
      reason: `not valid JSON: ${err.message}`,
    };
  }

  const validateFn = await getValidateFn();
  const ok = validateFn(parsed);
  if (ok) {
    return { valid: true };
  }

  const primary = pick_primary_error(validateFn.errors);
  const reason = primary
    ? `does not conform to the vega-lite schema: ${format_error(primary)}`
    : "does not conform to the vega-lite schema";
  return { valid: false, reason };
}

// --- CLI entry point ---
//
// Only runs when this file is executed directly — the Lua filter shells
// out to this file as a subprocess (filter/blocks/vega-lite.lua), it never
// requires it in-process, exactly mirroring mermaid-check.js's CLI entry
// point.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let source;
  try {
    source = await readStdin();
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        reason: `failed to read stdin: ${err.message}`,
      }) + "\n",
    );
    return 2;
  }

  let result;
  try {
    result = await checkVegaLite(source);
  } catch (err) {
    // The helper itself crashed unexpectedly (not a normal grammar
    // rejection) — distinct exit code per design.md §05 failure behavior.
    process.stdout.write(
      JSON.stringify({
        valid: false,
        reason: `vega-lite-check helper crashed: ${err.message || String(err)}`,
      }) + "\n",
    );
    return 2;
  }

  process.stdout.write(JSON.stringify(result) + "\n");
  return result.valid ? 0 : 1;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().then((code) => process.exit(code));
}
