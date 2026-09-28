import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkHuntList, parseShapes } from "./format.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const DESIGN_SHAPES = [
  "Prose-specified executable",
  "Derived number without its model",
  "Twin left behind",
  "Summary contradicts detail",
  "Enumeration at fewer sites",
  "Vendor page, wrong version",
  "Check that cannot fail for its claim",
  "Repository fact assumed",
  "Stale provenance",
  "Test stated three times",
  "Mutation that cannot redden",
  "Interface frozen against its dependency",
  "Rulings by accretion",
  "Fix-round residue",
  "Unreported stall",
  "Time-order dependence",
  "Guard that admits a state",
  "Declared cost that is not",
  "Standard departed silently",
  "History in the specification",
];

const shared = (body) =>
  `# T\n\nHeader.\n\n## Shapes\n\n### D1. One [generic]\n\n${body}`;
const GOOD_SHARED = "Mechanism: m.\n\nLook for: l.\n\nNot an instance: n.\n";

test("design-shared.md is a valid shared list of exactly D1..D20 with the design's names", () => {
  const text = read("review/hunt-lists/design-shared.md");
  assert.deepEqual(checkHuntList(text, { prefix: "D", shared: true }), []);
  assert.deepEqual(
    parseShapes(text).map((s) => `${s.id} ${s.name}`),
    DESIGN_SHAPES.map((name, i) => `D${i + 1} ${name}`),
  );
});

test("a well-formed shared shape passes", () => {
  assert.deepEqual(checkHuntList(shared(GOOD_SHARED), { prefix: "D", shared: true }), []);
});

test("a missing paragraph, a wrong order and an Instances field in a shared list fail", () => {
  const cases = [
    "Mechanism: m.\n\nLook for: l.\n",
    "Look for: l.\n\nMechanism: m.\n\nNot an instance: n.\n",
    "Mechanism: m.\n\nInstances:\n- Reached main: x.\n\nLook for: l.\n\nNot an instance: n.\n",
  ];
  for (const body of cases) {
    assert.equal(checkHuntList(shared(body), { prefix: "D", shared: true }).length, 1, body);
  }
});

test("a [repo] tag in a shared list, a wrong prefix and a malformed heading fail", () => {
  assert.equal(checkHuntList(shared(GOOD_SHARED).replace("[generic]", "[repo]"), { prefix: "D", shared: true }).length, 1);
  assert.equal(checkHuntList(shared(GOOD_SHARED), { prefix: "S", shared: true }).length, 1);
  assert.equal(checkHuntList(shared(GOOD_SHARED).replace("### D1. One [generic]", "### D1 One"), { prefix: "D", shared: true }).length, 1);
});

test("duplicate or decreasing ids fail; a gap does not", () => {
  const two = (a, b) => `${shared(GOOD_SHARED)}\n### D${a}. Two [generic]\n\n${GOOD_SHARED}`.replace("### D1.", `### D${b}.`);
  assert.equal(checkHuntList(two(1, 1), { prefix: "D", shared: true }).length, 2);
  assert.deepEqual(checkHuntList(two(3, 1), { prefix: "D", shared: true }), []);
  assert.ok(checkHuntList(two(1, 3), { prefix: "D", shared: true }).some((v) => v.includes("increase")));
});

test("a repo shape needs labelled instances", () => {
  const repo = (instances) =>
    `# T\n\n## Shapes\n\n### R1. One [repo]\n\nMechanism: m.\n\nInstances:\n${instances}\n\nLook for: l.\n\nNot an instance: n.\n`;
  assert.deepEqual(checkHuntList(repo("- Reached main: a.\n- Caught in review: b."), { prefix: "R", shared: false }), []);
  assert.equal(checkHuntList(repo("- Shipped: a."), { prefix: "R", shared: false }).length, 1);
});

test("a list with no Shapes section, or two, fails", () => {
  assert.equal(checkHuntList("# T\n\nNo shapes.\n", { prefix: "D", shared: true }).length, 1);
  assert.equal(checkHuntList("# T\n\n## Shapes\n\n## Shapes\n", { prefix: "D", shared: true }).length, 1);
});
