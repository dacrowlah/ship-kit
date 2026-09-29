// Renders seat output inert before a bot posts it, and detects text shaped
// like a credential so it can be withheld instead of posted. Pure functions;
// nothing here reads the network or the filesystem.
//
// Callers truncate before fencing, so a cut never removes a closing fence.

export const TRUNCATED = "[truncated]";

// Removed from posted text: every control character except newline and tab
// (C0, DEL and C1; CR included), every format character (zero-width
// characters, the soft hyphen, bidi controls) and every default-ignorable
// character (variation selectors, the combining grapheme joiner, Hangul
// fillers), since a renderer shows these as nothing or reorders text with them.
const HIDDEN = /[^\P{Cc}\n\t]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;
// Removed before credential checks: the same set, tab included, so an
// invisible character cannot split a prefix. No code point's NFKC form
// contains one of these, so one pass before normalizing is enough.
const INVISIBLE = /[^\P{Cc}\n]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;
const TOKEN_PREFIXES = [
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-ant-",
  // base64 of "x-access-token:", as in an HTTP basic authorization header
  "eC1hY2Nlc3MtdG9rZW46",
];
const JWT = /eyJ[A-Za-z0-9_-]+\.eyJ/;
const ACCESS_TOKEN = "x-access-token:";
const PRIVATE_KEY = /-----BEGIN[^\n]*PRIVATE KEY-----/;

function requireString(text, name) {
  if (typeof text !== "string") throw new TypeError(`${name} expects a string`);
}

/**
 * Wraps text in a backtick fence one longer than its longest backtick run
 * (minimum 3), after removing control characters other than newline and tab
 * and every format or default-ignorable character,
 * so mentions, links, images and HTML inside cannot render or notify.
 * @param {string} text
 * @returns {string}
 */
export function fence(text) {
  requireString(text, "fence");
  const clean = text.replace(HIDDEN, "");
  let longest = 0;
  for (const [run] of clean.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  const bar = "`".repeat(Math.max(3, longest + 1));
  const body = clean.endsWith("\n") ? clean.slice(0, -1) : clean;
  return `${bar}\n${body}\n${bar}`;
}

function normalize(text) {
  return text.replace(INVISIBLE, "").normalize("NFKC");
}

/**
 * True when the text, normalized, contains a credential-shaped prefix.
 * @param {string} text
 * @returns {boolean}
 */
export function credentialLike(text) {
  requireString(text, "credentialLike");
  const normal = normalize(text);
  if (TOKEN_PREFIXES.some((prefix) => normal.includes(prefix))) return true;
  if (normal.toLowerCase().includes(ACCESS_TOKEN)) return true;
  return PRIVATE_KEY.test(normal) || JWT.test(normal);
}

/**
 * credentialLike over every string in a JSON value, object keys included.
 * Iterative, so deeply nested input cannot exhaust the stack.
 * @param {unknown} value
 * @returns {boolean}
 */
export function anyCredential(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (credentialLike(item)) return true;
    } else if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (credentialLike(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/**
 * At most `max` characters: the text unchanged when it fits, otherwise its
 * longest prefix of whole lines followed by a final line `[truncated]`.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  requireString(text, "truncate");
  if (!Number.isSafeInteger(max) || max < TRUNCATED.length) {
    throw new RangeError(`truncate max must be an integer of at least ${TRUNCATED.length}`);
  }
  if (text.length <= max) return text;
  const room = text.slice(0, max - TRUNCATED.length);
  return `${room.slice(0, room.lastIndexOf("\n") + 1)}${TRUNCATED}`;
}
