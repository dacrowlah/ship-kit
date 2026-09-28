// Fails loudly when a test glob matches zero files. `node --test` does not
// fail when a glob argument matches nothing: it silently runs whatever the
// other patterns matched and exits 0. Run this before `node --test` with the
// same glob arguments so a moved, renamed or deleted test file drops the
// required CI check to red instead of quietly shrinking test coverage while
// `ci` stays green.

import { globSync } from "node:fs";

/**
 * @param {string[]} patterns
 * @param {(pattern: string) => string[]} glob
 * @returns {string[]} the patterns, in order, that matched zero files
 */
export function emptyGlobs(patterns, glob = globSync) {
  return patterns.filter((pattern) => glob(pattern).length === 0);
}

function main(argv) {
  if (argv.length === 0) {
    console.error("usage: node scripts/assert-test-globs.mjs <glob...>");
    return 2;
  }
  const empty = emptyGlobs(argv);
  if (empty.length > 0) {
    console.error(`test glob matched zero files: ${empty.join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
