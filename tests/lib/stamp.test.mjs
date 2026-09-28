import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyHash, formatStamp, parseStamp, stampFile, readManagedFile,
  renderManagedBlock, findManagedBlocks,
} from "../../scripts/lib/stamp.mjs";

const META = { template: "callers/review.yml", version: "0.1.0", sha: "a".repeat(40) };

test("bodyHash is SHA-256 hex and reads CRLF as LF", () => {
  assert.equal(bodyHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(bodyHash("a\r\nb\r\n"), bodyHash("a\nb\n"));
  assert.notEqual(bodyHash("a\nb\n"), bodyHash("a\nb"));
});

test("formatStamp writes keys in a fixed order and parseStamp round-trips", () => {
  const stamp = { body: "b".repeat(64), sha: META.sha, version: "0.1.0", template: META.template };
  const json = formatStamp(stamp);
  assert.equal(json, `{"template":"callers/review.yml","version":"0.1.0","sha":"${"a".repeat(40)}","body":"${"b".repeat(64)}"}`);
  assert.deepEqual(parseStamp(json), { ...stamp });
});

for (const [name, stamp] of [
  ["missing key", { template: "t", version: "0.1.0", sha: "a".repeat(40) }],
  ["extra key", { template: "t", version: "0.1.0", sha: "a".repeat(40), body: "b".repeat(64), x: 1 }],
  ["short sha", { template: "t", version: "0.1.0", sha: "abc", body: "b".repeat(64) }],
  ["uppercase sha", { template: "t", version: "0.1.0", sha: "A".repeat(40), body: "b".repeat(64) }],
  ["bad version", { template: "t", version: "v1", sha: "a".repeat(40), body: "b".repeat(64) }],
  ["bad body", { template: "t", version: "0.1.0", sha: "a".repeat(40), body: "zz" }],
]) {
  test(`formatStamp refuses a stamp with a ${name}`, () => {
    assert.throws(() => formatStamp(stamp), TypeError);
  });
}

test("parseStamp refuses non-JSON", () => {
  assert.throws(() => parseStamp("{not json"), TypeError);
});

test("a stamped file reads back current, and an edit reads as modified", () => {
  const body = "name: x\non: push\n";
  const file = stampFile(body, META, "hash");
  assert.match(file, /^# ship-kit-managed: \{/);
  const read = readManagedFile(file);
  assert.equal(read.body, body);
  assert.equal(read.bodyMatches, true);
  assert.equal(read.stamp.version, "0.1.0");
  assert.equal(readManagedFile(file.replace("push", "pull_request")).bodyMatches, false);
});

test("the stamp goes on the second line after a shebang", () => {
  const file = stampFile("echo hi\n", META, "hash", "#!/usr/bin/env bash");
  const lines = file.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env bash");
  assert.match(lines[1], /^# ship-kit-managed: /);
  assert.equal(readManagedFile(file).bodyMatches, true);
});

test("slash and html syntaxes round-trip", () => {
  for (const syntax of ["slash", "html"]) {
    const file = stampFile("x\n", META, syntax);
    assert.equal(readManagedFile(file).bodyMatches, true, syntax);
  }
  assert.match(stampFile("x\n", META, "html"), /^<!-- ship-kit-managed: \{.*\} -->\n/);
});

test("a CRLF checkout of a stamped file still reads as current", () => {
  const file = stampFile("a\nb\n", META, "hash").replace(/\n/g, "\r\n");
  assert.equal(readManagedFile(file).bodyMatches, true);
});

test("a file with no stamp line is unmanaged (null)", () => {
  assert.equal(readManagedFile("name: x\n"), null);
  assert.equal(readManagedFile("#!/bin/sh\necho\n"), null);
  assert.equal(readManagedFile(""), null);
});

test("a stamp line with invalid JSON throws rather than reading as unmanaged", () => {
  assert.throws(() => readManagedFile("# ship-kit-managed: {oops}\nbody\n"), TypeError);
});

test("an unknown comment syntax is refused", () => {
  assert.throws(() => stampFile("x\n", META, "semicolon"), TypeError);
});

test("managed blocks are found with their bodies, indentation allowed", () => {
  const block = renderManagedBlock("      - run: x\n", META, "hash", "    ");
  const content = `jobs:\n  a:\n${block}  b:\n`;
  const [found] = findManagedBlocks(content);
  assert.equal(found.body, "      - run: x\n");
  assert.equal(found.bodyMatches, true);
  assert.equal(found.beginLine, 3);
  assert.equal(found.endLine, 5);
  const edited = findManagedBlocks(content.replace("run: x", "run: y"));
  assert.equal(edited[0].bodyMatches, false);
});

test("an empty managed block is valid", () => {
  const [found] = findManagedBlocks(renderManagedBlock("", META, "html"));
  assert.equal(found.body, "");
  assert.equal(found.bodyMatches, true);
});

test("nested, unopened and unclosed blocks throw", () => {
  const begin = renderManagedBlock("x\n", META, "hash").split("\n")[0];
  assert.throws(() => findManagedBlocks(`${begin}\n${begin}\n# ship-kit-managed-end\n`), /nested/);
  assert.throws(() => findManagedBlocks("# ship-kit-managed-end\n"), /without a begin/);
  assert.throws(() => findManagedBlocks(`${begin}\nx\n`), /has no end/);
});
