// Test fixture: the original RegExp-driven glob matcher, kept verbatim as
// the semantic reference for the differential test, plus a deterministic
// generator of small valid (pattern, path) pairs. Never imported by
// production code. The reference can backtrack exponentially on long
// star-heavy input, so feed it only the small generated pairs.

function assertRelative(value, what) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  if (value.startsWith("/") || value.startsWith("./")) {
    throw new TypeError(`${what} must be repo-relative with no leading "/" or "./": ${value}`);
  }
  if (value.endsWith("/")) {
    throw new TypeError(`${what} must not end in "/": ${value}`);
  }
}

function escapeLiteral(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function segmentToRegExp(segment) {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      if (!out.endsWith("[^/]*")) out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeLiteral(ch);
    }
  }
  return out;
}

function referenceGlobToRegExp(pattern) {
  assertRelative(pattern, "pattern");
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      return;
    }
    source += segmentToRegExp(segment);
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

/** @param {string} path @param {string} pattern @returns {boolean} */
export function referenceMatchGlob(path, pattern) {
  assertRelative(path, "path");
  return referenceGlobToRegExp(pattern).test(path);
}

/** A seeded 32-bit PRNG returning floats in [0, 1). @param {number} seed */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = ["a", "b", ".", "/", "*", "**", "?", "[", "]", "{", "}"];
const MAX_TOKENS = 7;

function isValid(value) {
  return value !== "" && !value.startsWith("/") && !value.startsWith("./") && !value.endsWith("/");
}

function randomString(random) {
  const length = 1 + Math.floor(random() * MAX_TOKENS);
  let out = "";
  for (let i = 0; i < length; i++) out += TOKENS[Math.floor(random() * TOKENS.length)];
  return out;
}

function randomValid(random) {
  for (;;) {
    const value = randomString(random);
    if (isValid(value)) return value;
  }
}

/**
 * @param {number} count
 * @param {() => number} random
 * @returns {Array<[string, string]>} [pattern, path] pairs, both valid
 */
export function generatePairs(count, random) {
  const pairs = [];
  for (let i = 0; i < count; i++) pairs.push([randomValid(random), randomValid(random)]);
  return pairs;
}

/**
 * @param {Array<[string, string]>} pairs
 * @param {(path: string, pattern: string) => boolean} candidate
 * @returns {Array<{pattern: string, path: string, expected: boolean, actual: boolean}>}
 *   every disagreement with the reference, shortest first
 */
export function findMismatches(pairs, candidate) {
  const mismatches = [];
  for (const [pattern, path] of pairs) {
    const expected = referenceMatchGlob(path, pattern);
    const actual = candidate(path, pattern);
    if (actual !== expected) mismatches.push({ pattern, path, expected, actual });
  }
  return mismatches.sort(
    (x, y) => x.pattern.length + x.path.length - (y.pattern.length + y.path.length),
  );
}
