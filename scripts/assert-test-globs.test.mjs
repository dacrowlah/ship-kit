import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyGlobs } from "./assert-test-globs.mjs";

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
