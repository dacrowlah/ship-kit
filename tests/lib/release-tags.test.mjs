import assert from "node:assert/strict";
import test from "node:test";
import { RELEASE_TAG, parseLsRemote, releaseTagFor } from "../../scripts/lib/release-tags.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

test("RELEASE_TAG accepts releases and rc tags and nothing else", () => {
  for (const name of ["ship-kit--v0.2.0", "ship-kit--v10.0.1", "ship-kit--v0.2.0-rc.1", "ship-kit--v0.2.0-rc.12"]) {
    assert.ok(RELEASE_TAG.test(name), name);
  }
  for (const name of [
    "ship-kit--v0.2.0-evil", "ship-kit--v0.2.0-rc.0", "ship-kit--v0.2.0-rc.01", "ship-kit--v01.2.0",
    "ship-kit--v0.2", "v0.2.0", "ship-kit--v0.2.0\n", "x/ship-kit--v0.2.0", "ship-kit--v0.2.0-rc.1-evil",
  ]) {
    assert.ok(!RELEASE_TAG.test(name), JSON.stringify(name));
  }
});

test("an annotated tag (tag line plus ^{}) maps to its peeled commit", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\n${B}\trefs/tags/ship-kit--v0.2.0^{}\n`);
  assert.deepEqual([...tags], [["ship-kit--v0.2.0", { commit: B, annotated: true }]]);
});

test("the ^{} line may come before its tag line", () => {
  const tags = parseLsRemote(`${B}\trefs/tags/ship-kit--v0.2.0^{}\n${A}\trefs/tags/ship-kit--v0.2.0\n`);
  assert.deepEqual(tags.get("ship-kit--v0.2.0"), { commit: B, annotated: true });
});

test("a lightweight tag (tag line only) maps to the tag line's commit", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0-rc.1\n`);
  assert.deepEqual([...tags], [["ship-kit--v0.2.0-rc.1", { commit: A, annotated: false }]]);
});

test("ship-kit--v0.2.0-evil is ignored", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0-evil\n${B}\trefs/tags/ship-kit--v0.2.0-evil^{}\n`);
  assert.equal(tags.size, 0);
  assert.equal(releaseTagFor(tags, B), null);
});

test("ship-kit--v0.2.0-rc.0 is ignored", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0-rc.0\n`);
  assert.equal(tags.size, 0);
});

test("refs outside refs/tags/ and nested names are ignored", () => {
  const tags = parseLsRemote([
    `${A}\tHEAD`,
    `${A}\trefs/heads/ship-kit--v0.2.0`,
    `${A}\trefs/heads/refs/tags/ship-kit--v0.2.0`,
    `${B}\trefs/tags/x/refs/tags/ship-kit--v0.2.0`,
    `${C}\trefs/tags/ship-kit--v0.2.0`,
    "",
  ].join("\n"));
  assert.deepEqual([...tags], [["ship-kit--v0.2.0", { commit: C, annotated: false }]]);
});

test("empty output yields an empty map", () => {
  assert.equal(parseLsRemote("").size, 0);
});

test("duplicate line throws", () => {
  assert.throws(
    () => parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\n${B}\trefs/tags/ship-kit--v0.2.0\n`),
    /duplicate ls-remote line for refs\/tags\/ship-kit--v0\.2\.0$/,
  );
  assert.throws(
    () => parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\n${B}\trefs/tags/ship-kit--v0.2.0^{}\n${C}\trefs/tags/ship-kit--v0.2.0^{}\n`),
    /duplicate ls-remote line for refs\/tags\/ship-kit--v0\.2\.0\^\{\}/,
  );
});

test("CRLF input parses as LF", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\r\n${B}\trefs/tags/ship-kit--v0.2.0^{}\r\n`);
  assert.deepEqual(tags.get("ship-kit--v0.2.0"), { commit: B, annotated: true });
});

for (const [name, text] of [
  ["short sha", `${"a".repeat(39)}\trefs/tags/ship-kit--v0.2.0\n`],
  ["uppercase sha", `${"A".repeat(40)}\trefs/tags/ship-kit--v0.2.0\n`],
  ["space separator", `${A} refs/tags/ship-kit--v0.2.0\n`],
  ["blank line in the middle", `${A}\trefs/tags/ship-kit--v0.2.0\n\n${B}\trefs/tags/ship-kit--v0.3.0\n`],
  ["trailing field", `${A}\trefs/tags/ship-kit--v0.2.0\textra\n`],
  ["lone carriage return", `${A}\trefs/tags/ship-kit--v0.2.0\r\r\n`],
  ["warning text", "warning: redirecting to elsewhere\n"],
]) {
  test(`a malformed line throws: ${name}`, () => {
    assert.throws(() => parseLsRemote(text), /malformed ls-remote line/);
  });
}

test("a ^{} line without its tag line throws", () => {
  assert.throws(() => parseLsRemote(`${B}\trefs/tags/ship-kit--v0.2.0^{}\n`), /peeled line without its tag line: ship-kit--v0\.2\.0/);
});

test("non-string input throws", () => {
  assert.throws(() => parseLsRemote(undefined), TypeError);
});

test("releaseTagFor finds annotated and lightweight tags by commit", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\n${B}\trefs/tags/ship-kit--v0.2.0^{}\n${C}\trefs/tags/ship-kit--v0.1.0\n`);
  assert.equal(releaseTagFor(tags, B), "ship-kit--v0.2.0");
  assert.equal(releaseTagFor(tags, C), "ship-kit--v0.1.0");
  assert.equal(releaseTagFor(tags, D), null);
});

test("a tag-object SHA equal to the queried SHA is not a match", () => {
  const tags = parseLsRemote(`${A}\trefs/tags/ship-kit--v0.2.0\n${B}\trefs/tags/ship-kit--v0.2.0^{}\n`);
  assert.equal(releaseTagFor(tags, A), null);
});

test("releaseTagFor does not match a differently cased SHA", () => {
  const tags = parseLsRemote(`${"e".repeat(40)}\trefs/tags/ship-kit--v0.2.0\n`);
  assert.equal(releaseTagFor(tags, "E".repeat(40)), null);
});

test("several tags on one commit: the final release beats its rcs, the higher version beats the lower", () => {
  const tags = parseLsRemote([
    `${A}\trefs/tags/ship-kit--v0.2.0-rc.2`,
    `${A}\trefs/tags/ship-kit--v0.2.0`,
    `${A}\trefs/tags/ship-kit--v0.2.0-rc.10`,
    `${B}\trefs/tags/ship-kit--v0.3.0-rc.1`,
    `${B}\trefs/tags/ship-kit--v0.3.0-rc.10`,
    `${B}\trefs/tags/ship-kit--v0.3.0-rc.2`,
    `${C}\trefs/tags/ship-kit--v0.9.0`,
    `${C}\trefs/tags/ship-kit--v0.10.0`,
    `${C}\trefs/tags/ship-kit--v0.10.0-rc.1`,
    `${D}\trefs/tags/ship-kit--v1.0.0`,
    `${D}\trefs/tags/ship-kit--v0.99.99`,
    `${D}\trefs/tags/ship-kit--v1.0.1-rc.1`,
    `${D}\trefs/tags/ship-kit--v1.0.0-rc.3`,
    "",
  ].join("\n"));
  assert.equal(releaseTagFor(tags, A), "ship-kit--v0.2.0");
  assert.equal(releaseTagFor(tags, B), "ship-kit--v0.3.0-rc.10");
  assert.equal(releaseTagFor(tags, C), "ship-kit--v0.10.0");
  assert.equal(releaseTagFor(tags, D), "ship-kit--v1.0.1-rc.1");
});

test("the ranking compares every version component", () => {
  const tags = new Map([
    ["ship-kit--v2.0.0", { commit: A, annotated: false }],
    ["ship-kit--v1.9.9", { commit: A, annotated: false }],
    ["ship-kit--v2.0.1", { commit: B, annotated: false }],
    ["ship-kit--v2.0.0", { commit: A, annotated: false }],
  ]);
  assert.equal(releaseTagFor(tags, A), "ship-kit--v2.0.0");
  const patch = new Map([
    ["ship-kit--v2.0.0", { commit: A, annotated: false }],
    ["ship-kit--v2.0.3", { commit: A, annotated: false }],
    ["ship-kit--v2.0.2", { commit: A, annotated: false }],
  ]);
  assert.equal(releaseTagFor(patch, A), "ship-kit--v2.0.3");
});
