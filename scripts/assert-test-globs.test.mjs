import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyGlobs, missingTests } from "./assert-test-globs.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "assert-test-globs-"));
  for (const path of files) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "");
  }
  return root;
}

test("emptyGlobs reports nothing for a pattern that matches at least one file", () => {
  const glob = (pattern) => (pattern === "tests/*.test.mjs" ? ["tests/a.test.mjs"] : []);
  assert.deepEqual(emptyGlobs(["tests/*.test.mjs"], glob), []);
});

test("emptyGlobs reports a pattern that matches zero files", () => {
  const glob = () => [];
  assert.deepEqual(emptyGlobs(["scripts/*.test.mjs"], glob), ["scripts/*.test.mjs"]);
});

test("emptyGlobs checks every pattern independently and preserves order", () => {
  const glob = (pattern) => (pattern === "tests/**/*.test.mjs" ? ["tests/a.test.mjs"] : []);
  assert.deepEqual(emptyGlobs(["tests/**/*.test.mjs", "scripts/*.test.mjs"], glob), ["scripts/*.test.mjs"]);
});

test("emptyGlobs defaults to fs.globSync against the real filesystem", () => {
  const root = fixture(["tests/a.test.mjs"]);
  assert.deepEqual(emptyGlobs([join(root, "tests", "*.test.mjs")]), []);
  assert.deepEqual(emptyGlobs([join(root, "scripts", "*.test.mjs")]), [join(root, "scripts", "*.test.mjs")]);
});

test("missingTests passes a scripts/*.mjs module that has its sibling test", () => {
  const glob = (pattern) => (pattern === "scripts/*.mjs" ? ["scripts/foo.mjs"] : []);
  const exists = (path) => path === "scripts/foo.test.mjs";
  assert.deepEqual(missingTests(glob, exists), []);
});

test("missingTests reports a scripts/*.mjs module with no sibling test, naming both paths", () => {
  const glob = (pattern) => (pattern === "scripts/*.mjs" ? ["scripts/foo.mjs"] : []);
  const exists = () => false;
  const violations = missingTests(glob, exists);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /scripts\/foo\.mjs/);
  assert.match(violations[0], /scripts\/foo\.test\.mjs/);
});

test("missingTests passes a scripts/lib/*.mjs module that has its tests/lib test", () => {
  const glob = (pattern) => (pattern === "scripts/lib/*.mjs" ? ["scripts/lib/glob.mjs"] : []);
  const exists = (path) => path === "tests/lib/glob.test.mjs";
  assert.deepEqual(missingTests(glob, exists), []);
});

test("missingTests reports a scripts/lib/*.mjs module missing its tests/lib test", () => {
  const glob = (pattern) => (pattern === "scripts/lib/*.mjs" ? ["scripts/lib/glob.mjs"] : []);
  const exists = () => false;
  const violations = missingTests(glob, exists);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /scripts\/lib\/glob\.mjs/);
  assert.match(violations[0], /tests\/lib\/glob\.test\.mjs/);
});

test("missingTests never requires a *.test.mjs file matched by the source glob to have its own test", () => {
  const glob = (pattern) => (pattern === "scripts/*.mjs" ? ["scripts/foo.mjs", "scripts/foo.test.mjs"] : []);
  const exists = (path) => path === "scripts/foo.test.mjs";
  assert.deepEqual(missingTests(glob, exists), []);
});

test("missingTests checks every source module independently", () => {
  const glob = (pattern) =>
    pattern === "scripts/*.mjs" ? ["scripts/foo.mjs", "scripts/bar.mjs"] : pattern === "scripts/lib/*.mjs" ? ["scripts/lib/baz.mjs"] : [];
  const exists = (path) => path === "scripts/foo.test.mjs";
  const violations = missingTests(glob, exists);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => v.includes("scripts/bar.mjs")));
  assert.ok(violations.some((v) => v.includes("scripts/lib/baz.mjs")));
});

test("every script module in this repository has a paired test", () => {
  const cwd = process.cwd();
  process.chdir(REPO);
  try {
    assert.deepEqual(missingTests(), []);
  } finally {
    process.chdir(cwd);
  }
});

test("main exits 1 and names a script module missing its test", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture(["tests/a.test.mjs", "scripts/a.test.mjs", "scripts/foo.mjs"]);
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/foo\.mjs/);
      assert.match(error.stderr, /scripts\/foo\.test\.mjs/);
      return true;
    },
  );
});

test("main exits 1 and names the offending pattern when a glob matches nothing", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture(["tests/a.test.mjs"]);
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/\*\.test\.mjs/);
      return true;
    },
  );
});

test("main exits 0 and prints nothing when every glob matches", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture(["tests/a.test.mjs", "scripts/b.test.mjs"]);
  const output = execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(output, "");
});

test("main exits 2 with usage when given no patterns", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr, /usage/);
      return true;
    },
  );
});
