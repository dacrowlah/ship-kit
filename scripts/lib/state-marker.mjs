// Encodes and decodes review state markers: the first line of an
// aggregate comment, `<!-- ship-kit-review-state <base64url JSON> -->`.
// This is the codec only. It says nothing about whether a marker can be
// trusted; a decoded marker is data until a trust check accepts it.

export const MARKER_PREFIX = "ship-kit-review-state";
export const MAX_ENCODED_LENGTH = 65536;

const KEYS = ["v", "kind", "head", "mode", "complete", "mergeBase", "findings", "runId"];
const SHA = /^[0-9a-f]{40}$/;
const KIND = /^[a-z][a-z0-9-]{0,63}$/;
const MODES = ["full", "design-doc"];
const PREFIX = /^[a-z][a-z0-9-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {string|null} the reason the state is invalid, or null */
function invalidReason(state) {
  if (!isPlainObject(state)) return "state is not an object";
  const keys = Object.keys(state);
  const missing = KEYS.filter((k) => !keys.includes(k));
  if (missing.length) return `missing key(s): ${missing.join(", ")}`;
  const extra = keys.filter((k) => !KEYS.includes(k));
  if (extra.length) return `unknown key(s): ${extra.join(", ")}`;
  if (state.v !== 1) return `unsupported version: ${JSON.stringify(state.v)}`;
  if (typeof state.kind !== "string" || !KIND.test(state.kind)) return "kind is invalid";
  if (typeof state.head !== "string" || !SHA.test(state.head)) return "head is not a 40-hex SHA";
  if (!MODES.includes(state.mode)) return "mode is invalid";
  if (typeof state.complete !== "boolean") return "complete is not a boolean";
  if (state.mergeBase !== null && (typeof state.mergeBase !== "string" || !SHA.test(state.mergeBase))) {
    return "mergeBase is neither null nor a 40-hex SHA";
  }
  if (!Array.isArray(state.findings) || !state.findings.every(isPlainObject)) {
    return "findings is not an array of objects";
  }
  if (!Number.isSafeInteger(state.runId) || state.runId <= 0) return "runId is not a positive integer";
  return null;
}

function checkPrefix(prefix) {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) {
    throw new TypeError(`invalid marker prefix: ${JSON.stringify(prefix)}`);
  }
}

/**
 * @param {{v:1,kind:string,head:string,mode:"full"|"design-doc",complete:boolean,mergeBase:string|null,findings:object[],runId:number}} state
 * @param {{prefix?: string}} [options]
 * @returns {string} one line, no trailing newline
 */
export function encodeStateMarker(state, { prefix = MARKER_PREFIX } = {}) {
  checkPrefix(prefix);
  const reason = invalidReason(state);
  if (reason) throw new TypeError(`invalid state: ${reason}`);
  const ordered = Object.fromEntries(KEYS.map((k) => [k, state[k]]));
  const encoded = Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
  if (encoded.length > MAX_ENCODED_LENGTH) throw new RangeError("encoded state exceeds the length cap");
  return `<!-- ${prefix} ${encoded} -->`;
}

/**
 * Reads only the first line of `body`.
 * @param {string} body a comment body
 * @param {{prefix?: string}} [options]
 * @returns {{ok: true, state: object} | {ok: false, reason: string}}
 */
export function decodeStateMarker(body, { prefix = MARKER_PREFIX } = {}) {
  checkPrefix(prefix);
  if (typeof body !== "string") return { ok: false, reason: "body is not a string" };
  const firstLine = body.split("\n", 1)[0].replace(/\r$/, "");
  const opening = `<!-- ${prefix} `;
  if (!firstLine.startsWith(opening) || !firstLine.endsWith(" -->")) {
    return { ok: false, reason: "first line is not a state marker" };
  }
  const encoded = firstLine.slice(opening.length, -" -->".length);
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, reason: "payload is not base64url" };
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    return { ok: false, reason: "payload is not canonical base64url" };
  }
  let state;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  const reason = invalidReason(state);
  if (reason) return { ok: false, reason };
  return { ok: true, state };
}
