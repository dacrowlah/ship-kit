import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, globSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  emptyGlobs,
  expectedTestPath,
  isolatedEnv,
  main,
  missingTests,
  pairedModules,
  parseTestRun,
  proofViolations,
  runPairedTest,
  unprovenModules,
} from "./assert-test-globs.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./assert-test-globs.mjs", import.meta.url));
const PAIR = { source: "scripts/x.mjs", test: "scripts/x.test.mjs" };
const GLOBS = ["tests/*.test.mjs", "scripts/**/*.test.{mjs,js,cjs}"];

const MODULE = "export function double(n) {\n  return n * 2;\n}\n";
const REAL_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { double } from "./x.mjs";',
  'test("double doubles", () => assert.equal(double(2), 4));',
  "",
].join("\n");

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "assert-test-globs-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content ?? "");
  }
  return root;
}

function prove(files) {
  const root = fixture(files);
  return unprovenModules([{ source: "scripts/x.mjs", test: "scripts/x.test.mjs" }], (pair) => runPairedTest(pair, root));
}

function runMain(argv, cwd) {
  const lines = [];
  const code = main(argv, cwd, (line) => lines.push(line));
  return { code, lines };
}

function tap({ pass = 1, fail = 0, cancelled = 0, rows = ["# scripts   |        |          |         | ", "#  x.mjs    | 100.00 |   100.00 |  100.00 | "] } = {}) {
  return [
    "TAP version 13",
    `# tests ${pass + fail}`,
    "# suites 0",
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    "# skipped 0",
    "# todo 0",
    "# start of coverage report",
    "# file      | line % | branch % | funcs % | uncovered lines",
    ...rows,
    "# all files | 100.00 |   100.00 |  100.00 | ",
    "# end of coverage report",
    "",
  ].join("\n");
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

test("pairedModules skips test files, sorts, and pairs each module with its test path", () => {
  const glob = (pattern) =>
    pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/lib/b.cjs", "scripts/a.mjs", "scripts/a.test.mjs"] : [];
  assert.deepEqual(pairedModules(glob), [
    { source: "scripts/a.mjs", test: "scripts/a.test.mjs" },
    { source: "scripts/lib/b.cjs", test: "tests/lib/b.test.cjs" },
  ]);
});

test("missingTests passes a module whose test exists", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs"] : []);
  const exists = (path) => path === "scripts/foo.test.mjs";
  assert.deepEqual(missingTests(glob, exists), []);
});

test("missingTests reports a module with no test at all, naming both paths", () => {
  const glob = (pattern) => (pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs"] : []);
  assert.deepEqual(missingTests(glob, () => false), ["scripts/foo.mjs: missing its test at scripts/foo.test.mjs"]);
});

test("missingTests checks every source module independently, across .mjs/.js/.cjs and subdirectories", () => {
  const glob = (pattern) =>
    pattern === "scripts/**/*.{mjs,js,cjs}" ? ["scripts/foo.mjs", "scripts/foo/bar.js", "scripts/lib/baz.cjs"] : [];
  const exists = (path) => path === "scripts/foo.test.mjs";
  const violations = missingTests(glob, exists);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => v.includes("scripts/foo/bar.js")));
  assert.ok(violations.some((v) => v.includes("scripts/lib/baz.cjs")));
});

test("parseTestRun reads the pass, fail and cancelled counts and the module's coverage row", () => {
  assert.deepEqual(parseTestRun(tap({ pass: 3, fail: 1, cancelled: 2 }), PAIR), {
    passed: 3,
    failed: 1,
    cancelled: 2,
    covered: true,
  });
});

test("parseTestRun reports the module uncovered when the coverage report has no row for it", () => {
  assert.equal(parseTestRun(tap({ rows: [] }), PAIR).covered, false);
  assert.equal(parseTestRun(tap({ rows: ["#  other.mjs | 100.00 | 100.00 | 100.00 | "] }), PAIR).covered, false);
  assert.equal(parseTestRun(tap({ rows: ["# x.mjs |  |  |  | "] }), PAIR).covered, false);
});

test("parseTestRun does not count the entry the runner adds for a file that registers no test", () => {
  const fileOnly = tap({ pass: 1 }).replace("TAP version 13", "TAP version 13\n# Subtest: scripts/x.test.mjs\nok 1 - scripts/x.test.mjs");
  assert.equal(parseTestRun(fileOnly, PAIR).passed, 0);
  const realTest = tap({ pass: 1 }).replace("TAP version 13", "TAP version 13\n# Subtest: doubles\nok 1 - doubles");
  assert.equal(parseTestRun(realTest, PAIR).passed, 1);
});

test("parseTestRun reads nothing from output with no summary or coverage report", () => {
  assert.deepEqual(parseTestRun("", PAIR), { passed: 0, failed: 0, cancelled: 0, covered: false });
});

test("parseTestRun trusts the runner's last summary and report, not lines a test printed earlier", () => {
  const printedByATest = ["# pass 9", "# start of coverage report", "#  x.mjs | 100.00 | 100.00 | 100.00 | ", "# end of coverage report"];
  const output = [...printedByATest, tap({ pass: 0, rows: [] })].join("\n");
  assert.deepEqual(parseTestRun(output, PAIR), { passed: 0, failed: 0, cancelled: 0, covered: false });
});

test("proofViolations accepts a passing run that covers its module", () => {
  const pair = { source: "scripts/x.mjs", test: "scripts/x.test.mjs" };
  assert.deepEqual(proofViolations(pair, { status: 0, output: tap() }), []);
});

test("proofViolations names each way a run fails to prove its module", () => {
  const pair = { source: "scripts/x.mjs", test: "scripts/x.test.mjs" };
  const [failing] = proofViolations(pair, { status: 1, output: tap({ fail: 1 }) });
  assert.match(failing, /scripts\/x\.test\.mjs: fails when run alone/);
  const [empty] = proofViolations(pair, { status: 0, output: tap({ pass: 0 }) });
  assert.match(empty, /passes no test/);
  const [unloaded] = proofViolations(pair, { status: 0, output: tap({ rows: [] }) });
  assert.match(unloaded, /never loads scripts\/x\.mjs/);
  assert.equal(proofViolations(pair, { status: null, output: "" }).length, 3);
});

test("isolatedEnv drops the enclosing test run's context and coverage directory only", () => {
  const env = { NODE_TEST_CONTEXT: "child-v8", NODE_V8_COVERAGE: "/tmp/cov", PATH: "/bin" };
  assert.deepEqual(isolatedEnv(env), { PATH: "/bin" });
  assert.equal(isolatedEnv().NODE_V8_COVERAGE, undefined);
});

test("a real test that imports its module and passes proves it", () => {
  assert.deepEqual(prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": REAL_TEST }), []);
});

test("a fully commented-out test fails the proof", () => {
  const commented = REAL_TEST.split("\n").map((line) => (line ? `// ${line}` : line)).join("\n");
  const violations = prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": commented });
  assert.ok(violations.some((v) => /passes no test/.test(v)));
  assert.ok(violations.some((v) => /never loads scripts\/x\.mjs/.test(v)));
});

test("a test that registers a passing test but never imports its module fails the proof", () => {
  const stub = 'import test from "node:test";\ntest("x", () => {});\n';
  assert.deepEqual(prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": stub }), [
    "scripts/x.test.mjs: never loads scripts/x.mjs (the module is absent from the run's coverage report)",
  ]);
});

test("an emptied test file fails the proof", () => {
  const violations = prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": "" });
  assert.ok(violations.some((v) => /passes no test/.test(v)));
  assert.ok(violations.some((v) => /never loads/.test(v)));
});

test("a test that imports its module but registers zero tests fails the proof", () => {
  const violations = prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": 'import "./x.mjs";\n' });
  assert.deepEqual(violations, ["scripts/x.test.mjs: passes no test when run alone, so it proves nothing about scripts/x.mjs"]);
});

test("a test whose only tests are skipped or todo fails the proof", () => {
  const skipped = 'import test from "node:test";\nimport "./x.mjs";\ntest.skip("s", () => {});\ntest.todo("t");\n';
  const violations = prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": skipped });
  assert.deepEqual(violations, ["scripts/x.test.mjs: passes no test when run alone, so it proves nothing about scripts/x.mjs"]);
});

test("a failing test fails the proof", () => {
  const failing = REAL_TEST.replace("double(2), 4", "double(2), 5");
  const violations = prove({ "scripts/x.mjs": MODULE, "scripts/x.test.mjs": failing });
  assert.ok(violations.some((v) => /fails when run alone \(exit 1, 1 failed/.test(v)));
});

test("every script module in this repository has a paired test file", () => {
  const glob = (pattern) => globSync(pattern, { cwd: REPO });
  assert.deepEqual(missingTests(glob, (path) => existsSync(join(REPO, path))), []);
});

test("main exits 2 with usage when given no patterns", () => {
  const { code, lines } = runMain([], REPO);
  assert.equal(code, 2);
  assert.match(lines[0], /usage/);
});

test("main exits 1 and names the offending pattern when a glob matches nothing", () => {
  const root = fixture({ "tests/a.test.mjs": "" });
  const { code, lines } = runMain(["tests/*.test.mjs", "scripts/*.test.mjs"], root);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["test glob matched zero files: scripts/*.test.mjs"]);
});

test("main exits 1 and names modules missing their test, including subdirectory and .cjs modules", () => {
  const root = fixture({ "tests/a.test.mjs": "", "scripts/foo/x.mjs": "", "scripts/y.cjs": "", "scripts/z.test.mjs": "" });
  const { code, lines } = runMain(GLOBS, root);
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    "scripts/foo/x.mjs: missing its test at scripts/foo/x.test.mjs",
    "scripts/y.cjs: missing its test at scripts/y.test.cjs",
  ]);
});

test("main exits 1 when a paired test never loads its module, and names only that test", () => {
  const root = fixture({
    "tests/a.test.mjs": "",
    "scripts/x.mjs": MODULE,
    "scripts/x.test.mjs": REAL_TEST,
    "scripts/w.mjs": MODULE,
    "scripts/w.test.mjs": REAL_TEST,
  });
  const { code, lines } = runMain(GLOBS, root);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["scripts/w.test.mjs: never loads scripts/w.mjs (the module is absent from the run's coverage report)"]);
});

test("main exits 0 and reports nothing when every module is proven by its test", () => {
  const root = fixture({ "tests/a.test.mjs": "", "scripts/x.mjs": MODULE, "scripts/x.test.mjs": REAL_TEST });
  assert.deepEqual(runMain(GLOBS, root), { code: 0, lines: [] });
});

test("the command line runs main and exits with its code", () => {
  const root = fixture({ "tests/a.test.mjs": "", "scripts/x.mjs": MODULE, "scripts/x.test.mjs": "" });
  const run = (cwd) => spawnSync(process.execPath, [SCRIPT, ...GLOBS], { cwd, env: isolatedEnv(), encoding: "utf8" });
  const failing = run(root);
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /scripts\/x\.test\.mjs: passes no test/);
  writeFileSync(join(root, "scripts/x.test.mjs"), REAL_TEST);
  const passing = run(root);
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(passing.stderr, "");
});
