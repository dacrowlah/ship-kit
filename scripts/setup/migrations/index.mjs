// The config migration chain. Each entry turns a config written at
// `schemaVersion` `from` into one at `to` (always `from + 1`); `config.mjs`
// applies the chain in memory before validating (design 5.2). Schema version
// 1 is the first, so the chain is empty.

/** @typedef {{from: number, to: number, migrate: (config: object) => object}} Migration */

/** @type {readonly Migration[]} */
export const MIGRATIONS = Object.freeze([]);

const KEYS = ["from", "migrate", "to"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Throws unless `migrations` is a contiguous chain of single steps, sorted by
 * `from`, whose last step reaches `target` (an empty chain is valid for any
 * target). Each `migrate` must be a pure function of its argument:
 * `config.mjs` passes it a deep-frozen copy, so a migration that mutates its
 * input throws there.
 * @param {unknown} migrations
 * @param {number} target
 */
export function checkChain(migrations, target) {
  if (!Number.isInteger(target) || target < 1) throw new Error(`migration target must be a positive integer, got ${target}`);
  if (!Array.isArray(migrations)) throw new Error("migrations must be an array");
  migrations.forEach((m, i) => {
    if (!isPlainObject(m) || Object.keys(m).sort().join() !== KEYS.join()) {
      throw new Error(`migration ${i} must have exactly the keys from, to and migrate`);
    }
    if (!Number.isInteger(m.from) || m.from < 0 || m.to !== m.from + 1) {
      throw new Error(`migration ${i} must step from a non-negative integer to the next one`);
    }
    if (typeof m.migrate !== "function") throw new Error(`migration ${i}: migrate must be a function`);
    if (i > 0 && migrations[i - 1].to !== m.from) {
      throw new Error(`migration chain has a gap: ${migrations[i - 1].to} is followed by ${m.from}`);
    }
  });
  if (migrations.length > 0 && migrations.at(-1).to !== target) {
    throw new Error(`migration chain ends at ${migrations.at(-1).to}, not ${target}`);
  }
}
