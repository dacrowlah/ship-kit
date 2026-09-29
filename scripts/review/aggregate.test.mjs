import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { decodeStateMarker, encodeStateMarker } from "../lib/state-marker.mjs";
import { main as receiptMain } from "./receipt.mjs";
import { SEAT_SKILLS } from "./review-mode.mjs";
import {
  MAX_COMMENT_CHARS, MAX_MARKER_CHARS, MINING_HINT, WITHHELD,
  composeComment, decide, expectedMarker, hunkRanges, main,
} from "./aggregate.mjs";

const SCRIPT = fileURLToPath(new URL("./aggregate.mjs", import.meta.url));
const SEAT = "general";
const SKILL = SEAT_SKILLS[SEAT];
const MARKER = `${SKILL}@0.2.0:${"ab".repeat(8)}`;
const NONCE = "c".repeat(32);
const HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const SUPERPOWERS = "d".repeat(40);
const RUN = { nonce: NONCE, version: "0.2.0", superpowersSha: SUPERPOWERS };
const BT = "`";
const CREATED = "2026-01-01T00:00:00Z";

const tmp = () => mkdtempSync(join(tmpdir(), "aggregate-"));
const sha = (c) => c.repeat(40);

function body(overrides = {}) {
  return {
    verdict: "PASS", complete: true, unreviewed: [], summary: "Checked the change.",
    contract_nonce: NONCE, skill_marker: MARKER, ...overrides,
  };
}
const ddBody = (overrides = {}) => body({ findings: [], prior: [], ...overrides });
const receipt = (index, b = body(), extra = {}) => ({ index, seat: SEAT, body: b, ...extra });

function plan(overrides = {}) {
  return {
    mode: "full", enforced: true, count: 1, empty: false, override: false,
    mergeBase: MERGE_BASE, priors: [], notices: [], ...overrides,
  };
}
const ddPlan = (overrides = {}) => plan({ mode: "design-doc", ...overrides });

function decideWith(overrides = {}) {
  return decide({
    seat: SEAT, plan: plan(), planStatus: undefined, planResult: "success", run: RUN,
    receipts: [receipt(1)], expectedMarker: MARKER, ...overrides,
  });
}

function finding(overrides = {}) {
  return { severity: "BLOCKING", file: "docs/design/x.md", line: 3, finding: "Wrong.", ...overrides };
}
function prior(overrides = {}) {
  return { id: "p1", seat: 1, severity: "BLOCKING", file: "docs/design/x.md", line: 2, finding: "Earlier.", ...overrides };
}

// ------------------------------------------------------------------ decide

test("each status.json status passes through", () => {
  for (const status of ["fail-config", "needs-maintainer"]) {
    const out = decideWith({ planStatus: { status, reason: "why" } });
    assert.equal(out.status, status);
    assert.equal(out.complete, false);
    assert.deepEqual(out.findings, []);
  }
  // Even when the plan job reports failure, the recorded status wins.
  assert.equal(decideWith({ planStatus: { status: "fail-config" }, planResult: "failure" }).status, "fail-config");
});

test("a status.json holding anything else is fail-coverage", () => {
  for (const planStatus of [null, "fail-config", [], { status: "pass" }, { status: "override" }, { reason: "x" }]) {
    const out = decideWith({ planStatus });
    assert.equal(out.status, "fail-coverage", JSON.stringify(planStatus));
    assert.equal(out.complete, false);
  }
});

test("no plan artifact is fail-coverage", () => {
  const out = decideWith({ plan: null });
  assert.deepEqual(out, { status: "fail-coverage", complete: false, findings: [], perSeat: [] });
});

test("a malformed plan.json is fail-coverage", () => {
  const bad = [
    "text", [], plan({ mode: "other" }), plan({ enforced: "true" }), plan({ count: "1" }), plan({ count: -1 }),
    plan({ count: 33 }), plan({ count: 1.5 }), plan({ empty: "false" }), plan({ override: "false" }),
    plan({ mergeBase: "B".repeat(40) }), plan({ mergeBase: "abc" }), plan({ priors: {} }), plan({ priors: [null] }),
    plan({ empty: true, count: 1 }),
  ];
  for (const p of bad) assert.equal(decideWith({ plan: p }).status, "fail-coverage", JSON.stringify(p));
  assert.equal(decideWith({ plan: plan({ mergeBase: null }) }).status, "pass");
});

test("a failed plan job with an artifact is fail-coverage", () => {
  for (const planResult of ["failure", "cancelled", "skipped", "", undefined]) {
    const out = decideWith({ planResult });
    assert.equal(out.status, "fail-coverage", String(planResult));
    assert.equal(out.complete, false);
  }
});

test("override is override and never complete", () => {
  assert.deepEqual(decideWith({ plan: plan({ override: true }) }), { status: "override", complete: false, findings: [], perSeat: [] });
});

test("empty is pass", () => {
  const out = decideWith({ plan: plan({ empty: true, count: 0 }), receipts: [] });
  assert.deepEqual(out, { status: "pass", complete: true, findings: [], perSeat: [] });
});

test("a full-mode plan with no seats for a non-empty change is fail-coverage", () => {
  assert.equal(decideWith({ plan: plan({ count: 0 }), receipts: [] }).status, "fail-coverage");
});

test("a missing receipt, a null body, a duplicate index", () => {
  const two = plan({ count: 2 });
  const missing = decideWith({ plan: two, receipts: [receipt(1)] });
  assert.equal(missing.status, "fail-coverage");
  assert.equal(missing.perSeat[1].reason, "no receipt");
  assert.equal(missing.perSeat[0].ok, true);

  const nullBody = decideWith({ receipts: [receipt(1, null)] });
  assert.equal(nullBody.status, "fail-coverage");
  assert.equal(nullBody.perSeat[0].reason, "no seat output");

  const duplicate = decideWith({ receipts: [receipt(1), receipt(1, body({ verdict: "FAIL" }))] });
  assert.equal(duplicate.status, "fail-coverage");
  assert.equal(duplicate.perSeat[0].reason, "more than one receipt");
  assert.equal(duplicate.perSeat[0].body, null);
});

test("verdict \"pass\", complete \"true\", complete false", () => {
  for (const b of [body({ verdict: "pass" }), body({ verdict: undefined }), body({ complete: "true" }), body({ complete: false })]) {
    const out = decideWith({ receipts: [receipt(1, b)] });
    assert.equal(out.status, "fail-coverage", JSON.stringify(b));
    assert.equal(out.complete, false);
  }
});

test("nonce mismatch and marker mismatch", () => {
  const nonce = decideWith({ receipts: [receipt(1, body({ contract_nonce: "e".repeat(32) }))] });
  assert.equal(nonce.status, "fail-coverage");
  assert.equal(nonce.perSeat[0].reason, "contract nonce differs");

  const marker = decideWith({ receipts: [receipt(1, body({ skill_marker: `${SKILL}@0.2.0:${"cd".repeat(8)}` }))] });
  assert.equal(marker.status, "fail-coverage");
  assert.equal(marker.perSeat[0].reason, "skill marker differs");

  // An older release's marker, token and all.
  const older = decideWith({ receipts: [receipt(1, body({ skill_marker: `${SKILL}@0.1.0:${"ef".repeat(8)}` }))] });
  assert.equal(older.status, "fail-coverage");

  // With no expected marker, or no run.json, nothing can match.
  assert.equal(decideWith({ expectedMarker: null }).status, "fail-coverage");
  assert.equal(decideWith({ run: null }).status, "fail-coverage");
  assert.equal(decideWith({ run: { nonce: "short" }, receipts: [receipt(1, body({ contract_nonce: "short" }))] }).status, "fail-coverage");
});

test("a credential anywhere in a body withholds and fails coverage", () => {
  const cases = {
    summary: body({ summary: "found ghp_EXAMPLE in the log" }),
    finding: ddBody({ findings: [finding({ finding: "the key sk-ant-EXAMPLE leaks" })] }),
    key: { ...body(), "github_pat_EXAMPLE": "x" },
    unreviewed: body({ unreviewed: ["x-access-token:EXAMPLE"] }),
  };
  for (const [name, b] of Object.entries(cases)) {
    for (const p of [plan(), ddPlan()]) {
      const out = decideWith({ plan: p, receipts: [receipt(1, b)] });
      assert.equal(out.status, "fail-coverage", name);
      assert.equal(out.complete, false, name);
      assert.equal(out.perSeat[0].withheld, true, name);
      assert.equal(out.perSeat[0].body, null, name);
    }
  }
});

test("a credential formed only when fields are joined is withheld too", () => {
  const b = ddBody({ findings: [finding({ file: "x-access-token", line: 0, finding: "EXAMPLE" })] });
  const out = decideWith({ plan: ddPlan(), receipts: [receipt(1, b)] });
  assert.equal(out.status, "fail-coverage");
  assert.equal(out.perSeat[0].withheld, true);
});

test("a withheld receipt, or one naming another seat, fails coverage", () => {
  const withheld = decideWith({ receipts: [{ index: 1, seat: SEAT, body: null, withheld: true }] });
  assert.equal(withheld.status, "fail-coverage");
  assert.equal(withheld.perSeat[0].withheld, true);
  const other = decideWith({ receipts: [{ ...receipt(1), seat: "adversarial" }] });
  assert.equal(other.status, "fail-coverage");
  assert.equal(other.perSeat[0].reason, "receipt names another seat");
});

test("an unplanned receipt index is ignored", () => {
  const out = decideWith({
    receipts: [receipt(1), receipt(2, body({ verdict: "FAIL" })), receipt(2), receipt(0), { index: "1" }, null, "x", { seat: SEAT }],
  });
  assert.equal(out.status, "pass");
  assert.equal(out.complete, true);
  assert.equal(out.perSeat.length, 1);
});

test("full mode: all PASS is pass, one FAIL is fail-findings", () => {
  const pass = decideWith({ plan: plan({ count: 2 }), receipts: [receipt(1), receipt(2)] });
  assert.deepEqual({ status: pass.status, complete: pass.complete, findings: pass.findings }, { status: "pass", complete: true, findings: [] });

  const fail = decideWith({ plan: plan({ count: 3 }), receipts: [receipt(1), receipt(2, body({ verdict: "FAIL" })), receipt(3, body({ verdict: "FAIL" }))] });
  assert.equal(fail.status, "fail-findings");
  assert.equal(fail.complete, true);
  assert.deepEqual(fail.findings, [
    { severity: "BLOCKING", file: "", line: 0, finding: "seat 2 returned FAIL" },
    { severity: "BLOCKING", file: "", line: 0, finding: "seat 3 returned FAIL" },
  ]);
});

test("design-doc: missing findings is incomplete; FAIL with no finding and no unresolved prior is incomplete", () => {
  const noFindings = decideWith({ plan: ddPlan(), receipts: [receipt(1, body({ prior: [] }))] });
  assert.equal(noFindings.status, "fail-coverage");
  assert.equal(noFindings.perSeat[0].reason, "design-doc output lacks findings or prior");
  const noPrior = decideWith({ plan: ddPlan(), receipts: [receipt(1, body({ findings: [] }))] });
  assert.equal(noPrior.status, "fail-coverage");

  const bareFail = decideWith({ plan: ddPlan(), receipts: [receipt(1, ddBody({ verdict: "FAIL" }))] });
  assert.equal(bareFail.status, "fail-coverage");
  assert.equal(bareFail.perSeat[0].reason, "FAIL with no finding and no unresolved prior");

  // An UNRESOLVED entry for a prior this seat was not assigned does not count.
  const stray = decideWith({
    plan: ddPlan({ priors: [prior({ seat: 2 })], count: 2 }),
    receipts: [receipt(1, ddBody({ verdict: "FAIL", prior: [{ id: "p1", status: "UNRESOLVED", note: "n" }] })), receipt(2, ddBody())],
  });
  assert.equal(stray.status, "fail-coverage");

  // An UNRESOLVED assigned prior backs a FAIL.
  const backed = decideWith({
    plan: ddPlan({ priors: [prior()] }),
    receipts: [receipt(1, ddBody({ verdict: "FAIL", prior: [{ id: "p1", status: "UNRESOLVED", note: "still wrong" }] }))],
  });
  assert.equal(backed.status, "fail-findings");
  assert.deepEqual(backed.findings, [{ severity: "BLOCKING", file: "docs/design/x.md", line: 2, finding: "Earlier." }]);
});

test("NON-BLOCKING only passes; a missing severity blocks", () => {
  const nonBlocking = decideWith({
    plan: ddPlan(),
    receipts: [receipt(1, ddBody({ verdict: "FAIL", findings: [finding({ severity: "NON-BLOCKING" })] }))],
  });
  assert.equal(nonBlocking.status, "pass");
  assert.equal(nonBlocking.complete, true);
  assert.deepEqual(nonBlocking.findings, []);

  const missing = { file: "docs/design/x.md", line: 4, finding: "No severity given." };
  const blocks = decideWith({ plan: ddPlan(), receipts: [receipt(1, ddBody({ findings: [missing] }))] });
  assert.equal(blocks.status, "fail-findings");
  assert.deepEqual(blocks.findings, [{ severity: "BLOCKING", ...missing }]);

  const lower = decideWith({ plan: ddPlan(), receipts: [receipt(1, ddBody({ findings: [finding({ severity: "non-blocking" })] }))] });
  assert.equal(lower.status, "fail-findings");
  const junk = decideWith({ plan: ddPlan(), receipts: [receipt(1, ddBody({ findings: ["just text"] }))] });
  assert.equal(junk.status, "fail-findings");
  assert.deepEqual(junk.findings, [{ severity: "BLOCKING", file: "", line: 0, finding: "" }]);
});

test("a BLOCKING prior resolved by the wrong seat stays open", () => {
  const priors = [prior({ id: "p1", seat: 1 }), prior({ id: "p2", seat: 2, finding: "Second." })];
  const resolvedAll = { findings: [], prior: [{ id: "p1", status: "RESOLVED", note: "" }, { id: "p2", status: "RESOLVED", note: "" }] };
  // Seat 1 claims both; seat 2 claims neither.
  const wrong = decideWith({
    plan: ddPlan({ count: 2, priors }),
    receipts: [receipt(1, ddBody(resolvedAll)), receipt(2, ddBody())],
  });
  assert.equal(wrong.status, "fail-findings");
  assert.deepEqual(wrong.findings.map((f) => f.finding), ["Second."]);

  const right = decideWith({
    plan: ddPlan({ count: 2, priors }),
    receipts: [
      receipt(1, ddBody({ prior: [{ id: "p1", status: "RESOLVED", note: "" }] })),
      receipt(2, ddBody({ prior: [{ id: "p2", status: "RESOLVED", note: "" }] })),
    ],
  });
  assert.equal(right.status, "pass");

  // Conflicting entries for one id keep it open.
  const conflict = decideWith({
    plan: ddPlan({ priors: [prior()] }),
    receipts: [receipt(1, ddBody({ prior: [{ id: "p1", status: "RESOLVED", note: "" }, { id: "p1", status: "UNRESOLVED", note: "" }] }))],
  });
  assert.equal(conflict.status, "fail-findings");

  // An open NON-BLOCKING prior does not fail and is not carried.
  const soft = decideWith({ plan: ddPlan({ priors: [prior({ severity: "NON-BLOCKING" })] }), receipts: [receipt(1, ddBody())] });
  assert.equal(soft.status, "pass");
  assert.deepEqual(soft.findings, []);

  // A BLOCKING prior no seat holds stays open.
  const orphan = decideWith({ plan: ddPlan({ count: 0, priors: [prior({ seat: null })] }), receipts: [] });
  assert.equal(orphan.status, "fail-findings");
  assert.equal(orphan.complete, true);
});

test("design-doc state findings are the open BLOCKING findings, new and carried", () => {
  const out = decideWith({
    plan: ddPlan({ priors: [prior({ id: "p1" }), prior({ id: "p2", finding: "Fixed." })] }),
    receipts: [receipt(1, ddBody({
      verdict: "FAIL",
      findings: [finding({ finding: "New one.", extra: "dropped" }), finding({ severity: "NON-BLOCKING", finding: "Nit." })],
      prior: [{ id: "p2", status: "RESOLVED", note: "done" }],
    }))],
  });
  assert.equal(out.status, "fail-findings");
  assert.deepEqual(out.findings, [
    { severity: "BLOCKING", file: "docs/design/x.md", line: 3, finding: "New one." },
    { severity: "BLOCKING", file: "docs/design/x.md", line: 2, finding: "Earlier." },
  ]);
});

test("design-doc with nothing to review and no open prior passes", () => {
  const out = decideWith({ plan: ddPlan({ count: 0 }), receipts: [], run: null, expectedMarker: null });
  assert.deepEqual(out, { status: "pass", complete: true, findings: [], perSeat: [] });
});

test("complete is false for every status but pass and fail-findings", () => {
  const rows = [
    [{ planStatus: { status: "fail-config" } }, "fail-config", false],
    [{ planStatus: { status: "needs-maintainer" } }, "needs-maintainer", false],
    [{ plan: null }, "fail-coverage", false],
    [{ receipts: [] }, "fail-coverage", false],
    [{ plan: plan({ override: true }) }, "override", false],
    [{}, "pass", true],
    [{ receipts: [receipt(1, body({ verdict: "FAIL" }))] }, "fail-findings", true],
  ];
  for (const [input, status, complete] of rows) {
    const out = decideWith(input);
    assert.equal(out.status, status);
    assert.equal(out.complete, complete, status);
  }
});

// ------------------------------------------------------------ expectedMarker

test("expectedMarker reads the single well-formed marker line", () => {
  assert.equal(expectedMarker(`---\nname: x\n---\n\nText.\n\nskill_marker: ${MARKER}\n`), MARKER);
  assert.equal(expectedMarker(`skill_marker: ${MARKER}\r\n`), MARKER);
  assert.equal(expectedMarker("no marker here\n"), null);
  assert.equal(expectedMarker(`skill_marker: ${MARKER}\nskill_marker: ${MARKER}\n`), null);
  assert.equal(expectedMarker(`skill_marker:${MARKER}\n`), null);
  assert.equal(expectedMarker("skill_marker: \n"), null);
  assert.equal(expectedMarker(`skill_marker: ${SKILL}@0.2.0:short\n`), null);
});

// ---------------------------------------------------------------- hunkRanges

const PATCH = [
  "diff --git a/docs/a.md b/docs/a.md",
  "index 1111111..2222222 100644",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -1,3 +1,4 @@",
  " one",
  "+two",
  " three",
  " four",
  "@@ -10,2 +11 @@",
  "-gone",
  " kept",
  "diff --git a/plus.md b/plus.md",
  "--- a/plus.md",
  "+++ b/plus.md",
  "@@ -1,0 +1,2 @@",
  "+++ b/evil.md",
  "+@@ -1,1 +100,5 @@",
  "@@ -8 +10 @@",
  "-old",
  "+new",
  "diff --git a/gone.md b/gone.md",
  "deleted file mode 100644",
  "--- a/gone.md",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
  "diff --git a/a b.md b/a b.md",
  "--- a/a b.md\t",
  "+++ b/a b.md\t",
  "@@ -5,0 +6,2 @@",
  "+p",
  "+q",
  "\\ No newline at end of file",
  "diff --git \"a/caf\\303\\251.md\" \"b/caf\\303\\251.md\"",
  "--- \"a/caf\\303\\251.md\"",
  "+++ \"b/caf\\303\\251.md\"",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git \"a/n\\nl.md\" \"b/n\\nl.md\"",
  "+++ \"b/n\\nl.md\"",
  "@@ -0,0 +1 @@",
  "+z",
  "",
].join("\n");

test("hunkRanges reads each new file's hunk ranges", () => {
  const ranges = hunkRanges(PATCH);
  assert.deepEqual([...ranges.keys()].sort(), ["a b.md", "caf\u00e9.md", "docs/a.md", "n\nl.md", "plus.md"].sort());
  assert.deepEqual(ranges.get("docs/a.md"), [[1, 4], [11, 11]]);
  assert.deepEqual(ranges.get("plus.md"), [[1, 2], [10, 10]]);
  assert.deepEqual(ranges.get("a b.md"), [[6, 7]]);
  assert.deepEqual(ranges.get("caf\u00e9.md"), [[1, 1]]);
  assert.deepEqual(ranges.get("n\nl.md"), [[1, 1]]);
});

test("content lines shaped like headers are content", () => {
  const ranges = hunkRanges(PATCH);
  assert.equal(ranges.has("evil.md"), false);
  assert.deepEqual(ranges.get("plus.md"), [[1, 2], [10, 10]]);
});

test("hunkRanges skips paths it cannot read and malformed hunks", () => {
  const patch = [
    "diff --git \"a/x\" \"b/bad\\q.md\"",
    "+++ \"b/bad\\q.md\"",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git \"a/\\377.md\" \"b/\\377.md\"",
    "+++ \"b/\\377.md\"",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/open.md b/open.md",
    "+++ \"b/open.md",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/noprefix.md c/noprefix.md",
    "+++ c/noprefix.md",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/short.md b/short.md",
    "+++ b/short.md",
    "@@ -1,3 +1,3 @@",
    " a",
    "not a hunk line",
    "+++ b/late.md",
    "@@ -1 +1 @@",
    " a",
    "diff --git a/oct.md b/oct.md",
    "+++ \"b/\\1.md\"",
    "@@ -0,0 +1 @@",
    "+x",
    "",
  ].join("\n");
  const ranges = hunkRanges(patch);
  assert.deepEqual([...ranges.keys()], ["short.md"]);
  // A `+++ ` line after the file's first hunk names no file: the later hunk is still short.md's.
  assert.deepEqual(ranges.get("short.md"), [[1, 3], [1, 1]]);
  assert.deepEqual(hunkRanges(""), new Map());
  assert.throws(() => hunkRanges(null), TypeError);
});

// ----------------------------------------------------------- composeComment

function compose(overrides = {}) {
  const decision = overrides.decision ?? decideWith(overrides.decideInput ?? {});
  return composeComment({
    seat: SEAT, head: HEAD, runId: 900, mode: "full", enforced: true,
    status: decision.status, complete: decision.complete, findings: decision.findings, perSeat: decision.perSeat,
    mergeBase: MERGE_BASE, superpowersSha: SUPERPOWERS, planReason: null, rounds: null, notes: [],
    ...overrides.args,
  });
}

/** Every fenced block of a comment body: [openLineIndex, closeLineIndex, bar]. */
function fences(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})$/.exec(lines[i]);
    if (!open) continue;
    const bar = open[1];
    let j = i + 1;
    while (j < lines.length && !(lines[j].startsWith(bar) && /^`+$/.test(lines[j]))) j += 1;
    assert.ok(j < lines.length, `fence opened at line ${i} never closes`);
    out.push([i, j, bar]);
    i = j;
  }
  return out;
}

/** The body with every fenced block's contents removed. */
function outsideFences(text) {
  const lines = text.split("\n");
  const keep = new Array(lines.length).fill(true);
  for (const [open, close] of fences(text)) for (let k = open + 1; k < close; k += 1) keep[k] = false;
  return lines.filter((_, k) => keep[k]).join("\n");
}

test("the comment's first line is the state marker", () => {
  const { body: text, marker } = compose();
  assert.equal(text.split("\n")[0], marker);
  const decoded = decodeStateMarker(text);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.state, {
    v: 1, kind: SEAT, head: HEAD, mode: "full", complete: true, mergeBase: MERGE_BASE, findings: [], runId: 900,
  });
  assert.match(text, /ship-kit general review: pass/);
  assert.match(text, new RegExp(`superpowers ${SUPERPOWERS}`));
});

test("mentions, HTML and backticks in seat text are inert", () => {
  const summary = `ping @org/team and @someone <img src=x onerror=y> [x](javascript:y)\n${BT.repeat(5)}js\n<details>`;
  const b = ddBody({
    summary,
    unreviewed: ["@other/team <b>bold</b>"],
    findings: [finding({ finding: "@evil <script>" })],
    prior: [{ id: "p1", status: "RESOLVED", note: "@note <i>" }],
  });
  const { body: text } = compose({ decideInput: { plan: ddPlan({ priors: [prior()] }), receipts: [receipt(1, b)] }, args: { mode: "design-doc" } });
  const blocks = fences(text);
  // The open BLOCKING findings, then the seat's output.
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0][2], BT.repeat(3));
  assert.equal(blocks[1][2], BT.repeat(6));
  const outside = outsideFences(text);
  for (const needle of ["@org", "@someone", "@other", "@evil", "@note", "<img", "<b>", "<script>", "<details>", "<i>", "javascript:"]) {
    assert.ok(!outside.includes(needle), needle);
    assert.ok(text.includes(needle), `${needle} is shown inside the fence`);
  }
});

test("every fence is a top-level block", () => {
  const { body: text } = compose({
    decideInput: { plan: plan({ count: 2 }), receipts: [receipt(1), receipt(2, body({ summary: "second" }))] },
    args: { planReason: "reason text" },
  });
  const lines = text.split("\n");
  const blocks = fences(text);
  assert.equal(blocks.length, 3);
  for (const [open, close] of blocks) {
    assert.equal(lines[open - 1], "", "a blank line precedes each fence");
    assert.ok(close === lines.length - 1 || lines[close + 1] === "", "a blank line or the end follows each fence");
  }
});

test("a withheld seat shows the withheld line and none of its text", () => {
  const { body: text } = compose({
    decideInput: { plan: plan({ count: 2 }), receipts: [receipt(1, body({ summary: "leak ghp_EXAMPLE" })), receipt(2, null, { withheld: true })] },
  });
  assert.equal(text.split(WITHHELD).length - 1, 2);
  assert.ok(!text.includes("ghp_"));
  assert.ok(!text.includes("EXAMPLE"));
});

test("a seat that failed coverage still shows its text, labelled", () => {
  const { body: text } = compose({ decideInput: { receipts: [receipt(1, body({ skill_marker: "wrong", summary: "Looks fine." }))] } });
  assert.match(text, /### Seat 1: not counted \(skill marker differs\)/);
  assert.ok(text.includes("Looks fine."));
  const missing = compose({ decideInput: { receipts: [] } }).body;
  assert.match(missing, /### Seat 1: not counted \(no receipt\)/);
});

test("the comment stays under 65,536 characters with the marker intact", () => {
  const huge = (c) => `${c.repeat(200)}\n`.repeat(400);
  const receipts = [1, 2, 3, 4].map((i) => receipt(i, body({ summary: huge(String(i)), unreviewed: [huge("u")] })));
  const { body: text, marker } = compose({ decideInput: { plan: plan({ count: 4 }), receipts } });
  assert.ok(text.length <= MAX_COMMENT_CHARS, String(text.length));
  assert.equal(text.split("\n")[0], marker);
  assert.equal(decodeStateMarker(text).ok, true);
  const blocks = fences(text);
  assert.equal(blocks.length, 4);
  for (const [open, close] of blocks) assert.equal(text.split("\n")[close], text.split("\n")[open]);
  assert.ok(text.includes("[truncated]"));
});

test("a seat text of long backtick runs still fits, fenced", () => {
  const lines = Array.from({ length: 300 }, (_, i) => BT.repeat(i + 1)).join("\n");
  const receipts = [1, 2].map((i) => receipt(i, body({ summary: lines })));
  const { body: text } = compose({ decideInput: { plan: plan({ count: 2 }), receipts } });
  assert.ok(text.length <= MAX_COMMENT_CHARS);
  for (const [open, close, bar] of fences(text)) {
    const inner = text.split("\n").slice(open + 1, close);
    assert.ok(inner.every((line) => !(line.startsWith(bar) && /^`+$/.test(line))));
  }
});

test("a huge marker and a huge plan reason still fit", () => {
  const findings = Array.from({ length: 1000 }, (_, i) => finding({ finding: `f${i} ${"w".repeat(25)}` }));
  const decision = { status: "fail-findings", complete: true, findings, perSeat: [] };
  const { body: text } = compose({ decision, args: { planReason: "r".repeat(100000), mode: "design-doc" } });
  assert.ok(text.length <= MAX_COMMENT_CHARS);
  assert.equal(decodeStateMarker(text).ok, true);
});

test("an oversized marker is written incomplete", () => {
  for (const size of [40000, 60000]) {
    const findings = [finding({ finding: "x".repeat(size) })];
    const decision = { status: "fail-findings", complete: true, findings, perSeat: [] };
    const { body: text, marker } = compose({ decision, args: { mode: "design-doc" } });
    assert.ok(marker.length <= MAX_MARKER_CHARS);
    const decoded = decodeStateMarker(text);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.state.complete, false, String(size));
    assert.deepEqual(decoded.state.findings, []);
    assert.match(text, /too large to record/);
  }
  const small = compose({ decision: { status: "fail-findings", complete: true, findings: [finding()], perSeat: [] } });
  assert.equal(decodeStateMarker(small.body).state.complete, true);
});

test("the plan's reason, notes and the mining hint appear in the heading", () => {
  const { body: text } = compose({
    decision: { status: "needs-maintainer", complete: false, findings: [], perSeat: [] },
    args: { planReason: "comment /ship-kit-review with @maintainer", notes: ["A note."], rounds: 4, superpowersSha: null, enforced: false },
  });
  assert.ok(text.includes("A note."));
  assert.ok(text.includes(MINING_HINT));
  assert.match(text, /4 distinct heads/);
  assert.match(text, /superpowers unknown/);
  assert.match(text, /Enforced: false/);
  assert.ok(!outsideFences(text).includes("@maintainer"));
  const withheld = compose({
    decision: { status: "fail-config", complete: false, findings: [], perSeat: [] },
    args: { planReason: "token ghs_EXAMPLE" },
  }).body;
  assert.ok(!withheld.includes("ghs_"));
  assert.ok(withheld.includes(WITHHELD));
});

test("design-doc lists the open BLOCKING findings, new and carried", () => {
  const out = decideWith({
    plan: ddPlan({ priors: [prior({ id: "p3", finding: "Carried @someone." })] }),
    receipts: [receipt(1, ddBody({ findings: [finding({ finding: "Fresh." })] }))],
  });
  const { body: text } = compose({ decision: out, args: { mode: "design-doc" } });
  assert.match(text, /Open BLOCKING findings:/);
  assert.ok(text.includes("- [BLOCKING] docs/design/x.md:3 Fresh."));
  assert.ok(text.includes("- [BLOCKING] docs/design/x.md:2 Carried @someone."));
  assert.ok(!outsideFences(text).includes("@someone"));
  const full = compose({ decideInput: { receipts: [receipt(1, body({ verdict: "FAIL" }))] } }).body;
  assert.ok(!full.includes("Open BLOCKING findings:"));
  const leaked = compose({
    decision: { status: "fail-findings", complete: true, findings: [finding({ file: "x-access-token", line: 1, finding: "EXAMPLE" })], perSeat: [] },
    args: { mode: "design-doc" },
  }).body;
  assert.ok(leaked.includes(WITHHELD));
  assert.ok(!outsideFences(leaked).split("\n").slice(1).join("\n").includes("x-access-token"));
});

// --------------------------------------------------------------------- main

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function world({
  planJson = plan(), status, run = RUN, receipts = [receipt(1)], marker = MARKER, patches = {}, env = {},
} = {}) {
  const root = tmp();
  if (planJson !== null) writeJson(join(root, "review", "plan.json"), planJson);
  if (status !== undefined) writeJson(join(root, "review", "status.json"), status);
  if (run !== null) writeJson(join(root, "expect", "run.json"), run);
  receipts.forEach((r, i) => writeJson(join(root, "receipts", `ship-kit-receipt-${i + 1}-1`, "receipt.json"), r));
  for (const [n, text] of Object.entries(patches)) writeJson(join(root, "review", `seat-${n}.patch`), text);
  writeJson(join(root, "src", "skills", SKILL, "SKILL.md"), `---\nname: ${SKILL}\n---\n\nBody.\n\nskill_marker: ${marker}\n`);
  const output = join(root, "github-output");
  writeFileSync(output, "");
  return {
    root,
    output,
    env: {
      SHIP_KIT_ROOT: root, REPOSITORY: "Owner/Repo", PR_NUMBER: "7", SEAT, HEAD_SHA: HEAD,
      RUN_ID: "900", GITHUB_OUTPUT: output, PLAN_RESULT: "success", BASE_REF: "main", DEFAULT_BRANCH: "main", ...env,
    },
  };
}

function fakeGh({
  output, comments = [], commentPost = { status: 201, json: { id: 4242 } }, reviewPost = { status: 200, json: { id: 1 } },
  repo = { status: 200, json: { default_branch: "main" } }, runs = {}, artifacts = {}, listError = null,
} = {}) {
  const calls = [];
  const gh = {
    get(path) {
      calls.push({ op: "get", path });
      if (path === "repos/Owner/Repo") return repo;
      const match = /^repos\/Owner\/Repo\/actions\/runs\/(\d+)$/.exec(path);
      if (match && runs[match[1]]) return { status: 200, json: runs[match[1]] };
      return { status: 404, json: null };
    },
    list(path) {
      calls.push({ op: "list", path });
      if (listError) throw listError;
      return comments;
    },
    listKey(path) {
      calls.push({ op: "listKey", path });
      const match = /runs\/(\d+)\/artifacts$/.exec(path);
      return artifacts[match[1]] ?? [];
    },
    send(method, path, payload) {
      calls.push({ op: "send", method, path, payload, outputs: readFileSync(output, "utf8") });
      const response = path.endsWith("/reviews") ? reviewPost : commentPost;
      if (response instanceof Error) throw response;
      return response;
    },
    cli() {
      throw new Error("unexpected gh cli call");
    },
  };
  return { gh, calls };
}

function runMain(w, ghOptions = {}, deps = {}) {
  const { gh, calls } = fakeGh({ output: w.output, ...ghOptions });
  const errors = [];
  const code = main(w.env, { gh, download: () => { throw new Error("no download"); }, stderr: { write: (s) => errors.push(s) }, ...deps });
  const statePath = join(w.root, "state", "state.json");
  return {
    code,
    calls,
    errors: errors.join(""),
    outputs: readFileSync(w.output, "utf8"),
    state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null,
    posted: calls.find((c) => c.op === "send" && c.path.endsWith("/comments")),
    review: calls.find((c) => c.op === "send" && c.path.endsWith("/reviews")),
  };
}

test("a passing run writes outputs, posts the comment and records the state", () => {
  const w = world();
  const r = runMain(w);
  assert.equal(r.code, 0, r.errors);
  assert.equal(r.outputs, "status=pass\nenforced=true\nmode=full\n");
  assert.equal(r.posted.method, "POST");
  assert.equal(r.posted.path, "repos/Owner/Repo/issues/7/comments");
  const firstLine = r.posted.payload.body.split("\n")[0];
  assert.deepEqual(r.state, { commentId: 4242, marker: firstLine });
  assert.equal(decodeStateMarker(r.posted.payload.body).state.complete, true);
  assert.equal(r.review, undefined);
});

test("outputs are written before posting, and a failed post exits 1", () => {
  const w = world({ planJson: ddPlan(), receipts: [receipt(1, ddBody({ findings: [finding({ file: "docs/a.md", line: 2 })] }))], patches: { 1: PATCH } });
  const ok = runMain(w);
  assert.equal(ok.code, 0, ok.errors);
  const sends = ok.calls.filter((c) => c.op === "send");
  assert.deepEqual(sends.map((c) => c.path), ["repos/Owner/Repo/pulls/7/reviews", "repos/Owner/Repo/issues/7/comments"]);
  for (const send of sends) assert.equal(send.outputs, "status=fail-findings\nenforced=true\nmode=design-doc\n");

  for (const commentPost of [{ status: 500, json: null }, new Error("network"), { status: 201, json: {} }, { status: 201, json: { id: 0 } }]) {
    const failed = world();
    const r = runMain(failed, { commentPost });
    assert.equal(r.code, 1, JSON.stringify(commentPost));
    assert.equal(r.outputs, "status=pass\nenforced=true\nmode=full\n");
    assert.equal(r.state, null);
    assert.match(r.errors, /^aggregate: /);
  }
});

test("an inline finding outside the diff hunks is folded into the summary", () => {
  const inside = finding({ file: "docs/a.md", line: 3, finding: "Inside the hunk." });
  const outsideLine = finding({ file: "docs/a.md", line: 7, finding: "Outside every hunk." });
  const otherFile = finding({ file: "docs/other.md", line: 1, finding: "Not in the diff." });
  const header = finding({ file: "evil.md", line: 100, finding: "Planted header." });
  const w = world({
    planJson: ddPlan(),
    receipts: [receipt(1, ddBody({ findings: [inside, outsideLine, otherFile, header] }))],
    patches: { 1: PATCH },
  });
  const r = runMain(w);
  assert.equal(r.code, 0, r.errors);
  assert.equal(r.review.payload.event, "COMMENT");
  assert.equal(r.review.payload.commit_id, HEAD);
  assert.equal(typeof r.review.payload.body, "string");
  assert.deepEqual(r.review.payload.comments.map((c) => [c.path, c.line, c.side]), [["docs/a.md", 3, "RIGHT"]]);
  assert.equal(r.review.payload.comments[0].body, "```\n[BLOCKING] Inside the hunk.\n```");
  const summary = r.posted.payload.body;
  for (const text of ["Outside every hunk.", "Not in the diff.", "Planted header.", "Inside the hunk."]) assert.ok(summary.includes(text), text);
  assert.match(summary, /3 findings are outside the diff/);
});

test("a failed inline review adds a summary line and is not fatal", () => {
  for (const reviewPost of [{ status: 422, json: { message: "line not in diff" } }, new Error("network")]) {
    const w = world({ planJson: ddPlan(), receipts: [receipt(1, ddBody({ findings: [finding({ file: "docs/a.md", line: 2 })] }))], patches: { 1: PATCH } });
    const r = runMain(w, { reviewPost });
    assert.equal(r.code, 0, r.errors);
    assert.match(r.posted.payload.body, /The inline review could not be posted/);
    assert.ok(r.state);
  }
});

test("no inline review is posted for full mode, invalid seats or a missing patch", () => {
  const full = runMain(world({ receipts: [receipt(1, body({ verdict: "FAIL" }))], patches: { 1: PATCH } }));
  assert.equal(full.review, undefined);
  const invalid = runMain(world({
    planJson: ddPlan(), patches: { 1: PATCH },
    receipts: [receipt(1, ddBody({ skill_marker: "wrong", findings: [finding({ file: "docs/a.md", line: 2 })] }))],
  }));
  assert.equal(invalid.review, undefined);
  const noPatch = runMain(world({ planJson: ddPlan(), receipts: [receipt(1, ddBody({ findings: [finding({ file: "docs/a.md", line: 2 })] }))] }));
  assert.equal(noPatch.review, undefined);
  assert.equal(noPatch.code, 0);
});

test("a missing or non-JSON execution file yields body null and fail-coverage", () => {
  for (const text of [null, "not json"]) {
    const w = world({ receipts: [] });
    const exec = join(w.root, "execution.json");
    if (text !== null) writeFileSync(exec, text);
    const out = join(w.root, "receipts", "ship-kit-receipt-1-1");
    assert.equal(receiptMain(["1"], { EXECUTION_FILE: exec, SEAT, OUT_DIR: out }), 0);
    const r = runMain(w);
    assert.equal(r.code, 0, r.errors);
    assert.match(r.outputs, /^status=fail-coverage\n/);
    assert.match(r.posted.payload.body, /### Seat 1: not counted \(no seat output\)/);
    assert.equal(decodeStateMarker(r.posted.payload.body).state.complete, false);
  }
});

test("a credential-shaped body is never written to the receipt, and aggregate scores it fail-coverage", () => {
  const w = world({ receipts: [] });
  const exec = join(w.root, "execution.json");
  writeFileSync(exec, JSON.stringify([{ type: "result", structured_output: body({ summary: "ghp_EXAMPLE" }) }]));
  const out = join(w.root, "receipts", "ship-kit-receipt-1-1");
  assert.equal(receiptMain(["1"], { EXECUTION_FILE: exec, SEAT, OUT_DIR: out }), 0);
  const written = readFileSync(join(out, "receipt.json"), "utf8");
  assert.ok(!written.includes("ghp_"));
  assert.deepEqual(JSON.parse(written), { index: 1, seat: SEAT, body: null, withheld: true });
  const r = runMain(w);
  assert.match(r.outputs, /^status=fail-coverage\n/);
  assert.ok(r.posted.payload.body.includes(WITHHELD));
  assert.ok(!r.posted.payload.body.includes("ghp_"));
});

test("no plan artifact writes full mode, enforced and an incomplete state", () => {
  const w = world({ planJson: null, run: null, receipts: [] });
  const r = runMain(w);
  assert.equal(r.code, 0, r.errors);
  assert.equal(r.outputs, "status=fail-coverage\nenforced=true\nmode=full\n");
  const state = decodeStateMarker(r.posted.payload.body).state;
  assert.equal(state.mode, "full");
  assert.equal(state.complete, false);
  assert.equal(state.mergeBase, null);
});

test("complete is written false for every status but pass and fail-findings", () => {
  const rows = [
    [{ status: { status: "fail-config", reason: "bad" }, planJson: plan({ count: 0, enforced: false }) }, "fail-config", false, "false"],
    [{ status: { status: "needs-maintainer", reason: "fork" }, planJson: plan({ count: 0 }) }, "needs-maintainer", false, "true"],
    [{ status: "not json", planJson: null }, "fail-coverage", false, "true"],
    [{ receipts: [] }, "fail-coverage", false, "true"],
    [{}, "pass", true, "true"],
    [{ receipts: [receipt(1, body({ verdict: "FAIL" }))] }, "fail-findings", true, "true"],
  ];
  for (const [input, status, complete, enforced] of rows) {
    const r = runMain(world(input));
    assert.equal(r.code, 0, r.errors);
    assert.equal(r.outputs, `status=${status}\nenforced=${enforced}\nmode=full\n`);
    const state = decodeStateMarker(r.posted.payload.body).state;
    assert.equal(state.complete, complete, status);
    assert.equal(state.mode, "full");
  }
  const reason = runMain(world({ status: { status: "needs-maintainer", reason: "Comment /ship-kit-review <sha>." }, planJson: plan({ count: 0 }) }));
  assert.ok(reason.posted.payload.body.includes("Comment /ship-kit-review <sha>."));
});

// A trusted design-doc state per entry: its comment, run, artifact and payload.
function trusted(states) {
  const comments = [];
  const runs = {};
  const artifacts = {};
  const files = {};
  for (const s of states) {
    const line = encodeStateMarker({
      v: 1, kind: s.kind, head: s.head, mode: s.mode ?? "design-doc", complete: s.complete ?? true,
      mergeBase: null, findings: [], runId: s.runId,
    });
    comments.push({ id: s.id, body: `${line}\n\nsummary`, created_at: CREATED, updated_at: CREATED, user: { login: "github-actions[bot]", type: "Bot" } });
    if (s.forged) continue;
    runs[s.runId] = {
      id: s.runId, event: "pull_request_target", path: `.github/workflows/ship-kit-${s.kind}.yml`, repository: { full_name: "Owner/Repo" },
      pull_requests: Object.hasOwn(s, "pullRequests") ? s.pullRequests : [{ number: 7, base: { ref: "main" } }],
    };
    artifacts[s.runId] = [{ name: "ship-kit-state-1", expired: false }];
    files[`${s.runId}/ship-kit-state-1`] = JSON.stringify({ commentId: s.id, marker: line });
  }
  const download = (runId, name) => {
    const text = files[`${runId}/${name}`];
    if (text === undefined) throw new Error("no such artifact");
    return text;
  };
  return { ghOptions: { comments: [...comments, { id: 99, body: "plain comment" }, null], runs, artifacts }, download };
}

const ddWorld = (head) => world({ planJson: ddPlan(), receipts: [receipt(1, ddBody())], env: { HEAD_SHA: head } });
const hinted = (r) => r.posted.payload.body.includes(MINING_HINT);

test("two seats at one head count as one round; a fourth distinct head prints the hint", () => {
  const states = [
    { id: 1, kind: "general", head: sha("1"), runId: 101 },
    { id: 2, kind: "adversarial", head: sha("1"), runId: 102 },
    { id: 3, kind: "general", head: sha("2"), runId: 103 },
    { id: 4, kind: "adversarial", head: sha("2"), runId: 104 },
  ];
  const three = trusted(states);
  const r3 = runMain(ddWorld(sha("3")), three.ghOptions, { download: three.download });
  assert.equal(r3.code, 0, r3.errors);
  assert.equal(hinted(r3), false);

  const four = trusted([...states, { id: 5, kind: "general", head: sha("3"), runId: 105 }]);
  const r4 = runMain(ddWorld(sha("4")), four.ghOptions, { download: four.download });
  assert.equal(hinted(r4), true);
  assert.match(r4.posted.payload.body, /4 distinct heads/);
});

test("untrusted, incomplete and full-mode states and an incomplete run do not count", () => {
  const noise = trusted([
    { id: 1, kind: "general", head: sha("1"), runId: 101 },
    { id: 2, kind: "general", head: sha("2"), runId: 102 },
    { id: 3, kind: "general", head: sha("5"), runId: 103, forged: true },
    { id: 4, kind: "general", head: sha("6"), runId: 104, complete: false },
    { id: 5, kind: "general", head: sha("7"), runId: 105, mode: "full" },
  ]);
  const r = runMain(ddWorld(sha("4")), noise.ghOptions, { download: noise.download });
  assert.equal(r.code, 0, r.errors);
  assert.equal(hinted(r), false);

  const three = trusted([1, 2, 3].map((n) => ({ id: n, kind: "general", head: sha(String(n)), runId: 100 + n })));
  const incomplete = runMain(world({ planJson: ddPlan(), receipts: [], env: { HEAD_SHA: sha("4") } }), three.ghOptions, { download: three.download });
  assert.match(incomplete.outputs, /^status=fail-coverage/);
  assert.equal(hinted(incomplete), false);

  const fullMode = runMain(world({ env: { HEAD_SHA: sha("4") } }), three.ghOptions, { download: three.download });
  assert.equal(hinted(fullMode), false);
  assert.equal(fullMode.calls.some((c) => c.op === "list"), false);
});

test("a state counts only when its run names this pull request into the default branch", () => {
  const base = [1, 2].map((n) => ({ id: n, kind: "general", head: sha(String(n)), runId: 100 + n }));
  for (const pullRequests of [
    [{ number: 7, base: { ref: "evil" } }],
    [{ number: 8, base: { ref: "main" } }],
    [{ number: 7, base: { ref: "main" } }, { number: 9, base: { ref: "other" } }],
    [],
    undefined,
    ["7"],
    [{ number: 7 }],
  ]) {
    const states = trusted([...base, { id: 3, kind: "adversarial", head: sha("3"), runId: 103, pullRequests }]);
    const r = runMain(ddWorld(sha("4")), states.ghOptions, { download: states.download });
    assert.equal(hinted(r), false, JSON.stringify(pullRequests));
  }
  const bound = trusted([...base, { id: 3, kind: "adversarial", head: sha("3"), runId: 103 }]);
  assert.equal(hinted(runMain(ddWorld(sha("4")), bound.ghOptions, { download: bound.download })), true);
});

test("a run whose pull request is not into the default branch is fail-config and never complete", () => {
  for (const env of [{ BASE_REF: "evil" }, { BASE_REF: "" }, { DEFAULT_BRANCH: undefined }]) {
    const states = trusted([1, 2, 3].map((n) => ({ id: n, kind: "general", head: sha(String(n)), runId: 100 + n })));
    const w = world({ planJson: ddPlan(), receipts: [receipt(1, ddBody())], env: { HEAD_SHA: sha("4"), ...env } });
    const r = runMain(w, states.ghOptions, { download: states.download });
    assert.equal(r.code, 0, r.errors);
    assert.equal(r.outputs, "status=fail-config\nenforced=true\nmode=design-doc\n", JSON.stringify(env));
    const state = decodeStateMarker(r.posted.payload.body).state;
    assert.equal(state.complete, false);
    assert.deepEqual(state.findings, []);
    assert.match(r.posted.payload.body, /### Plan:|Plan:/);
    assert.equal(hinted(r), false);
    assert.equal(r.calls.some((c) => c.op === "list"), false);
  }
  assert.equal(decideWith({ baseError: "not the default branch" }).status, "fail-config");
  assert.equal(decideWith({ baseError: "not the default branch" }).complete, false);
});

test("a failed round count prints no hint and does not fail the run", () => {
  const states = trusted([1, 2, 3].map((n) => ({ id: n, kind: "general", head: sha(String(n)), runId: 100 + n })));
  const listFails = runMain(ddWorld(sha("4")), { ...states.ghOptions, listError: new Error("HTTP 502") }, { download: states.download });
  assert.equal(listFails.code, 0, listFails.errors);
  assert.equal(hinted(listFails), false);
  // Without an injected download, the real one runs gh's cli, which this fake refuses.
  const noDownload = runMain(ddWorld(sha("4")), states.ghOptions, { download: undefined });
  assert.equal(noDownload.code, 0, noDownload.errors);
  assert.equal(hinted(noDownload), false);
});

test("invalid environment exits 1 before any call", () => {
  const bad = [
    { SHIP_KIT_ROOT: "relative" }, { SHIP_KIT_ROOT: undefined }, { REPOSITORY: "no-slash" }, { PR_NUMBER: "0" },
    { PR_NUMBER: "7a" }, { SEAT: "reviewer" }, { HEAD_SHA: "A".repeat(40) }, { RUN_ID: "-1" }, { GITHUB_OUTPUT: "" },
  ];
  for (const env of bad) {
    const w = world({ env });
    const r = runMain(w);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.equal(r.calls.length, 0);
    assert.equal(r.state, null);
  }
});

test("an unwritable GITHUB_OUTPUT exits 1 before posting", () => {
  const w = world();
  const r = runMain({ ...w, env: { ...w.env, GITHUB_OUTPUT: join(w.root, "missing-dir", "out") } });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
});

test("receipts that are not a directory's receipt.json are not read", () => {
  const w = world({ receipts: [] });
  const dir = join(w.root, "receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "loose.json"), JSON.stringify(receipt(1)));
  mkdirSync(join(dir, "empty"));
  const real = join(w.root, "elsewhere");
  writeJson(join(real, "receipt.json"), receipt(1));
  symlinkSync(real, join(dir, "linked"));
  const r = runMain(w);
  assert.match(r.outputs, /^status=fail-coverage/);

  const linkedFile = world({ receipts: [] });
  const target = join(linkedFile.root, "target.json");
  writeFileSync(target, JSON.stringify(receipt(1)));
  mkdirSync(join(linkedFile.root, "receipts", "one"), { recursive: true });
  symlinkSync(target, join(linkedFile.root, "receipts", "one", "receipt.json"));
  assert.match(runMain(linkedFile).outputs, /^status=fail-coverage/);
});

test("an unreadable plan directory is fail-coverage", () => {
  const w = world({ planJson: null });
  writeFileSync(join(w.root, "review"), "a file where the plan directory should be");
  const r = runMain(w);
  assert.equal(r.code, 0, r.errors);
  assert.equal(r.outputs, "status=fail-coverage\nenforced=true\nmode=full\n");
});

test("main with no injected dependencies reports a bad environment", () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk));
  let code;
  try {
    code = main({ SHIP_KIT_ROOT: "relative" });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, 1);
  assert.match(written.join(""), /^aggregate: SHIP_KIT_ROOT/);
});

test("the script run as a command exits 1 on a bad environment", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { env: { ...isolatedEnv(), SHIP_KIT_ROOT: "" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aggregate: /);
});
