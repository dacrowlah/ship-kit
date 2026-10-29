#!/usr/bin/env node
// The review workflow's aggregate job (design 6.3 aggregate steps 1 to 4,
// 8.2 to 8.4): decides one seat's status from the plan and the seat
// receipts, fails closed, writes the job outputs, then publishes the
// result as a comment whose first line is the state marker, and records
// the comment id and the marker for the state artifact.
//
// Trust (design 20.1): the plan artifact, the expected nonce (expect/) and
// the receipts are this run's own artifacts, written by ship-kit's own
// steps; the expected skill marker is read from ship-kit's source at the
// workflow's commit (src/), which no seat can read. Seat output is data: it
// decides the verdict only through the checks below, and it is posted only
// after the inert rendering of inert.mjs, never when it resembles a
// credential. A run for a pull request whose base is not the default branch
// ran that branch's copy of the caller, so its result is fail-config and
// its state is never complete. Prior states count (the mining hint) only
// when trustState binds them to a caller run and that run's own record
// names this pull request with the default branch as its base.
//
// Order (ruling 39): the outputs are written first; then the inline review
// (design-doc findings inside the diff hunks; a failure is a summary line),
// then the summary comment (a failure exits 1, which the gate treats as a
// failure), then state/state.json. The comment is never edited afterwards:
// an edited comment is untrusted forever.
//
// Environment (strings, from the workflow's env: only): SHIP_KIT_ROOT,
// REPOSITORY, PR_NUMBER, SEAT, HEAD_SHA, RUN_ID, GITHUB_OUTPUT, PLAN_RESULT
// (the plan job's result), BASE_REF and DEFAULT_BRANCH (the event's
// pull_request.base.ref and repository.default_branch), GH_TOKEN (read by
// gh). Reads under SHIP_KIT_ROOT: review/ (the plan artifact, which may be
// absent), expect/run.json, receipts/*/receipt.json and
// src/skills/<seat skill>/SKILL.md.

import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { api, makeGh, repoSlug } from "../lib/gh.mjs";
import { decodeStateMarker, encodeStateMarker } from "../lib/state-marker.mjs";
import { anyCredential, credentialLike, fence, fenceWithin } from "./inert.mjs";
import {
  BLOCKING, DESIGN_DOC, FULL, SEATS, SEAT_SKILLS, markerLine, normalizeFinding, severityOf,
} from "./review-mode.mjs";
import { collectTrustedStates, makeDownload, makeTrustState } from "./trust-state.mjs";

export const MAX_COMMENT_CHARS = 65536;
/** Ruling 40: a longer marker is written with complete false and no findings. */
export const MAX_MARKER_CHARS = 30000;
/** Design 8.4: the hint prints when complete design-doc rounds exceed this. */
export const ROUND_HINT_AFTER = 3;
export const WITHHELD = "withheld: output resembled a credential";
export const MINING_HINT = "Mining hint:";

/** The config schema's maxSeats maximum. */
const MAX_SEATS = 32;
const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_INLINE_CHARS = 4000;
const PLAN_STATUSES = ["fail-config", "needs-maintainer"];
const SHA = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const MARKER_VALUE = /^[a-z0-9][a-z0-9-]*@[^\s:]+:[0-9a-f]{16}$/;
const MARKER_PREFIX = "skill_marker: ";
const POSITIVE = /^[1-9][0-9]{0,15}$/;
const HUNK = /^@@ -\d{1,9}(?:,\d{1,9})? \+(\d{1,9})(?:,(\d{1,9}))? @@/;
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 };

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function result(status, complete = false, findings = [], perSeat = []) {
  return { status, complete, findings, perSeat };
}

/** @returns {boolean} true for a plan.json aggregate can act on */
function validPlan(plan) {
  return isPlainObject(plan)
    && (plan.mode === FULL || plan.mode === DESIGN_DOC)
    && typeof plan.enforced === "boolean"
    && Number.isSafeInteger(plan.count) && plan.count >= 0 && plan.count <= MAX_SEATS
    && typeof plan.empty === "boolean"
    && typeof plan.override === "boolean"
    && (plan.mergeBase === null || (typeof plan.mergeBase === "string" && SHA.test(plan.mergeBase)))
    && Array.isArray(plan.priors) && plan.priors.every(isPlainObject)
    && !(plan.empty && plan.count !== 0);
}

/**
 * The mode, enforced value and merge base the outputs and the marker carry:
 * the plan's recorded values, or full, enforced and none without a usable plan.
 * @param {unknown} plan
 * @returns {{mode: "full"|"design-doc", enforced: boolean, mergeBase: string|null}}
 */
export function planView(plan) {
  if (!validPlan(plan)) return { mode: FULL, enforced: true, mergeBase: null };
  return { mode: plan.mode, enforced: plan.enforced, mergeBase: plan.mergeBase };
}

/**
 * The value of a SKILL.md's single `skill_marker: ` line, or null when it
 * has none, more than one, or a malformed one.
 * @param {string} skillText
 * @returns {string|null}
 */
export function expectedMarker(skillText) {
  const line = markerLine(skillText);
  if (line === null || !line.startsWith(MARKER_PREFIX)) return null;
  const value = line.slice(MARKER_PREFIX.length);
  return MARKER_VALUE.test(value) ? value : null;
}

function text(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return value === undefined ? "(missing)" : "(not a string)";
}

function findingLine(finding) {
  const where = finding.file === "" ? "" : `${finding.file}:${finding.line} `;
  return `- [${finding.severity}] ${where}${finding.finding}`;
}

function listLines(value, line) {
  if (!Array.isArray(value)) return [value === undefined ? "(missing)" : "(not a list)"];
  return value.length === 0 ? ["(none)"] : value.map(line);
}

/**
 * The plain text a seat's output is shown as, before fencing. Credential
 * screening runs over this text too, so fields joined here cannot form a
 * credential-shaped string that no single field held.
 * @param {object} body
 * @returns {string}
 */
function seatText(body) {
  const lines = [`Verdict: ${text(body.verdict)}`, `Complete: ${text(body.complete)}`, "Summary:", text(body.summary), "Unreviewed:"];
  lines.push(...listLines(body.unreviewed, (item) => `- ${text(item)}`));
  if (Object.hasOwn(body, "findings")) {
    lines.push("Findings:", ...listLines(body.findings, (f) => findingLine(normalizeFinding(f))));
  }
  if (Object.hasOwn(body, "prior")) {
    lines.push("Prior findings:", ...listLines(body.prior, (p) => {
      const entry = isPlainObject(p) ? p : {};
      return `- ${text(entry.id)} ${text(entry.status)}: ${text(entry.note)}`;
    }));
  }
  return lines.join("\n");
}

function withholds(body) {
  return anyCredential(body) || credentialLike(seatText(body));
}

/** Design 8.3: anything but an explicit NON-BLOCKING blocks. */
const isBlocking = (finding) => severityOf(finding.severity) === BLOCKING;

function priorsOf(plan) {
  return plan.mode === DESIGN_DOC ? plan.priors : [];
}

/** @returns {string|null} why this receipt does not count, or null */
function coverageError({ body, plan, run, expected, index }) {
  if (body.verdict !== "PASS" && body.verdict !== "FAIL") return "verdict is not PASS or FAIL";
  if (body.complete !== true) return "the seat reported its review incomplete";
  if (!isPlainObject(run) || typeof run.nonce !== "string" || !NONCE.test(run.nonce) || body.contract_nonce !== run.nonce) {
    return "contract nonce differs";
  }
  if (expected === null || body.skill_marker !== expected) return "skill marker differs";
  if (plan.mode !== DESIGN_DOC) return null;
  if (!Array.isArray(body.findings) || !Array.isArray(body.prior)) return "design-doc output lacks findings or prior";
  const assigned = new Set(priorsOf(plan).filter((p) => p.seat === index).map((p) => p.id));
  const unresolved = body.prior.some((p) => isPlainObject(p) && p.status === "UNRESOLVED" && assigned.has(p.id));
  if (body.verdict === "FAIL" && body.findings.length === 0 && !unresolved) return "FAIL with no finding and no unresolved prior";
  return null;
}

/** One planned seat's coverage: {index, ok, reason, withheld, body}. */
function seatCoverage({ index, receipts, seat, plan, run, expected }) {
  const entry = (ok, reason, body = null, withheld = false) => ({ index, ok, reason, withheld, body });
  if (receipts.length === 0) return entry(false, "no receipt");
  if (receipts.length > 1) return entry(false, "more than one receipt");
  const [receipt] = receipts;
  if (receipt.seat !== seat) return entry(false, "receipt names another seat");
  if (receipt.withheld === true) return entry(false, "withheld", null, true);
  const { body } = receipt;
  if (!isPlainObject(body)) return entry(false, "no seat output");
  if (withholds(body)) return entry(false, "withheld", null, true);
  const reason = coverageError({ body, plan, run, expected, index });
  return entry(reason === null, reason, body);
}

/** Design-doc open findings: BLOCKING new ones, then BLOCKING priors their assigned seat did not resolve. */
function openFindings(plan, perSeat) {
  const fresh = perSeat.flatMap((s) => s.body.findings.filter((f) => isBlocking(isPlainObject(f) ? f : {})).map(normalizeFinding));
  const carried = priorsOf(plan).filter(isBlocking).filter((prior) => {
    const holder = perSeat.find((s) => s.index === prior.seat);
    if (holder === undefined) return true;
    const entries = holder.body.prior.filter((p) => isPlainObject(p) && p.id === prior.id);
    return !(entries.length > 0 && entries.every((p) => p.status === "RESOLVED"));
  }).map(normalizeFinding);
  return [...fresh, ...carried];
}

/**
 * The fail-closed verdict (design 6.3 aggregate step 2, 8.3; ruling 7).
 * @param {object} input
 * @param {string} input.seat the seat under review
 * @param {string|null} [input.baseError] why the run's base cannot be trusted, or null
 * @param {unknown} input.plan plan.json, or null when there is no plan artifact
 * @param {unknown} input.planStatus status.json: undefined when absent, null when unreadable
 * @param {unknown} input.planResult the plan job's result
 * @param {unknown} input.run expect/run.json, or null
 * @param {unknown[]} input.receipts every receipt found
 * @param {string|null} input.expectedMarker
 * @returns {{status: string, complete: boolean, findings: object[], perSeat: object[]}}
 */
export function decide({ seat, baseError = null, plan, planStatus, planResult, run, receipts, expectedMarker: expected }) {
  if (baseError !== null) return result("fail-config");
  if (planStatus !== undefined) {
    const status = isPlainObject(planStatus) ? planStatus.status : undefined;
    return result(PLAN_STATUSES.includes(status) ? status : "fail-coverage");
  }
  if (!validPlan(plan) || planResult !== "success") return result("fail-coverage");
  if (plan.override === true) return result("override");
  if (plan.empty === true) return result("pass", true);
  if (plan.mode === FULL && plan.count === 0) return result("fail-coverage");

  const byIndex = new Map();
  for (const receipt of receipts) {
    if (!isPlainObject(receipt) || !Number.isSafeInteger(receipt.index)) continue;
    if (!byIndex.has(receipt.index)) byIndex.set(receipt.index, []);
    byIndex.get(receipt.index).push(receipt);
  }
  const perSeat = Array.from({ length: plan.count }, (_, i) => seatCoverage({
    index: i + 1, receipts: byIndex.get(i + 1) ?? [], seat, plan, run, expected,
  }));
  if (!perSeat.every((s) => s.ok)) return result("fail-coverage", false, [], perSeat);

  const findings = plan.mode === FULL
    ? perSeat.filter((s) => s.body.verdict === "FAIL")
      .map((s) => ({ severity: BLOCKING, file: "", line: 0, finding: `seat ${s.index} returned FAIL` }))
    : openFindings(plan, perSeat);
  return result(findings.length > 0 ? "fail-findings" : "pass", true, findings, perSeat);
}

function unquote(quoted) {
  const trimmed = quoted.endsWith("\t") ? quoted.slice(0, -1) : quoted;
  if (trimmed.length < 2 || !trimmed.endsWith("\"")) return null;
  const chars = Array.from(trimmed.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === "\"") return null;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = chars[i + 1];
    if (Object.hasOwn(ESCAPES, next)) {
      bytes.push(ESCAPES[next]);
      i += 1;
      continue;
    }
    const octal = /^[0-3][0-7]{2}$/.exec(chars.slice(i + 1, i + 4).join(""));
    if (!octal) return null;
    bytes.push(parseInt(octal[0], 8));
    i += 3;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes));
  } catch {
    return null;
  }
}

/** The new side's path from a `+++ ` header: `b/<path>`, C-quoted or not; null for /dev/null or anything else. */
function newSidePath(header) {
  let name;
  if (header.startsWith("\"")) {
    name = unquote(header);
    if (name === null) return null;
  } else {
    // git ends the name with a tab when it holds a space.
    name = header.endsWith("\t") ? header.slice(0, -1) : header;
  }
  return name.startsWith("b/") && name.length > 2 ? name.slice(2) : null;
}

/**
 * Each changed file's new-side line ranges in a `git diff` patch. A `+++ `
 * line names a file only between its `diff --git` line and its first hunk;
 * content lines always start with a space, `+`, `-` or `\`, so none of
 * them can be read as a file header or a hunk header.
 * @param {string} patch
 * @returns {Map<string, [number, number][]>}
 */
export function hunkRanges(patch) {
  if (typeof patch !== "string") throw new TypeError("hunkRanges expects a string");
  const ranges = new Map();
  let path = null;
  let header = false;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      path = null;
      header = true;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      path = newSidePath(line.slice(4));
      continue;
    }
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    header = false;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (path !== null && count > 0) {
      if (!ranges.has(path)) ranges.set(path, []);
      ranges.get(path).push([start, start + count - 1]);
    }
  }
  return ranges;
}

/** The marker line, and whether the state had to be recorded incomplete to fit (ruling 40). */
function markerFor(state) {
  try {
    const line = encodeStateMarker(state);
    if (line.length <= MAX_MARKER_CHARS) return { line, shrunk: false };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return { line: encodeStateMarker({ ...state, complete: false, findings: [] }), shrunk: true };
}

/** Shares `available` characters among fenced texts, smallest first; each block fits its share. */
function fitBlocks(texts, available) {
  const blocks = new Array(texts.length);
  const order = texts.map((t, i) => ({ i, need: fence(t).length })).sort((a, b) => a.need - b.need);
  let remaining = available;
  let left = texts.length;
  for (const { i, need } of order) {
    const share = Math.floor(remaining / left);
    blocks[i] = need <= share ? fence(texts[i]) : fenceWithin(texts[i], share);
    remaining -= blocks[i].length;
    left -= 1;
  }
  return blocks;
}

function seatLabel(seat) {
  if (seat.ok) return seat.body.verdict;
  return `not counted (${seat.reason})`;
}

/**
 * The summary comment: the state marker on line 1, our own heading, then
 * the plan's reason, the open findings and each seat's output, each in a
 * top-level fenced block, all within GitHub's comment limit. The marker is
 * never truncated; seat blocks are.
 * @returns {{body: string, marker: string}}
 */
export function composeComment({
  seat, head, runId, mode, enforced, status, complete, findings, mergeBase, perSeat,
  superpowersSha = null, planReason = null, rounds = null, notes = [],
}) {
  const { line: marker, shrunk } = markerFor({ v: 1, kind: seat, head, mode, complete, mergeBase, findings, runId });
  const sha = typeof superpowersSha === "string" && SHA.test(superpowersSha) ? superpowersSha : "unknown";
  const pieces = [marker, "", `## ship-kit ${seat} review: ${status}`, "", `Enforced: ${enforced}. Mode: ${mode}. superpowers ${sha}.`];
  if (shrunk) {
    pieces.push("", "The review state was too large to record, so it is recorded incomplete: the next run reviews the whole pull request.");
  }
  for (const note of notes) pieces.push("", note);
  if (Number.isSafeInteger(rounds) && rounds > ROUND_HINT_AFTER) {
    pieces.push("", `${MINING_HINT} this pull request has complete design reviews at ${rounds} distinct heads, more than ${ROUND_HINT_AFTER}; consider a design mining pass (mining-defect-shapes).`);
  }

  // Sections: a heading line, then a fenced text, the withheld line or nothing.
  const sections = [];
  const shown = (heading, value) => sections.push(credentialLike(value) ? { heading, fixed: WITHHELD } : { heading, text: value });
  if (typeof planReason === "string" && planReason !== "") shown("Plan:", planReason);
  if (mode === DESIGN_DOC && findings.length > 0) shown("Open BLOCKING findings:", findings.map(findingLine).join("\n"));
  for (const s of perSeat) {
    const heading = `### Seat ${s.index}: ${seatLabel(s)}`;
    if (s.withheld) sections.push({ heading, fixed: WITHHELD });
    else if (s.body === null) sections.push({ heading });
    else shown(heading, seatText(s.body));
  }

  // Each fenced block is one line-joined piece, preceded by a blank line and
  // at column 0, so it is a top-level block; its slot is filled once the
  // fixed text's length is known.
  const slots = [];
  for (const s of sections) {
    pieces.push("", s.heading);
    if (s.fixed !== undefined) {
      pieces.push("", s.fixed);
    } else if (s.text !== undefined) {
      pieces.push("");
      slots.push(pieces.length);
      pieces.push("");
    }
  }
  const fixedLength = pieces.reduce((sum, piece) => sum + piece.length, 0) + pieces.length - 1;
  const blocks = fitBlocks(sections.filter((s) => s.text !== undefined).map((s) => s.text), MAX_COMMENT_CHARS - fixedLength);
  slots.forEach((at, k) => {
    pieces[at] = blocks[k];
  });
  return { body: pieces.join("\n"), marker };
}

// ------------------------------------------------------------------ inputs

/**
 * A regular file's text: undefined when nothing is at the path, null when
 * something unusable is (a directory, a symlink, an oversized file).
 */
function readInput(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return error && error.code === "ENOENT" ? undefined : null;
  }
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) return null;
  return readFileSync(path, "utf8");
}

/** Parsed JSON: undefined when absent, null when unreadable or not JSON. */
function readJson(path) {
  const raw = readInput(path);
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Every receipts/<artifact>/receipt.json, in name order; a directory entry only. */
function readReceipts(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    .map((name) => readJson(join(dir, name, "receipt.json")) ?? null);
}

function readEnv(env) {
  const root = env.SHIP_KIT_ROOT;
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("SHIP_KIT_ROOT must be an absolute path");
  const repo = repoSlug(env.REPOSITORY);
  if (typeof env.PR_NUMBER !== "string" || !POSITIVE.test(env.PR_NUMBER)) throw new Error("PR_NUMBER must be a positive integer");
  if (!SEATS.includes(env.SEAT)) throw new Error(`SEAT must be one of ${SEATS.join(", ")}`);
  if (typeof env.HEAD_SHA !== "string" || !SHA.test(env.HEAD_SHA)) throw new Error("HEAD_SHA must be a 40-hex SHA");
  if (typeof env.RUN_ID !== "string" || !POSITIVE.test(env.RUN_ID) || !Number.isSafeInteger(Number(env.RUN_ID))) {
    throw new Error("RUN_ID must be a positive integer");
  }
  if (typeof env.GITHUB_OUTPUT !== "string" || env.GITHUB_OUTPUT === "") throw new Error("GITHUB_OUTPUT is not set");
  return {
    root, repo, prNumber: Number(env.PR_NUMBER), seat: env.SEAT, head: env.HEAD_SHA, runId: Number(env.RUN_ID), output: env.GITHUB_OUTPUT,
  };
}

/**
 * Why this run's pull request cannot be trusted as one into the default
 * branch, or null. pull_request_target runs the base branch's copy of the
 * caller, so a pull request into any other branch ran a copy the default
 * branch never approved.
 */
function baseErrorOf(env) {
  const { BASE_REF: base, DEFAULT_BRANCH: main } = env;
  if (typeof base !== "string" || base === "" || typeof main !== "string" || main === "") {
    return "the event's base branch or default branch is unknown";
  }
  return base === main ? null : "this pull request's base is not the default branch, so it ran a copy of the caller the default branch does not hold";
}

// ------------------------------------------------------------- publication

/**
 * How many distinct heads carry a complete design-doc review of either seat
 * on this pull request, counting this run when it is one. A prior state
 * counts only when trustState binds it to a caller run and that run's own
 * record lists only this pull request, into the default branch. Any error
 * leaves out what it touched; this decides only a hint.
 */
function countRounds({ gh, download, ctx, defaultBranch, thisRun }) {
  const heads = new Set();
  if (thisRun) heads.add(ctx.head);
  if (defaultBranch === null) return heads.size;
  const { owner, name, slug } = ctx.repo;
  const responses = new Map();
  const readOnce = { ...gh, get: (path) => {
    if (!responses.has(path)) responses.set(path, gh.get(path));
    return responses.get(path);
  } };
  const boundHere = (runId) => {
    const { status, json } = readOnce.get(api`repos/${owner}/${name}/actions/runs/${runId}`);
    const prs = status === 200 && isPlainObject(json) ? json.pull_requests : undefined;
    return Array.isArray(prs) && prs.length > 0 && prs.every((pr) => isPlainObject(pr) && pr.number === ctx.prNumber
      && isPlainObject(pr.base) && pr.base.ref === defaultBranch);
  };
  try {
    const comments = gh.list(api`repos/${owner}/${name}/issues/${ctx.prNumber}/comments`).filter((comment) => {
      const decoded = decodeStateMarker(isPlainObject(comment) ? comment.body : undefined);
      return decoded.ok && decoded.state.mode === DESIGN_DOC && decoded.state.complete === true;
    });
    const trustState = makeTrustState({ gh: readOnce, repo: slug, defaultBranch, download: download ?? makeDownload({ gh, repo: slug }) });
    for (const state of collectTrustedStates(comments, { kinds: SEATS, trustState })) {
      if (boundHere(state.runId)) heads.add(state.head);
    }
  } catch {
    // Only the hint depends on this.
  }
  return heads.size;
}

/** Seat patches' hunk ranges, merged. */
function planRanges(root, count) {
  const ranges = new Map();
  for (let n = 1; n <= count; n += 1) {
    const patch = readInput(join(root, "review", `seat-${n}.patch`));
    if (typeof patch !== "string") continue;
    for (const [path, spans] of hunkRanges(patch)) ranges.set(path, [...(ranges.get(path) ?? []), ...spans]);
  }
  return ranges;
}

/**
 * Posts design-doc findings that fall inside the diff hunks as one review;
 * returns the summary notes (findings left out, a failed post).
 */
function postInlineReview({ gh, ctx, plan, decision }) {
  const notes = [];
  const ranges = planRanges(ctx.root, plan.count);
  const comments = [];
  let outside = 0;
  for (const s of decision.perSeat.filter((p) => p.ok)) {
    for (const f of s.body.findings.map(normalizeFinding)) {
      const spans = ranges.get(f.file) ?? [];
      if (spans.some(([start, end]) => f.line >= start && f.line <= end)) {
        comments.push({ path: f.file, line: f.line, side: "RIGHT", body: fenceWithin(`[${f.severity}] ${f.finding}`, MAX_INLINE_CHARS) });
      } else {
        outside += 1;
      }
    }
  }
  if (outside > 0) {
    notes.push(`${outside} ${outside === 1 ? "finding is" : "findings are"} outside the diff and appear only in this summary.`);
  }
  if (comments.length === 0) return notes;
  const { owner, name } = ctx.repo;
  let why;
  try {
    const response = gh.send("POST", api`repos/${owner}/${name}/pulls/${ctx.prNumber}/reviews`, {
      event: "COMMENT",
      commit_id: ctx.head,
      body: `ship-kit ${ctx.seat} review: findings on the diff. The summary comment holds the verdict.`,
      comments,
    });
    if (response.status < 200 || response.status > 299) why = `HTTP ${response.status}`;
  } catch {
    why = "no response";
  }
  if (why !== undefined) notes.push(`The inline review could not be posted (${why}); every finding appears in this summary.`);
  return notes;
}

function run(env, { gh, download }) {
  const ctx = readEnv(env);
  const { root } = ctx;
  const planStatus = readJson(join(root, "review", "status.json"));
  const plan = readJson(join(root, "review", "plan.json")) ?? null;
  const runJson = readJson(join(root, "expect", "run.json")) ?? null;
  const skill = readInput(join(root, "src", "skills", SEAT_SKILLS[ctx.seat], "SKILL.md"));
  const baseError = baseErrorOf(env);
  const decision = decide({
    seat: ctx.seat,
    baseError,
    plan,
    planStatus,
    planResult: env.PLAN_RESULT,
    run: runJson,
    receipts: readReceipts(join(root, "receipts")),
    expectedMarker: typeof skill === "string" ? expectedMarker(skill) : null,
  });
  const { mode, enforced, mergeBase } = planView(plan);

  appendFileSync(ctx.output, `status=${decision.status}\nenforced=${enforced}\nmode=${mode}\n`);

  let notes = [];
  let rounds = null;
  if (mode === DESIGN_DOC) {
    const thisRun = decision.complete && baseError === null;
    rounds = countRounds({ gh, download, ctx, defaultBranch: baseError === null ? env.DEFAULT_BRANCH : null, thisRun });
    notes = postInlineReview({ gh, ctx, plan, decision });
  }
  let planReason = null;
  if (baseError !== null) planReason = baseError;
  else if (isPlainObject(planStatus) && typeof planStatus.reason === "string") planReason = planStatus.reason;

  const { body, marker } = composeComment({
    seat: ctx.seat, head: ctx.head, runId: ctx.runId, mode, enforced, status: decision.status,
    complete: decision.complete, findings: decision.findings, mergeBase, perSeat: decision.perSeat,
    superpowersSha: isPlainObject(runJson) ? runJson.superpowersSha : null, planReason, rounds, notes,
  });
  const { owner, name } = ctx.repo;
  const response = gh.send("POST", api`repos/${owner}/${name}/issues/${ctx.prNumber}/comments`, { body });
  if (response.status < 200 || response.status > 299) throw new Error(`posting the summary comment returned HTTP ${response.status}`);
  const commentId = isPlainObject(response.json) ? response.json.id : undefined;
  if (!Number.isSafeInteger(commentId) || commentId < 1) throw new Error("the posted comment has no id");

  const stateDir = join(root, "state");
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ commentId, marker }));
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{gh?: object, download?: Function, stderr?: {write: Function}}} [deps]
 * @returns {number} 0 when the comment was posted and the state written; 1 otherwise
 */
export function main(env = process.env, { gh = makeGh(), download, stderr = process.stderr } = {}) {
  try {
    run(env, { gh, download });
    return 0;
  } catch (error) {
    stderr.write(`aggregate: ${messageOf(error)}\n`);
    return 1;
  }
}

function isEntry() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (isEntry()) {
  process.exitCode = main();
}
