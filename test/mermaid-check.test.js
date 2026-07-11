// Direct, in-process tests for the mermaid grammar-check helper
// (helpers/mermaid-check.js) — design.md §05 grammar validator.
//
// This is "in-process code richmd owns," per the TDD directive: test it
// directly by importing its check function and feeding it strings, before
// ever wiring it through the Lua filter's shell-out. CLI-level integration
// tests for the full richmd render pipeline live in test/render.test.js and
// test/validate.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkMermaid } from "../helpers/mermaid-check.js";

describe("checkMermaid (grammar validator, in-process)", () => {
  it("reports valid:true for a syntactically valid flowchart", async () => {
    const result = await checkMermaid(
      "graph TD\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n  B -->|No| D[End]\n",
    );
    assert.equal(result.valid, true);
  });

  it("reports valid:true for a valid sequence diagram", async () => {
    const result = await checkMermaid("sequenceDiagram\n  Alice->>Bob: Hello");
    assert.equal(result.valid, true);
  });

  it("reports valid:true for a valid class diagram (labeled)", async () => {
    const result = await checkMermaid(
      "classDiagram\n  class Animal{\n    +String name\n  }",
    );
    assert.equal(result.valid, true);
  });

  it("reports valid:false with a structured reason for malformed syntax", async () => {
    const result = await checkMermaid("graph TD\n  A --> ");
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });

  it("reports valid:false for a nonsensical arrow", async () => {
    const result = await checkMermaid("graph TD\n  A ~~ B\n");
    assert.equal(result.valid, false);
    assert.ok(result.reason.length > 0);
  });
});
