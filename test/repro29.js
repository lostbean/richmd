import { lift } from "../filter/directive-lift.js";
import assert from "assert";

const input = `::: goal {id=G1 title="A goal"}
Body.
:::`;

const expected = `::: {.goal id=G1 title="A goal"}
Body.
:::`;

const actual = lift(input);
assert.strictEqual(actual, expected, "Failed to lift spaced directive form");
console.log("Repro test passed!");
