import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, matchGlob, matchAny } from "../../scripts/lib/glob.mjs";
import { findMismatches, generatePairs, referenceMatchGlob, seededRandom } from "./glob-reference.mjs";

const cases = [
  ["*.md", "a.md", true],
  ["*.md", "d/a.md", false],
  ["**/*.md", "a.md", true],
  ["**/*.md", "d/e/a.md", true],
  ["docs/**", "docs/a", true],
  ["docs/**", "docs/a/b", true],
  ["docs/**", "docs", false],
  ["docs/**", "docsx/a", false],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/xb", false],
  ["?.md", "a.md", true],
  ["?.md", "ab.md", false],
  ["a?b", "a/b", false],
  ["*", ".hidden", true],
  [".claude/**", ".claude/settings.json", true],
  ["a**b", "axyb", true],
  ["a**b", "ax/yb", false],
  ["a+b.md", "a+b.md", true],
  ["a+b.md", "aab.md", false],
  ["docs/(x).md", "docs/(x).md", true],
  ["[ab].md", "a.md", false],
  ["[ab].md", "[ab].md", true],
  ["{a,b}.md", "{a,b}.md", true],
  ["a.md", "aXmd", false],
  ["**", "any/depth/file", true],
];

for (const [pattern, path, expected] of cases) {
  test(`matchGlob(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) is ${expected}`, () => {
    assert.equal(matchGlob(path, pattern), expected);
  });
}

test("matchAny is false for an empty pattern list and true when any matches", () => {
  assert.equal(matchAny("a.md", []), false);
  assert.equal(matchAny("d/a.md", ["*.md", "d/**"]), true);
});

for (const bad of ["", "/abs", "./rel", "dir/"]) {
  test(`pattern ${JSON.stringify(bad)} is refused`, () => {
    assert.throws(() => globToRegExp(bad), TypeError);
  });
  test(`path ${JSON.stringify(bad)} is refused`, () => {
    assert.throws(() => matchGlob(bad, "**"), TypeError);
    assert.throws(() => matchAny(bad, ["**"]), TypeError);
  });
}

// Regression: the matcher must run in bounded time even on adversarial,
// star-heavy patterns. A backtracking RegExp built naively from these
// shapes blows up exponentially; a correct implementation stays well
// under the bound regardless of input size.
const BOUND_MS = 200;

function assertBounded(fn, expected) {
  const start = performance.now();
  const actual = fn();
  const elapsed = performance.now() - start;
  assert.equal(actual, expected);
  assert.ok(elapsed < BOUND_MS, `expected under ${BOUND_MS}ms, took ${elapsed}ms`);
}

test(
  "30x 'a*' + literal X against 40 a's completes in bounded time (false)",
  { timeout: 5000 },
  () => {
    const pattern = "a*".repeat(30) + "X";
    const path = "a".repeat(40);
    assertBounded(() => matchGlob(path, pattern), false);
  },
);

test(
  "12x '**/' segments then 'b' against a 50-segment path completes in bounded time (true)",
  { timeout: 5000 },
  () => {
    const pattern = "**/".repeat(12) + "b";
    const segments = Array.from({ length: 49 }, (_, i) => `s${i}`);
    segments.push("b");
    const path = segments.join("/");
    assertBounded(() => matchGlob(path, pattern), true);
  },
);

test(
  "12x '**/' segments then 'b' against a 50-segment path completes in bounded time (false)",
  { timeout: 5000 },
  () => {
    const pattern = "**/".repeat(12) + "b";
    const segments = Array.from({ length: 49 }, (_, i) => `s${i}`);
    segments.push("notb");
    const path = segments.join("/");
    assertBounded(() => matchGlob(path, pattern), false);
  },
);

test(
  "a 10,000-character path against '**/x/**' completes in bounded time",
  { timeout: 5000 },
  () => {
    const pattern = "**/x/**";
    const segments = [];
    let length = 0;
    let i = 0;
    while (length < 10000) {
      const segment = `seg${i}`;
      segments.push(segment);
      length += segment.length + 1;
      i++;
    }
    const path = segments.join("/");
    assertBounded(() => matchGlob(path, pattern), false);
  },
);

// A trailing "**" needs at least one path segment of its own, even when a
// leading "**" and a middle segment could otherwise use up the whole path;
// a "**" never matches an empty path segment.
const segmentRuleCases = [
  ["**/*b/**", "a/b", false],
  ["**/*b/**", "x/yb", false],
  ["**/*b/**", "a/b/c", true],
  ["**/*b/**", "yb", false],
  ["**/**", "a", true],
  ["a/**/**", "a", false],
  ["**/b", "a//b", false],
  ["a/*/b", "a//b", true],
];

for (const [pattern, path, expected] of segmentRuleCases) {
  test(`segment rule: matchGlob(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) is ${expected}`, () => {
    assert.equal(matchGlob(path, pattern), expected);
  });
}

// Differential: every generated pair must match exactly as the original
// RegExp matcher (tests/lib/glob-reference.mjs) does.
const DIFFERENTIAL_SEED = 20260928;
const DIFFERENTIAL_COUNT = 5000;

function assertAgrees(candidate) {
  const pairs = generatePairs(DIFFERENTIAL_COUNT, seededRandom(DIFFERENTIAL_SEED));
  const mismatches = findMismatches(pairs, candidate);
  const minimal = mismatches[0];
  assert.equal(
    mismatches.length,
    0,
    minimal &&
      `${mismatches.length} mismatches; minimal: pattern ${JSON.stringify(minimal.pattern)}, ` +
        `path ${JSON.stringify(minimal.path)}, reference ${minimal.expected}, got ${minimal.actual}`,
  );
}

test(`matchGlob agrees with the reference matcher on ${DIFFERENTIAL_COUNT} generated pairs`, () => {
  assertAgrees(matchGlob);
});

test(`globToRegExp agrees with the reference matcher on ${DIFFERENTIAL_COUNT} generated pairs`, () => {
  assertAgrees((path, pattern) => globToRegExp(pattern).test(path));
});

test("the reference fixture reproduces the original trailing-** rule", () => {
  assert.equal(referenceMatchGlob("a/b", "**/*b/**"), false);
  assert.equal(referenceMatchGlob("docs", "docs/**"), false);
});
