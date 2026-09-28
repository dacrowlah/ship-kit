// Fails loudly in two cases `node --test` does not catch on its own:
//
// 1. A test glob matches zero files. `node --test` does not fail when a glob
//    argument matches nothing: it silently runs whatever the other patterns
//    matched and exits 0.
// 2. A script module has no paired test at the path this repository's
//    convention puts it: `scripts/<name>.mjs` beside `scripts/<name>.test.mjs`,
//    `scripts/lib/<name>.mjs` under `tests/lib/<name>.test.mjs`. Deleting only
//    one module's test still leaves both glob arguments non-empty (another
//    module's test still matches), so case 1 alone would not have caught it.
//
// Run this before `node --test` with the same glob arguments so a moved,
// renamed or deleted test file drops the required CI check to red instead of
// quietly shrinking test coverage while `ci` stays green.

import { existsSync, globSync } from "node:fs";
import { basename } from "node:path";

/**
 * @param {string[]} patterns
 * @param {(pattern: string) => string[]} glob
 * @returns {string[]} the patterns, in order, that matched zero files
 */
export function emptyGlobs(patterns, glob = globSync) {
  return patterns.filter((pattern) => glob(pattern).length === 0);
}

// Where each source glob's test lives, by this repository's convention
// (verified against the shipped modules: scripts/check-template-secrets.mjs
// -> scripts/check-template-secrets.test.mjs; scripts/lib/state-marker.mjs
// -> tests/lib/state-marker.test.mjs).
const TEST_LOCATIONS = [
  { sourceGlob: "scripts/*.mjs", testPath: (name) => `scripts/${name}.test.mjs` },
  { sourceGlob: "scripts/lib/*.mjs", testPath: (name) => `tests/lib/${name}.test.mjs` },
];

/**
 * @param {(pattern: string) => string[]} glob
 * @param {(path: string) => boolean} exists
 * @returns {string[]} one message per source module with no paired test
 */
export function missingTests(glob = globSync, exists = existsSync) {
  const violations = [];
  for (const { sourceGlob, testPath } of TEST_LOCATIONS) {
    for (const source of glob(sourceGlob)) {
      if (source.endsWith(".test.mjs")) continue;
      const expected = testPath(basename(source, ".mjs"));
      if (!exists(expected)) violations.push(`${source}: missing its test at ${expected}`);
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
