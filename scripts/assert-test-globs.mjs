// Fails loudly in three cases `node --test` does not catch on its own:
//
// 1. A test glob matches zero files. `node --test` does not fail when a glob
//    argument matches nothing: it silently runs whatever the other patterns
//    matched and exits 0.
// 2. A script module has no paired test at the path this repository's
//    convention puts it: `scripts/<name>.mjs` beside `scripts/<name>.test.mjs`
//    (subdirectories mirror the same rule: `scripts/foo/x.mjs` beside
//    `scripts/foo/x.test.mjs`), `scripts/lib/<name>.mjs` (any depth) under
//    the matching path in `tests/lib/`, for every `.mjs`/`.js`/`.cjs` module
//    at any depth. This is the cheap check and runs first.
// 3. A paired test exists but does not prove anything about its module. Each
//    paired test is run alone under Node's test runner, with coverage
//    restricted to that one module, and fails the check unless the run
//    exits 0 with no failed or cancelled test, passes at least one test
//    (skipped and todo tests do not count), and lists the module in its
//    coverage report. The last condition is what proves the test loads the
//    module: Node's coverage report omits a file no test loaded instead of
//    showing it at 0%, so a commented-out, emptied or stub test that never
//    imports its module reports no row for it.
//
// Run this before `node --test` with the same glob arguments so a moved,
// renamed, deleted, emptied or disconnected test drops the required CI check
// to red instead of quietly shrinking test coverage while `ci` stays green.

import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { basename, join } from "node:path";
import { isMain } from "./lib/entry-point.mjs";

const SOURCE_GLOB = "scripts/**/*.{mjs,js,cjs}";
const LIB_ROOT = "scripts/lib/";
const SOURCE_EXTENSION = /\.(mjs|js|cjs)$/;
const TEST_SUFFIX = /\.test\.(mjs|js|cjs)$/;
const COVERAGE_START = "# start of coverage report";
const COVERAGE_END = "# end of coverage report";

/**
 * @param {string[]} patterns
 * @param {(pattern: string) => string[]} glob
 * @returns {string[]} the patterns, in order, that matched zero files
 */
export function emptyGlobs(patterns, glob = globSync) {
  return patterns.filter((pattern) => glob(pattern).length === 0);
}

/**
 * Maps a script module to the test path this repository's convention puts
 * it at: `scripts/lib/**` mirrors under `tests/lib/**`; every other path
 * under `scripts/**` keeps its test beside it, extension preserved.
 * @param {string} source
 * @returns {string}
 */
export function expectedTestPath(source) {
  const ext = source.match(SOURCE_EXTENSION)[1];
  const withoutExt = source.slice(0, -(ext.length + 1));
  if (source.startsWith(LIB_ROOT)) {
    const rest = withoutExt.slice(LIB_ROOT.length);
    return `tests/lib/${rest}.test.${ext}`;
  }
  return `${withoutExt}.test.${ext}`;
}

/**
 * @param {(pattern: string) => string[]} glob
 * @returns {{ source: string, test: string }[]} every non-test module under
 *   `scripts/**` with the test path the convention pairs it with
 */
export function pairedModules(glob = globSync) {
  return glob(SOURCE_GLOB)
    .filter((source) => !TEST_SUFFIX.test(source))
    .sort()
    .map((source) => ({ source, test: expectedTestPath(source) }));
}

/**
 * @param {(pattern: string) => string[]} glob
 * @param {(path: string) => boolean} exists
 * @returns {string[]} one message per source module whose test file is missing
 */
export function missingTests(glob = globSync, exists = existsSync) {
  return pairedModules(glob)
    .filter(({ test }) => !exists(test))
    .map(({ source, test }) => `${source}: missing its test at ${test}`);
}

/**
 * Reads the last value of a tap summary line such as `# pass 3`. The summary
 * is printed after every test's own output, so the last occurrence is the
 * runner's, not a line a test printed.
 * @param {string} output
 * @param {string} key
 * @returns {number | null}
 */
function summaryCount(output, key) {
  const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
  return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
}

/**
 * @param {string} output
 * @param {string} source
 * @returns {boolean} whether the last coverage report in the output has a
 *   measured row for the module (run with coverage restricted to it)
 */
function coverageListsModule(output, source) {
  const start = output.lastIndexOf(COVERAGE_START);
  if (start === -1) return false;
  const end = output.indexOf(COVERAGE_END, start);
  const report = output.slice(start, end === -1 ? undefined : end).split("\n");
  const name = basename(source);
  return report.some((line) => {
    const cells = line.replace(/^#/, "").split("|").map((cell) => cell.trim());
    return cells.length >= 2 && cells[0] === name && /^\d+(\.\d+)?$/.test(cells[1]);
  });
}

/**
 * When a test file registers no test at all, the runner reports the file
 * itself as one passing test named after its path, at the top level. A file
 * that registers any test gets no such entry.
 * @param {string} output
 * @param {string} test
 * @returns {boolean}
 */
function reportsFileAsItsOnlyTest(output, test) {
  const name = test.replace(/\\/g, "\\\\").replace(/#/g, "\\#");
  return output.split("\n").includes(`ok 1 - ${name}`);
}

/**
 * Parses the tap output of `node --test --experimental-test-coverage
 * --test-reporter=tap` run on one test file with coverage restricted to one
 * module. `passed` counts only tests the file registered and ran to a pass:
 * skipped and todo tests are not in the runner's pass count, and the entry
 * the runner adds for a file that registers nothing is subtracted.
 * @param {string} output
 * @param {{ source: string, test: string }} pair
 * @returns {{ passed: number, failed: number, cancelled: number, covered: boolean }}
 */
export function parseTestRun(output, { source, test }) {
  const pass = summaryCount(output, "pass") ?? 0;
  return {
    passed: reportsFileAsItsOnlyTest(output, test) ? pass - 1 : pass,
    failed: summaryCount(output, "fail") ?? 0,
    cancelled: summaryCount(output, "cancelled") ?? 0,
    covered: coverageListsModule(output, source),
  };
}

/**
 * @param {{ source: string, test: string }} pair
 * @param {{ status: number | null, output: string }} run
 * @returns {string[]} why the test run does not prove the module is tested
 */
export function proofViolations({ source, test }, { status, output }) {
  const { passed, failed, cancelled, covered } = parseTestRun(output, { source, test });
  const violations = [];
  if (status !== 0 || failed > 0 || cancelled > 0) {
    violations.push(`${test}: fails when run alone (exit ${status}, ${failed} failed, ${cancelled} cancelled)`);
  }
  if (passed === 0) {
    violations.push(`${test}: passes no test when run alone, so it proves nothing about ${source}`);
  }
  if (!covered) {
    violations.push(`${test}: never loads ${source} (the module is absent from the run's coverage report)`);
  }
  return violations;
}

/**
 * Removes the variables through which an enclosing test run would leak into
 * a child process: NODE_TEST_CONTEXT makes a nested `node --test` behave as
 * one of the parent's test files, and NODE_V8_COVERAGE would add the
 * child's coverage to the parent's report.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnv(env = process.env) {
  const { NODE_TEST_CONTEXT, NODE_V8_COVERAGE, ...rest } = env;
  return rest;
}

/**
 * Runs one test file alone with coverage restricted to one module.
 * @param {{ source: string, test: string }} pair
 * @param {string} cwd
 * @returns {{ status: number | null, output: string }}
 */
export function runPairedTest({ source, test }, cwd = process.cwd()) {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      `--test-coverage-include=${source}`,
      "--test-reporter=tap",
      test,
    ],
    { cwd, env: isolatedEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * @param {{ source: string, test: string }[]} pairs modules whose test exists
 * @param {(pair: { source: string, test: string }) => { status: number | null, output: string }} run
 * @returns {string[]}
 */
export function unprovenModules(pairs, run = runPairedTest) {
  return pairs.flatMap((pair) => proofViolations(pair, run(pair)));
}

/**
 * @param {string[]} argv the test glob arguments `node --test` is given
 * @param {string} cwd
 * @param {(line: string) => void} report
 * @returns {number} the exit code
 */
export function main(argv, cwd = process.cwd(), report = console.error) {
  if (argv.length === 0) {
    report("usage: node scripts/assert-test-globs.mjs <glob...>");
    return 2;
  }
  const glob = (pattern) => globSync(pattern, { cwd });
  const exists = (path) => existsSync(join(cwd, path));
  const pairs = pairedModules(glob);
  const problems = [
    ...emptyGlobs(argv, glob).map((pattern) => `test glob matched zero files: ${pattern}`),
    ...missingTests(glob, exists),
    ...unprovenModules(
      pairs.filter(({ test }) => exists(test)),
      (pair) => runPairedTest(pair, cwd),
    ),
  ];
  for (const problem of problems) report(problem);
  return problems.length > 0 ? 1 : 0;
}

if (isMain(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
