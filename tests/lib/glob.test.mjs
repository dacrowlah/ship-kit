import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, matchGlob, matchAny } from "../../scripts/lib/glob.mjs";

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
