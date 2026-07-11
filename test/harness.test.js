import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("test harness", () => {
  it("runs a trivial assertion", () => {
    assert.equal(1 + 1, 2);
  });
});
