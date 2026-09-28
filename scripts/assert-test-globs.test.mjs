import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyGlobs, expectedTestPath, missingTests, registersATest } from "./assert-test-globs.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "assert-test-globs-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content ?? "");
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
  const root = fixture({ "tests/a.test.mjs": "" });
  assert.deepEqual(emptyGlobs([join(root, "tests", "*.test.mjs")]), []);
  assert.deepEqual(emptyGlobs([join(root, "scripts", "*.test.mjs")]), [join(root, "scripts", "*.test.mjs")]);
});

test("expectedTestPath keeps a top-level scripts module's test beside it", () => {
  assert.equal(expectedTestPath("scripts/check-template-secrets.mjs"), "scripts/check-template-secrets.test.mjs");
});

test("expectedTestPath keeps a subdirectory module's test beside it, mirroring the subdirectory", () => {
  assert.equal(expectedTestPath("scripts/foo/x.mjs"), "scripts/foo/x.test.mjs");
});

test("expectedTestPath maps scripts/lib/** onto tests/lib/**", () => {
  assert.equal(expectedTestPath("scripts/lib/glob.mjs"), "tests/lib/glob.test.mjs");
});

test("expectedTestPath mirrors a scripts/lib subdirectory under tests/lib", () => {
  assert.equal(expectedTestPath("scripts/lib/sub/y.mjs"), "tests/lib/sub/y.test.mjs");
});

test("expectedTestPath preserves the .js and .cjs extensions", () => {
  assert.equal(expectedTestPath("scripts/y.cjs"), "scripts/y.test.cjs");
  assert.equal(expectedTestPath("scripts/z.js"), "scripts/z.test.js");
});

test("registersATest recognizes test(), describe() and it() calls", () => {
  assert.equal(registersATest('test("x", () => {});'), true);
  assert.equal(registersATest('describe("x", () => {});'), true);
  assert.equal(registersATest('it("x", () => {});'), true);
});

test("registersATest rejects an empty or non-registering file", () => {
  assert.equal(registersATest(""), false);
  assert.equal(registersATest("// no tests here, just a comment\n"), false);
  assert.equal(registersATest('const contest = "not a test call";'), false);
});

test("missingTests passes a scripts/*.mjs module whose test exists and registers a test", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs"] : []);
  const exists = (path) => path === "scripts/foo.test.mjs";
  const readFile = () => 'test("ok", () => {});';
  assert.deepEqual(missingTests(glob, exists, readFile), []);
});

test("missingTests reports a module with no test at all, naming both paths", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs"] : []);
  const exists = () => false;
  const readFile = () => {
    throw new Error("must not read a file that does not exist");
  };
  const violations = missingTests(glob, exists, readFile);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /scripts\/foo\.mjs/);
  assert.match(violations[0], /scripts\/foo\.test\.mjs/);
});

test("missingTests reports a test file that exists but registers no test", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs"] : []);
  const exists = (path) => path === "scripts/foo.test.mjs";
  const readFile = () => "";
  const violations = missingTests(glob, exists, readFile);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /scripts\/foo\.test\.mjs/);
  assert.match(violations[0], /scripts\/foo\.mjs/);
});

test("missingTests passes a scripts/lib module in a subdirectory whose tests/lib test registers a test", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/lib/sub/y.mjs"] : []);
  const exists = (path) => path === "tests/lib/sub/y.test.mjs";
  const readFile = () => 'test("ok", () => {});';
  assert.deepEqual(missingTests(glob, exists, readFile), []);
});

test("missingTests never requires a *.test.* file matched by the source glob to have its own test", () => {
  const glob = (pattern) =>
    pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs", "scripts/foo.test.mjs"] : [];
  const exists = (path) => path === "scripts/foo.test.mjs";
  const readFile = () => 'test("ok", () => {});';
  assert.deepEqual(missingTests(glob, exists, readFile), []);
});

test("missingTests checks every source module independently, across .mjs/.js/.cjs and subdirectories", () => {
  const glob = (pattern) =>
    pattern === "scripts/**/*.{mjs,js,cjs}"
      ? ["scripts/foo.mjs", "scripts/foo/bar.js", "scripts/lib/baz.cjs"]
      : [];
  const exists = (path) => path === "scripts/foo.test.mjs";
  const readFile = () => 'test("ok", () => {});';
  const violations = missingTests(glob, exists, readFile);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => v.includes("scripts/foo/bar.js")));
  assert.ok(violations.some((v) => v.includes("scripts/lib/baz.cjs")));
});

test("every script module in this repository has a paired, registering test", () => {
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
  const root = fixture({ "tests/a.test.mjs": "", "scripts/a.test.mjs": "", "scripts/foo.mjs": "" });
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

test("main exits 1 when a paired test file is emptied, even though the glob still matches", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture({
    "tests/a.test.mjs": "",
    "scripts/kept.mjs": "",
    "scripts/kept.test.mjs": 'test("ok", () => {});',
    "scripts/truncated.mjs": "",
    "scripts/truncated.test.mjs": "",
  });
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/truncated\.test\.mjs/);
      assert.doesNotMatch(error.stderr, /scripts\/kept/);
      return true;
    },
  );
});

test("main exits 1 and names a new subdirectory module with no test anywhere", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture({ "tests/a.test.mjs": "", "scripts/a.test.mjs": 'test("ok", () => {});', "scripts/foo/x.mjs": "" });
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/foo\/x\.mjs/);
      return true;
    },
  );
});

test("main exits 1 and names a .cjs module with no test", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture({ "tests/a.test.mjs": "", "scripts/a.test.mjs": 'test("ok", () => {});', "scripts/y.cjs": "" });
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/y\.cjs/);
      return true;
    },
  );
});

test("main exits 1 and names the offending pattern when a glob matches nothing", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture({ "tests/a.test.mjs": "" });
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, "tests/*.test.mjs", "scripts/*.test.mjs"], { cwd: root, encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /scripts\/\*\.test\.mjs/);
      return true;
    },
  );
});

test("main exits 0 and prints nothing when every glob matches and every module has a registering test", () => {
  const scriptPath = new URL("./assert-test-globs.mjs", import.meta.url).pathname;
  const root = fixture({ "tests/a.test.mjs": "", "scripts/b.test.mjs": "" });
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
