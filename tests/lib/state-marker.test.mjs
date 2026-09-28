import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKER_PREFIX, MAX_ENCODED_LENGTH, encodeStateMarker, decodeStateMarker,
} from "../../scripts/lib/state-marker.mjs";

const STATE = {
  v: 1,
  kind: "adversarial",
  head: "1".repeat(40),
  mode: "design-doc",
  complete: true,
  mergeBase: "2".repeat(40),
  findings: [{ id: "F1", severity: "BLOCKING" }],
  runId: 123456789,
};

function withPayload(json) {
  return `<!-- ${MARKER_PREFIX} ${Buffer.from(json, "utf8").toString("base64url")} -->`;
}

test("a marker round-trips and re-encodes byte for byte", () => {
  const line = encodeStateMarker(STATE);
  assert.match(line, /^<!-- ship-kit-review-state [A-Za-z0-9_-]+ -->$/);
  const decoded = decodeStateMarker(`${line}\n\nReview summary text`);
  assert.deepEqual(decoded, { ok: true, state: STATE });
  assert.equal(encodeStateMarker(decoded.state), line);
});

test("key order in the input does not change the encoding", () => {
  const shuffled = Object.fromEntries(Object.entries(STATE).reverse());
  assert.equal(encodeStateMarker(shuffled), encodeStateMarker(STATE));
});

test("mergeBase may be null", () => {
  const state = { ...STATE, mergeBase: null, mode: "full", findings: [] };
  assert.deepEqual(decodeStateMarker(encodeStateMarker(state)), { ok: true, state });
});

test("only the first line is read", () => {
  const body = `Summary first\n${encodeStateMarker(STATE)}`;
  assert.equal(decodeStateMarker(body).ok, false);
});

test("a CRLF comment body decodes", () => {
  assert.equal(decodeStateMarker(`${encodeStateMarker(STATE)}\r\nrest`).ok, true);
});

test("leading whitespace on the marker line is refused", () => {
  assert.equal(decodeStateMarker(` ${encodeStateMarker(STATE)}`).ok, false);
});

test("a marker under another prefix does not decode under the default", () => {
  const legacy = encodeStateMarker(STATE, { prefix: "legacy-review-state" });
  assert.equal(decodeStateMarker(legacy).ok, false);
  assert.equal(decodeStateMarker(legacy, { prefix: "legacy-review-state" }).ok, true);
});

const INVALID = [
  ["missing key", (s) => { const { runId, ...rest } = s; return rest; }],
  ["unknown key", (s) => ({ ...s, extra: 1 })],
  ["version 2", (s) => ({ ...s, v: 2 })],
  ["bad kind", (s) => ({ ...s, kind: "Adversarial" })],
  ["short head", (s) => ({ ...s, head: "abc" })],
  ["uppercase head", (s) => ({ ...s, head: "A".repeat(40) })],
  ["bad mode", (s) => ({ ...s, mode: "partial" })],
  ["string complete", (s) => ({ ...s, complete: "true" })],
  ["bad mergeBase", (s) => ({ ...s, mergeBase: "main" })],
  ["findings not array", (s) => ({ ...s, findings: {} })],
  ["finding not object", (s) => ({ ...s, findings: ["x"] })],
  ["zero runId", (s) => ({ ...s, runId: 0 })],
  ["string runId", (s) => ({ ...s, runId: "1" })],
];

for (const [name, mutate] of INVALID) {
  test(`decode refuses a state with ${name}`, () => {
    const result = decodeStateMarker(withPayload(JSON.stringify(mutate(STATE))));
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  });
  test(`encode refuses a state with ${name}`, () => {
    assert.throws(() => encodeStateMarker(mutate(STATE)), TypeError);
  });
}

test("a JSON array payload is refused", () => {
  assert.equal(decodeStateMarker(withPayload("[]")).ok, false);
});

test("a non-JSON payload is refused", () => {
  assert.equal(decodeStateMarker(withPayload("{oops")).ok, false);
});

test("padding and non-base64url characters are refused", () => {
  const line = encodeStateMarker(STATE);
  assert.equal(decodeStateMarker(line.replace(" -->", "= -->")).ok, false);
  assert.equal(decodeStateMarker(line.replace(/ [A-Za-z0-9_-]+ -->$/, " abc+/ -->")).ok, false);
});

test("a non-canonical base64url payload is refused", () => {
  // Pad kind until the JSON is 1 mod 3 bytes long: the last base64url
  // character then carries 4 unused bits, so bumping it by one changes
  // the text but not the decoded bytes.
  let state = STATE;
  for (let pad = ""; Buffer.byteLength(JSON.stringify(state)) % 3 !== 1; pad += "x") {
    state = { ...STATE, kind: `k${pad}` };
  }
  const line = encodeStateMarker(state);
  const payload = line.split(" ")[2];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const tweaked = payload.slice(0, -1) + alphabet[alphabet.indexOf(payload.at(-1)) + 1];
  assert.deepEqual(decodeStateMarker(line.replace(payload, tweaked)), {
    ok: false,
    reason: "payload is not canonical base64url",
  });
});

test("an over-long payload is refused", () => {
  const line = `<!-- ${MARKER_PREFIX} ${"A".repeat(MAX_ENCODED_LENGTH + 4)} -->`;
  assert.equal(decodeStateMarker(line).ok, false);
});

test("a non-string body is refused, and a bad prefix option throws", () => {
  assert.equal(decodeStateMarker(undefined).ok, false);
  assert.throws(() => decodeStateMarker("x", { prefix: "bad prefix" }), TypeError);
});
