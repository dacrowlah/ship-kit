// Decides whether a module is the script node was started with. Node gives
// the main module's `import.meta.url` with symlinks resolved but leaves
// `process.argv[1]` unresolved, so comparing the two as strings runs nothing
// when the script is started through a symlink (a linked plugin directory or
// checkout), and a hand-built `file://` string also misses a path holding a
// space or a percent sign. Both sides are compared as real paths instead.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `argv1` and `moduleUrl` name the same file once every symlink is
 * resolved; false when either cannot be resolved.
 * @param {string | undefined} argv1 the script path, `process.argv[1]`
 * @param {string} moduleUrl the module's `import.meta.url`
 * @returns {boolean}
 */
export function isMain(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
