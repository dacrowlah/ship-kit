import assert from "node:assert/strict";
import test from "node:test";
import { itemAt, lastItem } from "../src/items.mjs";

test("itemAt returns the item at a valid index", () => {
  assert.equal(itemAt(["a", "b", "c"], 0), "a");
  assert.equal(itemAt(["a", "b", "c"], 2), "c");
});

test("itemAt refuses a negative or fractional index", () => {
  assert.throws(() => itemAt(["a"], -1), RangeError);
  assert.throws(() => itemAt(["a"], 0.5), RangeError);
});

test("lastItem returns the last item and refuses an empty list", () => {
  assert.equal(lastItem(["a", "b"]), "b");
  assert.throws(() => lastItem([]), RangeError);
});
