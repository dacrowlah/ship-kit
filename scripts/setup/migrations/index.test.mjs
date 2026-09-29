import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATIONS, checkChain } from "./index.mjs";

const step = (from) => ({ from, to: from + 1, migrate: (c) => c });

test("MIGRATIONS is empty at schemaVersion 1 and a valid chain", () => {
  assert.deepEqual(MIGRATIONS, []);
  assert.ok(Object.isFrozen(MIGRATIONS));
  checkChain(MIGRATIONS, 1);
});

test("a contiguous chain reaching the target passes", () => {
  checkChain([step(0), step(1), step(2)], 3);
});

test("a gap in the chain throws", () => {
  assert.throws(() => checkChain([step(0), step(2)], 3), /gap: 1 is followed by 2/);
});

test("a chain that stops short of or passes the target throws", () => {
  assert.throws(() => checkChain([step(0)], 2), /ends at 1, not 2/);
  assert.throws(() => checkChain([step(0), step(1)], 1), /ends at 2, not 1/);
});

test("malformed entries throw", () => {
  assert.throws(() => checkChain("x", 1), /must be an array/);
  assert.throws(() => checkChain([null], 1), /exactly the keys/);
  assert.throws(() => checkChain([{ ...step(0), extra: 1 }], 1), /exactly the keys/);
  assert.throws(() => checkChain([{ from: 0, to: 2, migrate: (c) => c }], 2), /next one/);
  assert.throws(() => checkChain([{ from: -1, to: 0, migrate: (c) => c }], 1), /next one/);
  assert.throws(() => checkChain([{ from: 0.5, to: 1.5, migrate: (c) => c }], 1), /next one/);
  assert.throws(() => checkChain([{ from: 0, to: 1, migrate: "x" }], 1), /must be a function/);
});

test("a target that is not a positive integer throws", () => {
  assert.throws(() => checkChain([], 0), /positive integer/);
  assert.throws(() => checkChain([], 1.5), /positive integer/);
});
