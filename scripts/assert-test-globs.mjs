// Fails loudly in three cases `node --test` does not catch on its own:
//
// 1. A test glob matches zero files. `node --test` does not fail when a glob
//    argument matches nothing: it silently runs whatever the other patterns
//    matched and exits 0.
// 2. A script module has no paired test at the path this repository's
//    convention puts it: `scripts/<name>.mjs` beside `scripts/<name>.test.mjs`
//    (subdirectories mirror the same rule: `scripts/foo/x.mjs` beside
//    `scripts/foo/x.test.mjs`), `scripts/lib/<name>.mjs` (any depth) under
//    the matching path in `tests/lib/`. Deleting only one module's test still
//    leaves both `node --test` glob arguments non-empty (another module's
//    test still matches), so case 1 alone would not have caught it. Nor
//    would checking `scripts/*.mjs` alone: a new module in a subdirectory,
//    or with a `.js`/`.cjs` extension, is invisible to a one-level,
//    `.mjs`-only glob.
// 3. A paired test file exists at the right path but registers no test:
//    `node --test` does not fail on a file with zero `test()`/`describe()`/
//    `it()` calls, so a stub left at the expected path (or an existing test
//    truncated to empty) satisfies plain file existence while exercising
//    nothing. This is deliberately a cheap content check, not a coverage
//    measurement: `node --experimental-test-coverage` was tried for this and
//    does not work for it. Its coverage report only lists files V8 actually
//    saw executed during the run; a module no test imports is silently
//    omitted from the report rather than shown at 0%, so it never lowers the
//    "all files" percentage the CI coverage floor checks. A module that
//    still has other, real coverage elsewhere in the tree would keep the
//    aggregate at or near 100% even while this one module's test was
//    emptied. This case check is what actually closes that gap; the
//    coverage floor (a separate CI step) instead catches a test that
//    imports a module but exercises it only partially.
//
// Run this before `node --test` with the same glob arguments so a moved,
// renamed, deleted or emptied test file drops the required CI check to red
// instead of quietly shrinking test coverage while `ci` stays green.

import { existsSync, globSync, readFileSync } from "node:fs";

const SOURCE_GLOB = "scripts/**/*.{mjs,js,cjs}";
const LIB_ROOT = "scripts/lib/";
const SOURCE_EXTENSION = /\.(mjs|js|cjs)$/;
const TEST_SUFFIX = /\.test\.(mjs|js|cjs)$/;
const TEST_REGISTRATION = /\b(test|describe|it)\s*\(/;

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
 * @param {string} content
 * @returns {boolean} whether the content registers at least one test
 */
export function registersATest(content) {
  return TEST_REGISTRATION.test(content);
}

/**
 * @param {(pattern: string) => string[]} glob
 * @param {(path: string) => boolean} exists
 * @param {(path: string) => string} readFile
 * @returns {string[]} one message per source module missing its test or
 *   whose test registers nothing
 */
export function missingTests(glob = globSync, exists = existsSync, readFile = (path) => readFileSync(path, "utf8")) {
  const violations = [];
  for (const source of glob(SOURCE_GLOB)) {
    if (TEST_SUFFIX.test(source)) continue;
    const expected = expectedTestPath(source);
    if (!exists(expected)) {
      violations.push(`${source}: missing its test at ${expected}`);
    } else if (!registersATest(readFile(expected))) {
      violations.push(`${expected}: registers no test(...)/describe(...)/it(...) call for ${source}`);
    }
  }
  return violations;
}

function main(argv) {
  if (argv.length === 0) {
    console.error("usage: node scripts/assert-test-globs.mjs <glob...>");
    return 2;
  }
  const problems = [
    ...emptyGlobs(argv).map((pattern) => `test glob matched zero files: ${pattern}`),
    ...missingTests(),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
