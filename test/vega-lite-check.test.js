// Direct, in-process tests for the vega-lite grammar-check helper
// (helpers/vega-lite-check.js) — design.md §05 grammar validator.
//
// Mirrors test/mermaid-check.test.js's pattern exactly: test the exported
// check function directly, before it is ever wired through the Lua
// filter's shell-out. CLI-level integration tests for the full richmd
// render pipeline live in test/vega-lite.test.js.
//
// Unlike mermaid, vega-lite validation is JSON-schema based, not a custom
// grammar parser (design.md §05): a vega-lite spec is just JSON checked
// against the published vega-lite JSON schema. Two distinct failure modes
// are tested separately, per the acceptance criteria: (a) the source isn't
// even valid JSON, and (b) the source is valid JSON but doesn't conform to
// the vega-lite schema.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkVegaLite } from "../helpers/vega-lite-check.js";

describe("checkVegaLite (grammar validator, in-process)", () => {
  it("reports valid:true for a minimal valid bar chart spec", async () => {
    const result = await checkVegaLite(
      JSON.stringify({
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        data: { values: [{ a: "A", b: 28 }] },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "nominal" },
          y: { field: "b", type: "quantitative" },
        },
      }),
    );
    assert.equal(result.valid, true);
  });

  it("reports valid:true for a minimal valid point spec with inline data", async () => {
    const result = await checkVegaLite(
      JSON.stringify({
        data: { values: [{ x: 1, y: 2 }] },
        mark: "point",
        encoding: {
          x: { field: "x", type: "quantitative" },
          y: { field: "y", type: "quantitative" },
        },
      }),
    );
    assert.equal(result.valid, true);
  });

  it("reports valid:false with a clear reason for malformed (unparseable) JSON", async () => {
    const result = await checkVegaLite("{ not valid json ]");
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, "string");
    assert.match(result.reason, /JSON/i);
  });

  it("reports valid:false for empty source treated as malformed JSON", async () => {
    const result = await checkVegaLite("");
    assert.equal(result.valid, false);
    assert.match(result.reason, /JSON/i);
  });

  it("reports valid:false for valid JSON missing the required 'mark' field", async () => {
    const result = await checkVegaLite(
      JSON.stringify({
        data: { values: [{ a: "A", b: 28 }] },
        encoding: {
          x: { field: "a", type: "nominal" },
          y: { field: "b", type: "quantitative" },
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, "string");
    assert.match(result.reason, /mark/);
  });

  it("reports valid:false for valid JSON missing the required 'data' field", async () => {
    const result = await checkVegaLite(
      JSON.stringify({
        mark: "bar",
        encoding: {
          x: { field: "a", type: "nominal" },
          y: { field: "b", type: "quantitative" },
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /data/);
  });

  it("distinguishes 'invalid JSON' from 'valid JSON, invalid vega-lite schema' in the reason text", async () => {
    const jsonError = await checkVegaLite("{ broken");
    const schemaError = await checkVegaLite(JSON.stringify({ foo: "bar" }));
    assert.equal(jsonError.valid, false);
    assert.equal(schemaError.valid, false);
    assert.notEqual(jsonError.reason, schemaError.reason);
    assert.match(jsonError.reason, /JSON/i);
  });

  it("reports valid:false for a spec with a wrong-typed field", async () => {
    const result = await checkVegaLite(
      JSON.stringify({
        data: { values: [{ a: "A", b: 28 }] },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "not-a-real-type" },
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.reason.length > 0);
  });
});
