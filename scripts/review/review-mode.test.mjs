import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL, DESIGN_DOC, BLOCKING, NON_BLOCKING, SEATS, SEAT_SKILLS,
  classifyMode, schemaFor, severityOf, normalizeFinding, findReviewBase, markerLine,
} from "./review-mode.mjs";

test("constants match the design's literal values", () => {
  assert.equal(FULL, "full");
  assert.equal(DESIGN_DOC, "design-doc");
  assert.equal(BLOCKING, "BLOCKING");
  assert.equal(NON_BLOCKING, "NON-BLOCKING");
  assert.deepEqual(SEATS, ["general", "adversarial", "security", "test-integrity"]);
  assert.deepEqual(SEAT_SKILLS, {
    general: "reviewing-for-correctness",
    adversarial: "hunting-defect-shapes",
    security: "reviewing-security",
    "test-integrity": "reviewing-test-integrity",
  });
});

test("classifyMode: every path under the configured dirs is design-doc", () => {
  assert.equal(
    classifyMode(["docs/design/a.md", "docs/design/sub/b.md"], ["docs/design/"]),
    DESIGN_DOC,
  );
});

test("classifyMode: one path outside the configured dirs falls back to full", () => {
  assert.equal(
    classifyMode(["docs/design/a.md", "src/index.mjs"], ["docs/design/"]),
    FULL,
  );
});

test("classifyMode: a path that merely shares a prefix with the dir, without the separator, is not under it", () => {
  assert.equal(classifyMode(["docs/design-notes.sh"], ["docs/design/"]), FULL);
});

test("classifyMode: an empty path list is full mode", () => {
  assert.equal(classifyMode([], ["docs/design/"]), FULL);
});

test("classifyMode: no configured dirs is full mode, regardless of paths", () => {
  assert.equal(classifyMode(["docs/design/a.md"], []), FULL);
});

test("classifyMode: a dir without a trailing slash throws", () => {
  assert.throws(() => classifyMode(["docs/design/a.md"], ["docs/design"]), TypeError);
});

test("classifyMode: a non-array dirs throws", () => {
  assert.throws(() => classifyMode([], null), TypeError);
});

function collectFields(schema) {
  const props = Object.keys(schema.properties);
  return { props, required: schema.required };
}

test("schemaFor: full mode schema has no findings/prior and is valid JSON with no single quote", () => {
  const raw = schemaFor(FULL);
  assert.equal(raw.includes("'"), false);
  const schema = JSON.parse(raw);
  const { props, required } = collectFields(schema);
  assert.deepEqual(props.sort(), [
    "complete", "contract_nonce", "skill_marker", "summary", "unreviewed", "verdict",
  ]);
  assert.deepEqual(required.slice().sort(), props.slice().sort());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.contract_nonce.pattern, "^[0-9a-f]{32}$");
  assert.deepEqual(schema.properties.verdict.enum, ["PASS", "FAIL"]);
});

test("schemaFor: design-doc mode adds findings and prior, still no single quote, required equals every property", () => {
  const raw = schemaFor(DESIGN_DOC);
  assert.equal(raw.includes("'"), false);
  const schema = JSON.parse(raw);
  const { props, required } = collectFields(schema);
  assert.deepEqual(props.sort(), [
    "complete", "contract_nonce", "findings", "prior", "skill_marker", "summary", "unreviewed", "verdict",
  ]);
  assert.deepEqual(required.slice().sort(), props.slice().sort());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual(schema.properties.findings.items.required, ["severity", "file", "line", "finding"]);
  assert.equal(schema.properties.prior.items.additionalProperties, false);
  assert.deepEqual(schema.properties.prior.items.properties.status.enum, ["RESOLVED", "UNRESOLVED"]);
});

test("schemaFor: byte-identical across calls, for each mode", () => {
  assert.equal(schemaFor(FULL), schemaFor(FULL));
  assert.equal(schemaFor(DESIGN_DOC), schemaFor(DESIGN_DOC));
});

test("schemaFor: an unknown mode throws", () => {
  assert.throws(() => schemaFor("bogus"), TypeError);
});

test("severityOf: the exact literal NON-BLOCKING is non-blocking", () => {
  assert.equal(severityOf("NON-BLOCKING"), NON_BLOCKING);
});

test("severityOf: a differently-cased spelling is blocking", () => {
  assert.equal(severityOf("non-blocking"), BLOCKING);
});

test("severityOf: a missing value is blocking", () => {
  assert.equal(severityOf(undefined), BLOCKING);
});

test("severityOf: null is blocking", () => {
  assert.equal(severityOf(null), BLOCKING);
});

test("severityOf: an unrelated string is blocking", () => {
  assert.equal(severityOf("BLOCKER"), BLOCKING);
});

test("normalizeFinding: a well-formed finding round-trips", () => {
  assert.deepEqual(
    normalizeFinding({ severity: "NON-BLOCKING", file: "a.md", line: 3, finding: "text" }),
    { severity: NON_BLOCKING, file: "a.md", line: 3, finding: "text" },
  );
});

test("normalizeFinding: a malformed finding fails closed to safe, blocking defaults", () => {
  assert.deepEqual(
    normalizeFinding({ severity: "whatever", file: 5, line: -1, finding: null }),
    { severity: BLOCKING, file: "", line: 0, finding: "" },
  );
});

test("normalizeFinding: a non-object input fails closed entirely", () => {
  assert.deepEqual(normalizeFinding(null), { severity: BLOCKING, file: "", line: 0, finding: "" });
  assert.deepEqual(normalizeFinding("x"), { severity: BLOCKING, file: "", line: 0, finding: "" });
});

const HEAD = "h".repeat(40);

function state(overrides) {
  return {
    v: 1, kind: "general", head: "a".repeat(40), mode: "full", complete: true,
    mergeBase: null, findings: [], runId: 1, ...overrides,
  };
}

test("findReviewBase: an incomplete run is never a base", () => {
  const states = [state({ complete: false, head: HEAD })];
  const result = findReviewBase(states, "general", { head: HEAD, isAncestor: () => true });
  assert.equal(result, null);
});

test("findReviewBase: a state of another kind is excluded", () => {
  const states = [state({ kind: "adversarial", head: HEAD })];
  const result = findReviewBase(states, "general", { head: HEAD, isAncestor: () => true });
  assert.equal(result, null);
});

test("findReviewBase: isAncestor throwing counts as not an ancestor", () => {
  const states = [state({ head: "b".repeat(40) })];
  const isAncestor = () => { throw new Error("git exploded"); };
  const result = findReviewBase(states, "general", { head: HEAD, isAncestor });
  assert.equal(result, null);
});

test("findReviewBase: a head that is not an ancestor is excluded", () => {
  const states = [state({ head: "b".repeat(40) })];
  const result = findReviewBase(states, "general", { head: HEAD, isAncestor: () => false });
  assert.equal(result, null);
});

test("findReviewBase: two states of one head take the later (by comment order)", () => {
  const same = "c".repeat(40);
  const older = state({ head: same, runId: 1 });
  const newer = state({ head: same, runId: 2 });
  const result = findReviewBase([older, newer], "general", { head: HEAD, isAncestor: () => true });
  assert.equal(result, newer);
});

test("findReviewBase: ancestry orders two distinct heads, newest wins", () => {
  const earlyHead = "d".repeat(40);
  const laterHead = "e".repeat(40);
  const early = state({ head: earlyHead, runId: 1 });
  const later = state({ head: laterHead, runId: 2 });
  // early's head is an ancestor of later's head, and both are ancestors of HEAD.
  const isAncestor = (candidate, of) => {
    if (candidate === earlyHead && of === laterHead) return true;
    if (candidate === earlyHead && of === HEAD) return true;
    if (candidate === laterHead && of === HEAD) return true;
    return false;
  };
  // States listed in comment order: later-appearing comment (early state) came first,
  // ancestry alone must pick "later" as the newest regardless of position.
  const result = findReviewBase([later, early], "general", { head: HEAD, isAncestor });
  assert.equal(result, later);
});

test("findReviewBase: diverged states that ancestry cannot order fall back to comment order", () => {
  const headA = "f".repeat(40);
  const headB = "1".repeat(40);
  const a = state({ head: headA, runId: 1 });
  const b = state({ head: headB, runId: 2 });
  // Neither head is an ancestor of the other; both are ancestors of HEAD.
  const isAncestor = (candidate, of) => of === HEAD;
  const result = findReviewBase([a, b], "general", { head: HEAD, isAncestor });
  assert.equal(result, b);
});

test("markerLine: no marker line returns null", () => {
  assert.equal(markerLine("---\nname: x\n---\nbody text\n"), null);
});

test("markerLine: exactly one marker line is returned", () => {
  const text = "---\nname: x\n---\nskill_marker: reviewing-for-correctness@0.2.0:abcdef0123456789\nmore\n";
  assert.equal(markerLine(text), "skill_marker: reviewing-for-correctness@0.2.0:abcdef0123456789");
});

test("markerLine: two marker lines returns null", () => {
  const text = "skill_marker: a@1:aaaa\nskill_marker: b@1:bbbb\n";
  assert.equal(markerLine(text), null);
});
