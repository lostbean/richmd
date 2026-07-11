#!/usr/bin/env node
// mermaid grammar validator (design.md §05).
//
// A small, tightly-scoped Node.js helper the Lua filter shells out to for
// mermaid — the one block kind with no native Lua grammar. Syntax-only:
// exercises mermaid's own parser and reports whether the source is
// well-formed, without rendering to a picture. No browser, no Puppeteer.
//
// mermaid.parse() runs diagram labels through DOMPurify, which does real
// feature-detection of a DOM (document.implementation, addHook, etc.) — a
// hand-rolled stub object is not enough. linkedom provides a real, but
// lightweight, DOM implementation that satisfies DOMPurify without pulling
// in a browser or Puppeteer/Chromium (confirmed via npm ls --all: no
// puppeteer/chromium/jsdom/playwright anywhere in either mermaid's or
// linkedom's own dependency tree). This mirrors the identical, already-
// proven pattern in this repo's own design-render tooling
// (scripts/design-render.src/main.mjs), which validates mermaid blocks in
// design.md the same way.
//
// Usage as a CLI (stdin -> JSON on stdout, distinct exit code):
//   node helpers/mermaid-check.js < diagram-source.mmd
//   echo "graph TD" | node helpers/mermaid-check.js
//
// Exit code 0: valid mermaid syntax, stdout is {"valid":true}
// Exit code 1: invalid mermaid syntax, stdout is {"valid":false,"reason":"..."}
// Exit code 2: usage/IO error (e.g. helper itself crashed unexpectedly) —
//   distinct from a normal grammar rejection, per design.md §05 failure
//   behavior ("a validator subprocess crashing unexpectedly is itself a
//   hard filter failure, distinct from a normal grammar rejection").

import { fileURLToPath } from "node:url";

// Lazy, once-per-process DOM setup: the cost is paying for linkedom +
// mermaid's initialize() call, not the parse() itself — a document with no
// mermaid blocks should never pay it. Module-level cache so repeated calls
// to checkMermaid() within the same process (e.g. many mermaid blocks in
// one document, or repeated test calls) only set up the DOM once.
let _mermaidParse = null;

async function getMermaidParse() {
  if (_mermaidParse) return _mermaidParse;

  const { parseHTML } = await import("linkedom");
  const { window, document } = parseHTML(
    "<!DOCTYPE html><html><body></body></html>",
  );
  globalThis.window = window;
  globalThis.document = document;
  // navigator is a read-only getter in Node 22 — a plain assignment throws;
  // defineProperty is required to override it.
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator || { userAgent: "node" },
    configurable: true,
  });

  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false });

  _mermaidParse = (content) => mermaid.parse(content);
  return _mermaidParse;
}

// checkMermaid(source) -> Promise<{valid: true} | {valid: false, reason: string}>
//
// Syntax-only: exercises mermaid's own grammar parser and reports the
// parser's own rejection reason verbatim (never a generic "invalid
// mermaid") — never checks layout, semantics, or renders to a picture (the
// "not a semantic validator" no-goal, design.md §00).
export async function checkMermaid(source) {
  const parse = await getMermaidParse();
  try {
    await parse(source);
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err.message || String(err) };
  }
}

// --- CLI entry point ---
//
// Only runs when this file is executed directly (not when imported by
// test/mermaid-check.test.js or the Lua filter's own require chain would be
// N/A here — Lua shells out to this file as a subprocess, it never requires
// it in-process).
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
    result = await checkMermaid(source);
  } catch (err) {
    // The helper itself crashed unexpectedly (not a normal grammar
    // rejection) — distinct exit code per design.md §05 failure behavior.
    process.stdout.write(
      JSON.stringify({
        valid: false,
        reason: `mermaid-check helper crashed: ${err.message || String(err)}`,
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
