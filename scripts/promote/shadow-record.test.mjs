import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { included, makeFakeGhApi } from "../../tests/helpers/fake-gh-api.mjs";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { SEATS, loadConfig } from "../lib/config.mjs";
import { makeGh } from "../lib/gh.mjs";
import { encodeStateMarker } from "../lib/state-marker.mjs";
import { DEFAULT_LIMIT, MAX_LIMIT, REASONS, UsageError, main, parseArgs } from "./shadow-record.mjs";

const SCRIPT = fileURLToPath(new URL("./shadow-record.mjs", import.meta.url));
const SLUG = "acme/widgets";
const BRANCH = "main";
const SEAT = "adversarial";
const CREATED = "2026-01-01T00:00:00Z";
const BLOCKING_FINDING = { severity: "BLOCKING", file: "", line: 0, finding: "seat 0 returned FAIL" };

const sha = (n) => n.toString(16).padStart(40, "0");

/** What execFileSync throws when gh exits non-zero after printing `stdout`. */
function ghExit(stdout = "", stderr = "gh: failed") {
  return Object.assign(new Error("Command failed: gh"), { status: 1, stdout, stderr });
}

/** gh's answer to `api --include` for a non-2xx response. */
const httpError = (status, message = "error") => ghExit(included(status, { message }, "Error"));

/**
 * A fake GitHub behind gh: merged pull requests in listing (creation)
 * order, their issue comments, workflow runs, run artifacts and artifact
 * files. It answers the calls shadow-record makes through the real gh
 * client, paging every list at 100 like the API does.
 */
class World {
  /** @param {{branch?: string, callerRef?: boolean}} [options] `callerRef`: runs report `<path>@refs/heads/<branch>` */
  constructor({ branch = BRANCH, callerRef = false } = {}) {
    this.branch = branch;
    this.callerRef = callerRef;
    this.prs = [];
    this.comments = new Map();
    this.runs = new Map();
    this.artifacts = new Map();
    this.files = new Map();
    this.calls = [];
    this.nextComment = 1000;
    this.nextRun = 5000;
    this.failOn = () => null;
    this.repoView = { nameWithOwner: SLUG, defaultBranchRef: { name: branch } };
    this.listing = null;
    this.listingText = null;
    // Search answers: numbers the merge-time search leaves out, as a lagging index would.
    this.searchLag = new Set();
    this.searchText = null;
    this.searchRows = null;
    this.run = this.run.bind(this);
  }

  /**
   * @param {number} number
   * @param {{head?: string, labels?: string[], mergedAt?: string, states?: object[], noise?: number}} [options]
   *   `states` are state specs: {kind, head, complete, mode, findings, flaw}
   */
  addPr(number, { head = sha(number), labels = [], mergedAt = `2026-09-${String(number).padStart(2, "0")}T12:00:00Z`, states = [{}], noise = 0 } = {}) {
    this.prs.push({ number, headRefOid: head, labels: labels.map((name) => ({ name })), mergedAt });
    const comments = [];
    for (let i = 0; i < noise; i += 1) {
      comments.push({ id: this.nextComment++, body: `human comment ${i}`, created_at: CREATED, updated_at: CREATED, user: { login: "maintainer", type: "User" } });
    }
    for (const spec of states) comments.push(this.addState(spec, head));
    this.comments.set(number, comments);
    return comments;
  }

  /** A state comment, and by default the run and artifact that make it trusted. */
  addState({ kind = SEAT, head, complete = true, mode = "full", findings = [], flaw = null } = {}, prHead) {
    const runId = this.nextRun++;
    const id = this.nextComment++;
    const line = encodeStateMarker({ v: 1, kind, head: head ?? prHead, mode, complete, mergeBase: null, findings, runId });
    const comment = {
      id,
      body: `${line}\n\nReview text.`,
      created_at: CREATED,
      updated_at: flaw === "edited" ? "2026-01-02T00:00:00Z" : CREATED,
      user: flaw === "human" ? { login: "github-actions[bot]", type: "User" } : { login: "github-actions[bot]", type: "Bot" },
    };
    if (flaw !== "no-run") {
      let path = `.github/workflows/ship-kit-${kind}.yml${this.callerRef ? `@refs/heads/${this.branch}` : ""}`;
      if (flaw === "wrong-path") path = ".github/workflows/evil.yml";
      if (flaw === "other-branch") path = `.github/workflows/ship-kit-${kind}.yml@refs/heads/feature`;
      this.runs.set(runId, { id: runId, event: "pull_request_target", path, repository: { full_name: SLUG } });
    }
    this.artifacts.set(runId, [{ id: 1, name: "ship-kit-state-1", expired: flaw === "expired" }]);
    if (flaw !== "no-file") {
      const marker = flaw === "payload" ? `${line} ` : line;
      this.files.set(`${runId}/ship-kit-state-1`, JSON.stringify({ commentId: id, marker }));
    }
    return comment;
  }

  run(file, args) {
    assert.equal(file, "gh");
    this.calls.push(args);
    const injected = this.failOn(args);
    if (injected) throw injected;
    if (args[0] === "repo") return JSON.stringify(this.repoView);
    if (args[0] === "pr") return args.includes("--search") ? this.search(args) : this.listPrs(args);
    if (args[0] === "api" && args[1] === "--include") return this.get(args[2]);
    if (args[0] === "api" && args[1] === "--paginate" && args[2] === "--slurp") return this.pages(args[3]);
    if (args[0] === "run" && args[1] === "download") return this.download(args);
    throw ghExit("", `fake gh: no answer for ${args.join(" ")}`);
  }

  /** gh pr list: the most recently created merged PRs, newest first, like gh. */
  listPrs(args) {
    if (this.listingText !== null) return this.listingText;
    const limit = Number(args[args.indexOf("--limit") + 1]);
    return JSON.stringify(this.listing ?? [...this.prs].reverse().slice(0, limit));
  }

  /** gh pr list --search merged:>=T: every merged PR at or after T, newest created first, cut at --limit. */
  search(args) {
    if (this.searchText !== null) return this.searchText;
    if (this.searchRows !== null) return JSON.stringify(this.searchRows);
    const query = args[args.indexOf("--search") + 1];
    const since = Date.parse(/^merged:>=(.+)$/.exec(query)[1]);
    assert.ok(Number.isFinite(since), query);
    const limit = Number(args[args.indexOf("--limit") + 1]);
    const rows = [...this.prs]
      .reverse()
      .filter((pr) => Date.parse(pr.mergedAt) >= since && !this.searchLag.has(pr.number))
      .slice(0, limit)
      .map(({ number }) => ({ number }));
    return JSON.stringify(rows);
  }

  get(path) {
    const match = /^repos\/acme\/widgets\/actions\/runs\/(\d+)$/.exec(path);
    if (!match) throw ghExit("", `fake gh: no answer for ${path}`);
    const run = this.runs.get(Number(match[1]));
    if (!run) throw httpError(404, "Not Found");
    return included(200, run, "OK");
  }

  pages(path) {
    let match = /^repos\/acme\/widgets\/issues\/(\d+)\/comments\?per_page=100$/.exec(path);
    if (match) return JSON.stringify(paged(this.comments.get(Number(match[1])) ?? []));
    match = /^repos\/acme\/widgets\/actions\/runs\/(\d+)\/artifacts\?per_page=100$/.exec(path);
    if (match) {
      const artifacts = this.artifacts.get(Number(match[1])) ?? [];
      return JSON.stringify([{ total_count: artifacts.length, artifacts }]);
    }
    throw ghExit("", `fake gh: no answer for ${path}`);
  }

  download(args) {
    const text = this.files.get(`${args[2]}/${args[args.indexOf("-n") + 1]}`);
    if (text === undefined) throw ghExit("", "no valid artifacts found");
    writeFileSync(join(args[args.indexOf("-D") + 1], "state.json"), text);
    return "";
  }

  commentsCalls() {
    return this.calls.filter((c) => c[0] === "api" && c[3]?.includes("/comments"));
  }
}

/** gh's --slurp output: one array per page of at most 100. */
function paged(items) {
  const pages = [];
  for (let i = 0; i < items.length; i += 100) pages.push(items.slice(i, i + 100));
  return pages.length === 0 ? [[]] : pages;
}

function configWith(promotion = {}) {
  const loaded = loadConfig(JSON.stringify({ schemaVersion: 1, shipKit: { version: "0.2.0", sha: sha(1) }, review: { promotion } }));
  assert.ok(loaded.ok, loaded.reason);
  return loaded.config;
}

const sink = () => ({ text: "", write(chunk) { this.text += chunk; return true; } });

/** Runs main() in this process against `world`; parses stdout when there is any. */
function record(world, argv = [SEAT], { promotion = {}, readConfig, branch = world.branch } = {}) {
  const out = sink();
  const err = sink();
  const deps = {
    readConfig: readConfig ?? (() => ({ ok: true, config: configWith(promotion), branch, sha: sha(2), migratedFrom: null })),
    gh: makeGh({ run: world.run }),
  };
  const code = main(argv, deps, { out, err });
  return { code, out: out.text, err: err.text, result: out.text === "" ? null : JSON.parse(out.text) };
}

const streakOf = (...numbers) => numbers.map((pr) => ({ pr, head: sha(pr) }));

// arguments ---------------------------------------------------------------

test("constants", () => {
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(MAX_LIMIT, 200);
  assert.deepEqual(REASONS, {
    noState: "no trusted state for the final head (artifacts may have expired under the repository's retention)",
    incomplete: "incomplete",
    unconfirmed: "blocking findings not confirmed",
    falsePositive: "false positive",
  });
});

test("parseArgs takes a seat and an optional --limit in either order", () => {
  assert.deepEqual(parseArgs(["general"]), { seat: "general", limit: 50 });
  assert.deepEqual(parseArgs(["adversarial", "--limit", "200"]), { seat: "adversarial", limit: 200 });
  assert.deepEqual(parseArgs(["--limit", "1", "test-integrity"]), { seat: "test-integrity", limit: 1 });
  for (const seat of SEATS) assert.equal(parseArgs([seat]).seat, seat);
});

test("parseArgs refuses a missing, unknown or extra seat, and every bad --limit, each with its own message", () => {
  const seat = /the seat must be one of/;
  const limit = /--limit must be a whole number from 1 to 200/;
  const bad = [
    [[], seat],
    [["bogus"], seat],
    [["General"], seat],
    [["general", "adversarial"], /unexpected argument "adversarial"/],
    [["--limit", "5"], seat],
    [["general", "--limit"], limit],
    [["general", "--limit", "0"], limit],
    [["general", "--limit", "201"], limit],
    [["general", "--limit", "1000"], limit],
    [["general", "--limit", "-1"], limit],
    [["general", "--limit", "abc"], limit],
    [["general", "--limit", "1.5"], limit],
    [["general", "--limit", "1e2"], limit],
    [["general", "--limit", "0x10"], limit],
    [["general", "--limit", " 5"], limit],
    [["general", "--limit", "050"], limit],
    [["general", "--limit", ""], limit],
    [["general", "--limit", "5", "--limit", "6"], /--limit given twice/],
    [["general", "--limit=5"], /unknown option "--limit=5"/],
    [["--verbose", "general"], /unknown option "--verbose"/],
    [["-x"], /unknown option "-x"/],
  ];
  for (const [argv, pattern] of bad) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message) && /usage: shadow-record\.mjs/.test(e.message), JSON.stringify(argv));
  }
});

test("seat bogus exits 2 before any config or gh call", () => {
  const w = new World();
  let read = false;
  const r = record(w, ["bogus"], { readConfig: () => { read = true; return { ok: false, reason: "x" }; } });
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  assert.match(r.err, /usage: shadow-record\.mjs <general\|adversarial\|security\|test-integrity>/);
  assert.equal(read, false);
  assert.deepEqual(w.calls, []);
});

test("main with no dependencies builds the real ones lazily and still refuses a bad seat with 2", () => {
  const out = sink();
  const err = sink();
  assert.equal(main(["bogus"], undefined, { out, err }), 2);
  assert.match(err.text, /usage/);
});

// config ------------------------------------------------------------------

test("an unreadable config at origin's default branch exits 3 with no gh call", () => {
  const w = new World();
  w.addPr(1);
  const r = record(w, [SEAT], { readConfig: () => ({ ok: false, reason: ".ship-kit/config.json is absent at refs/ship-kit/default" }) });
  assert.equal(r.code, 3);
  assert.equal(r.out, "");
  assert.match(r.err, /unreadable: \.ship-kit\/config\.json is absent/);
  assert.deepEqual(w.calls, []);
});

test("a config reader that throws is unreadable too", () => {
  const r = record(new World(), [SEAT], { readConfig: () => { throw new Error("boom"); } });
  assert.equal(r.code, 3);
  assert.match(r.err, /boom/);
  const odd = record(new World(), [SEAT], { readConfig: () => { throw "nope"; } });
  assert.equal(odd.code, 3);
  assert.match(odd.err, /nope/);
});

test("required and the labels come from the trusted config", () => {
  const w = new World();
  w.addPr(1, { labels: ["fp"], states: [{ findings: [BLOCKING_FINDING] }] });
  w.addPr(2, { labels: ["ok"], states: [{ findings: [BLOCKING_FINDING] }] });
  w.addPr(3, { labels: ["ship-kit-false-positive"] });
  const r = record(w, [SEAT], { promotion: { cleanRuns: 7, falsePositiveLabel: "fp", confirmedLabel: "ok" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.result.required, 7);
  assert.deepEqual(r.result.streak, streakOf(3, 2));
  assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.falsePositive });
});

// the record --------------------------------------------------------------

test("five clean PRs are a streak of five, newest first, with nothing stopping it", () => {
  const w = new World();
  for (let n = 1; n <= 5; n += 1) w.addPr(n);
  const r = record(w);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.deepEqual(r.result, { seat: SEAT, required: 5, cleanRuns: 5, streak: streakOf(5, 4, 3, 2, 1), stoppedAt: null, truncated: false });
});

test("the listing is requested from this repository's default branch with the brief's fields", () => {
  const w = new World();
  w.addPr(1);
  record(w, [SEAT, "--limit", "7"]);
  assert.deepEqual(w.calls[0], ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
  assert.deepEqual(w.calls[1], [
    "pr", "list", "-R", SLUG, "--base", BRANCH, "--state", "merged", "--limit", "7", "--json", "number,headRefOid,labels,mergedAt",
  ]);
  assert.deepEqual(w.calls[2], ["api", "--paginate", "--slurp", "repos/acme/widgets/issues/1/comments?per_page=100"]);
});

test("no merged PR is an empty streak that stopped nowhere", () => {
  const r = record(new World());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.result, { seat: SEAT, required: 5, cleanRuns: 0, streak: [], stoppedAt: null, truncated: false });
});

test("a false-positive label stops the streak at that PR, and older clean PRs do not count", () => {
  const w = new World();
  w.addPr(1);
  w.addPr(2, { labels: ["ship-kit-false-positive"] });
  w.addPr(3);
  w.addPr(4);
  const r = record(w);
  assert.equal(r.result.cleanRuns, 2);
  assert.deepEqual(r.result.streak, streakOf(4, 3));
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: "false positive" });
});

test("a false-positive label stops even a PR whose state is clean and complete", () => {
  const w = new World();
  w.addPr(1, { labels: ["ship-kit-false-positive"], states: [{ complete: true, findings: [] }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.falsePositive });
});

test("a confirmed label with BLOCKING findings is clean", () => {
  const w = new World();
  w.addPr(1, { labels: ["ship-kit-confirmed"], states: [{ findings: [BLOCKING_FINDING] }] });
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(1));
  assert.equal(r.result.stoppedAt, null);
});

test("BLOCKING findings without the confirmed label are not clean", () => {
  const w = new World();
  w.addPr(1, { states: [{ findings: [BLOCKING_FINDING] }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: "blocking findings not confirmed" });
});

test("both labels is not clean: the false-positive label wins over the confirmed one", () => {
  const w = new World();
  w.addPr(1, { labels: ["ship-kit-confirmed", "ship-kit-false-positive"], states: [{ findings: [BLOCKING_FINDING] }] });
  const r = record(w);
  assert.equal(r.result.cleanRuns, 0);
  assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: "false positive" });
});

test("the confirmed label alone does not make a PR without findings unclean, and unrelated labels do nothing", () => {
  const w = new World();
  w.addPr(1, { labels: ["ship-kit-confirmed", "bug", "not-ship-kit-false-positive", "ship-kit-false-positive-2"] });
  assert.deepEqual(record(w).result.streak, streakOf(1));
});

test("labels match the configured name ignoring case, as GitHub does", () => {
  const w = new World();
  w.addPr(1, { labels: ["SHIP-KIT-CONFIRMED"], states: [{ findings: [BLOCKING_FINDING] }] });
  w.addPr(2, { labels: ["Ship-Kit-False-Positive"] });
  const r = record(w);
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: REASONS.falsePositive });
  const later = new World();
  later.addPr(1, { labels: ["SHIP-KIT-CONFIRMED"], states: [{ findings: [BLOCKING_FINDING] }] });
  assert.deepEqual(record(later).result.streak, streakOf(1));
});

test("configured label names with capitals match the labels a PR carries", () => {
  const promotion = { falsePositiveLabel: "Needs-FP", confirmedLabel: "Is-Confirmed" };
  const confirmed = new World();
  confirmed.addPr(1, { labels: ["is-confirmed"], states: [{ findings: [BLOCKING_FINDING] }] });
  assert.deepEqual(record(confirmed, [SEAT], { promotion }).result.streak, streakOf(1));
  const falsePositive = new World();
  falsePositive.addPr(1, { labels: ["NEEDS-FP"] });
  assert.deepEqual(record(falsePositive, [SEAT], { promotion }).result.stoppedAt, { pr: 1, reason: REASONS.falsePositive });
});

test("NON-BLOCKING findings are clean; a finding without a severity counts as BLOCKING", () => {
  const nonBlocking = { severity: "NON-BLOCKING", file: "docs/a.md", line: 3, finding: "wording" };
  const w = new World();
  w.addPr(1, { states: [{ mode: "design-doc", findings: [nonBlocking] }] });
  assert.deepEqual(record(w).result.streak, streakOf(1));
  const unclear = new World();
  unclear.addPr(1, { states: [{ mode: "design-doc", findings: [nonBlocking, {}] }] });
  assert.deepEqual(record(unclear).result.stoppedAt, { pr: 1, reason: REASONS.unconfirmed });
  const lower = new World();
  lower.addPr(1, { states: [{ findings: [{ severity: "non-blocking", file: "", line: 0, finding: "x" }] }] });
  assert.deepEqual(record(lower).result.stoppedAt, { pr: 1, reason: REASONS.unconfirmed });
});

test("a trusted state only for an older head stops the streak with the retention reason", () => {
  const w = new World();
  w.addPr(1);
  w.addPr(2, { head: sha(22), states: [{ head: sha(21) }] });
  w.addPr(3);
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(3));
  assert.deepEqual(r.result.stoppedAt, {
    pr: 2,
    reason: "no trusted state for the final head (artifacts may have expired under the repository's retention)",
  });
});

test("a PR with no state comment at all stops the streak the same way", () => {
  const w = new World();
  w.addPr(1, { states: [] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.noState });
});

test("another seat's trusted state is not this seat's record", () => {
  const w = new World();
  w.addPr(1, { states: [{ kind: "general" }] });
  assert.deepEqual(record(w, ["adversarial"]).result.stoppedAt, { pr: 1, reason: REASONS.noState });
  assert.deepEqual(record(w, ["general"]).result.streak, streakOf(1));
});

test("every forged or unbound marker stops the streak: none is a trusted state", () => {
  for (const flaw of ["no-run", "payload", "edited", "human", "wrong-path"]) {
    const w = new World();
    w.addPr(1, { states: [{ flaw }] });
    const r = record(w);
    assert.equal(r.code, 0, `${flaw}: ${r.err}`);
    assert.equal(r.result.cleanRuns, 0, flaw);
    assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.noState }, flaw);
  }
});

test("a default branch with a slash reaches the listing, the repository check and the caller path unchanged", () => {
  const w = new World({ branch: "release/1.x", callerRef: true });
  w.addPr(1);
  w.addPr(2, { states: [{ flaw: "other-branch" }] });
  w.addPr(3);
  const r = record(w);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.result.streak, streakOf(3));
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: REASONS.noState });
  assert.deepEqual(w.calls[1].slice(4, 6), ["--base", "release/1.x"]);
});

test("a caller path at the wrong branch is not the default branch's caller", () => {
  const w = new World({ branch: "main", callerRef: true });
  w.addPr(1, { states: [{ flaw: "other-branch" }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.noState });
});

test("an expired artifact stops the streak with the retention reason and is never downloaded", () => {
  const w = new World();
  w.addPr(1);
  w.addPr(2, { states: [{ flaw: "expired" }] });
  const r = record(w);
  assert.deepEqual(r.result.streak, []);
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: REASONS.noState });
  assert.match(r.result.stoppedAt.reason, /artifacts may have expired under the repository's retention/);
  assert.equal(w.calls.some((c) => c[0] === "run"), false);
});

test("a needs-maintainer or fail-config state (complete false, no findings) is not clean: incomplete", () => {
  const w = new World();
  w.addPr(1);
  w.addPr(2, { states: [{ complete: false, findings: [] }] });
  const r = record(w);
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: "incomplete" });
  assert.equal(r.result.cleanRuns, 0);
});

test("a confirmed label cannot rescue an incomplete state", () => {
  const w = new World();
  w.addPr(1, { labels: ["ship-kit-confirmed"], states: [{ complete: false, findings: [BLOCKING_FINDING] }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.incomplete });
});

test("the newest of two states for the final head decides: passing then incomplete is not clean", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: true }, { complete: false }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.incomplete });
});

test("the newest of two states for the final head decides: incomplete then passing is clean", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: false }, { complete: true }] });
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(1));
  assert.equal(r.result.stoppedAt, null);
});

test("the newest state decides by comment id, not by listing position", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: true }, { complete: false }] });
  w.comments.get(1).reverse();
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.incomplete });
});

test("a newer state for another head does not decide over the final head's state", () => {
  const w = new World();
  w.addPr(1, { head: sha(12), states: [{ head: sha(12), complete: true }, { head: sha(11), complete: false }] });
  assert.deepEqual(record(w).result.streak, [{ pr: 1, head: sha(12) }]);
});

test("a forged newer clean state cannot override the trusted incomplete one", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: false }, { complete: true, flaw: "no-run" }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.incomplete });
});

test("a forged newer incomplete state cannot unseat the trusted clean one", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: true }, { complete: false, flaw: "edited" }] });
  assert.deepEqual(record(w).result.streak, streakOf(1));
});

test("full-mode BLOCKING state findings for a FAIL verdict need the confirmed label", () => {
  const w = new World();
  w.addPr(1, { states: [{ mode: "full", complete: true, findings: [{ ...BLOCKING_FINDING, finding: "seat 1 returned FAIL" }] }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.unconfirmed });
});

test("the streak walks by merge time, not by creation order", () => {
  const w = new World();
  // Created first, merged last.
  w.addPr(1, { mergedAt: "2026-09-20T00:00:00Z" });
  // Created second, merged first, carries the false-positive label.
  w.addPr(2, { mergedAt: "2026-09-10T00:00:00Z", labels: ["ship-kit-false-positive"] });
  const listedFirst = w.prs.map((p) => p.number);
  assert.deepEqual(listedFirst, [1, 2]);
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(1));
  assert.deepEqual(r.result.stoppedAt, { pr: 2, reason: REASONS.falsePositive });
  const reversed = new World();
  reversed.addPr(2, { mergedAt: "2026-09-10T00:00:00Z", labels: ["ship-kit-false-positive"] });
  reversed.addPr(1, { mergedAt: "2026-09-20T00:00:00Z" });
  assert.deepEqual(record(reversed).result.streak, streakOf(1));
});

test("merge times are compared as instants, whatever offset they are written with", () => {
  const w = new World();
  // 2026-09-01T19:00:00Z: earlier than the other, though it sorts later as text.
  w.addPr(1, { mergedAt: "2026-09-02T00:00:00+05:00", labels: ["ship-kit-false-positive"] });
  w.addPr(2, { mergedAt: "2026-09-01T20:00:00Z" });
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(2));
  assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.falsePositive });
});

test("PRs merged at the same instant are walked highest number first", () => {
  const w = new World();
  w.addPr(1, { mergedAt: "2026-09-05T00:00:00Z", labels: ["ship-kit-false-positive"] });
  w.addPr(2, { mergedAt: "2026-09-05T00:00:00Z" });
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(2));
  assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.falsePositive });
});

test("a count equal to --limit sets truncated; one less does not", () => {
  const w = new World();
  for (let n = 1; n <= 3; n += 1) w.addPr(n);
  const equal = record(w, [SEAT, "--limit", "3"]);
  assert.equal(equal.result.truncated, true);
  assert.equal(equal.result.cleanRuns, 3);
  assert.equal(equal.result.stoppedAt, null);
  assert.equal(record(w, [SEAT, "--limit", "4"]).result.truncated, false);
  assert.equal(record(w, [SEAT, "--limit", "2"]).result.truncated, true);
  assert.equal(record(w).result.truncated, false);
});

// A repository where PR 1 was created first and merged late, so gh's
// newest-created window at a small --limit leaves it out.
function lateMergeLayout() {
  const w = new World();
  w.addPr(1, { mergedAt: "2026-09-20T00:00:00Z", labels: ["ship-kit-false-positive"] });
  w.addPr(2, { mergedAt: "2026-09-05T00:00:00Z" });
  w.addPr(3, { mergedAt: "2026-09-10T00:00:00Z" });
  w.addPr(4, { mergedAt: "2026-09-25T00:00:00Z" });
  return w;
}

const searchCalls = (w) => w.calls.filter((c) => c.includes("--search"));

test("a PR created before the window and merged inside it is not silently skipped", () => {
  const w = lateMergeLayout();
  assert.deepEqual(JSON.parse(w.listPrs(["--limit", "2"])).map((p) => p.number), [4, 3], "gh's window leaves PR 1 out");
  const r = record(w, [SEAT, "--limit", "2"]);
  assertFailed(r, /missed pull request\(s\) merged since 2026-09-10T00:00:00Z: #1; .*raise --limit/);
  assert.equal(w.commentsCalls().length, 0, "no comment is read from an incomplete window");
});

test("a larger window that still leaves a late merge out is refused too", () => {
  assertFailed(record(lateMergeLayout(), [SEAT, "--limit", "3"]), /missed pull request\(s\) merged since 2026-09-05T00:00:00Z: #1/);
});

test("a window that holds every PR merged since its oldest merge is accepted and walked by merge time", () => {
  for (const [limit, truncated] of [["4", true], ["5", false]]) {
    const w = lateMergeLayout();
    const r = record(w, [SEAT, "--limit", limit]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result.streak, streakOf(4), limit);
    assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.falsePositive }, limit);
    assert.equal(r.result.truncated, truncated, limit);
  }
});

test("the second listing is one search for everything merged since the oldest listed merge, for one more entry than the window", () => {
  const w = lateMergeLayout();
  record(w, [SEAT, "--limit", "4"]);
  assert.deepEqual(searchCalls(w), [
    ["pr", "list", "-R", SLUG, "--base", BRANCH, "--state", "merged", "--search", "merged:>=2026-09-05T00:00:00Z", "--limit", "5", "--json", "number"],
  ]);
});

test("a listing shorter than --limit is complete and needs no second listing", () => {
  const w = lateMergeLayout();
  record(w, [SEAT, "--limit", "5"]);
  assert.deepEqual(searchCalls(w), []);
});

test("the search instant is the oldest merge in UTC, whole seconds", () => {
  const w = new World();
  w.addPr(1, { mergedAt: "2026-09-02T00:00:00.900+05:00" });
  record(w, [SEAT, "--limit", "1"]);
  assert.equal(searchCalls(w)[0][searchCalls(w)[0].indexOf("--search") + 1], "merged:>=2026-09-01T19:00:00Z");
});

test("a PR merged at the very instant the window starts, outside the window, is refused", () => {
  const w = new World();
  w.addPr(1, { mergedAt: "2026-09-10T00:00:00Z" });
  w.addPr(2, { mergedAt: "2026-09-10T00:00:00Z" });
  assertFailed(record(w, [SEAT, "--limit", "1"]), /missed pull request\(s\) merged since 2026-09-10T00:00:00Z: #1/);
});

test("a search index that lacks a listed PR is a disagreement, not a confirmation", () => {
  const w = lateMergeLayout();
  w.searchLag = new Set([3]);
  assertFailed(record(w, [SEAT, "--limit", "4"]), /lacks listed pull request\(s\) #3; the search index may be behind/);
});

test("an unusable merge-time listing exits 1", () => {
  const answers = [
    ["not JSON", (w) => { w.searchText = "HTTP 502: Bad Gateway"; }, /not JSON/],
    ["not an array", (w) => { w.searchRows = { number: 1 }; }, /is not an array/],
    ["entry null", (w) => { w.searchRows = [null]; }, /without a valid number/],
    ["entry an array", (w) => { w.searchRows = [[]]; }, /without a valid number/],
    ["number zero", (w) => { w.searchRows = [{ number: 0 }]; }, /without a valid number/],
    ["number a string", (w) => { w.searchRows = [{ number: "1" }]; }, /without a valid number/],
    ["number missing", (w) => { w.searchRows = [{}]; }, /without a valid number/],
    ["call fails", (w) => { w.failOn = (args) => (args.includes("--search") ? ghExit("", "HTTP 422") : null); }, /--search/],
  ];
  for (const [note, arrange, pattern] of answers) {
    const w = lateMergeLayout();
    arrange(w);
    const r = record(w, [SEAT, "--limit", "4"]);
    assertFailed(r, pattern);
    assert.equal(w.commentsCalls().length, 0, note);
  }
});

test("a PR whose label list fills gh's page of 100 may be hiding the false-positive label: exit 1", () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `label-${i}`);
  const ok = new World();
  ok.addPr(1, { labels: names(99) });
  assert.deepEqual(record(ok).result.streak, streakOf(1));
  for (const count of [100, 101]) {
    const w = new World();
    w.addPr(1, { labels: [...names(count - 1), "ship-kit-false-positive"] });
    assertFailed(record(w), /lists \d+ labels, so its label list may be truncated/);
    assert.equal(w.commentsCalls().length, 0);
  }
});

test("101 comments are read in full: a state on page 2 is found", () => {
  const w = new World();
  w.addPr(1, { noise: 100 });
  assert.equal(w.comments.get(1).length, 101);
  const r = record(w);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.result.streak, streakOf(1));
  assert.equal(w.commentsCalls().length, 1);
});

test("101 comments where the only state is on page 2 and is incomplete stop the streak", () => {
  const w = new World();
  w.addPr(1, { noise: 100, states: [{ complete: false }] });
  assert.deepEqual(record(w).result.stoppedAt, { pr: 1, reason: REASONS.incomplete });
});

test("the walk stops at the first PR that is not clean and reads no older PR's comments", () => {
  const w = new World();
  for (let n = 1; n <= 6; n += 1) w.addPr(n, n === 4 ? { labels: ["ship-kit-false-positive"] } : {});
  const r = record(w);
  assert.deepEqual(r.result.streak, streakOf(6, 5));
  const read = w.commentsCalls().map((c) => Number(/issues\/(\d+)\//.exec(c[3])[1]));
  assert.deepEqual(read, [6, 5, 4]);
});

test("comments, runs and artifacts are read from the repository the listing came from", () => {
  const w = new World();
  w.addPr(12);
  record(w);
  const paths = w.calls.filter((c) => c[0] === "api").map((c) => c[c.length - 1]);
  assert.ok(paths.includes("repos/acme/widgets/issues/12/comments?per_page=100"));
  assert.ok(paths.some((p) => /^repos\/acme\/widgets\/actions\/runs\/\d+$/.test(p)));
  assert.ok(paths.some((p) => /^repos\/acme\/widgets\/actions\/runs\/\d+\/artifacts\?per_page=100$/.test(p)));
});

// failed calls --------------------------------------------------------------

function assertFailed(r, pattern) {
  assert.equal(r.code, 1, r.err);
  assert.equal(r.out, "", "nothing is printed as a result");
  assert.match(r.err, /stopped on a failed call; no record printed/);
  if (pattern) assert.match(r.err, pattern);
}

test("a failed call midway exits 1 and prints no result", () => {
  const w = new World();
  for (let n = 1; n <= 5; n += 1) w.addPr(n);
  w.failOn = (args) => (args[0] === "api" && args[3]?.includes("/issues/3/comments") ? ghExit("", "HTTP 502") : null);
  assertFailed(record(w), /issues\/3\/comments/);
  assert.equal(w.commentsCalls().length, 3);
});

test("a failed repository lookup, listing or comments call exits 1", () => {
  const cases = [
    (args) => (args[0] === "repo" ? ghExit("", "no repository") : null),
    (args) => (args[0] === "pr" ? ghExit("", "rate limited") : null),
    (args) => (args[0] === "api" && args[1] === "--paginate" ? ghExit("", "HTTP 500") : null),
  ];
  for (const failOn of cases) {
    const w = new World();
    w.addPr(1);
    w.failOn = failOn;
    assertFailed(record(w));
  }
});

test("a gh that times out is a failed call", () => {
  const w = new World();
  w.addPr(1);
  w.failOn = (args) => (args[0] === "pr" ? Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }) : null);
  assertFailed(record(w), /timed out/);
});

test("a rate-limited or erroring run lookup while checking a marker is a failed call, not an expiry", () => {
  for (const status of [403, 429, 500, 502]) {
    const w = new World();
    w.addPr(1);
    w.failOn = (args) => (args[0] === "api" && args[1] === "--include" ? httpError(status) : null);
    assertFailed(record(w), new RegExp(`HTTP ${status}`));
  }
});

test("a run lookup that never answers is a failed call", () => {
  const w = new World();
  w.addPr(1);
  w.failOn = (args) => (args[0] === "api" && args[1] === "--include" ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) : null);
  assertFailed(record(w), /timed out/);
});

test("a failed artifact listing is a failed call", () => {
  const w = new World();
  w.addPr(1);
  w.failOn = (args) => (args[0] === "api" && args[3]?.includes("/artifacts") ? ghExit("", "HTTP 500") : null);
  assertFailed(record(w), /artifacts/);
});

test("a failed download of a listed, unexpired artifact is a failed call", () => {
  const w = new World();
  w.addPr(1, { states: [{ flaw: "no-file" }] });
  assertFailed(record(w), /run download/);
});

test("a run that is simply not found is a forgery, not a failure", () => {
  const w = new World();
  w.addPr(1, { states: [{ flaw: "no-run" }] });
  const r = record(w);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.result.stoppedAt, { pr: 1, reason: REASONS.noState });
});

test("a failure seen while checking one marker is reported even when another state would have decided", () => {
  const w = new World();
  w.addPr(1, { states: [{ complete: true }, { complete: true }] });
  w.failOn = (args) => (args[0] === "api" && args[1] === "--include" && args[2].endsWith("/runs/5000") ? httpError(500) : null);
  assertFailed(record(w), /HTTP 500/);
});

test("a repository description that is not JSON, or names no valid repository, exits 1", () => {
  for (const view of [null, [], { nameWithOwner: "no-slash", defaultBranchRef: { name: BRANCH } }, { nameWithOwner: 7, defaultBranchRef: { name: BRANCH } }, {}]) {
    const w = new World();
    w.repoView = view;
    assertFailed(record(w));
  }
  const text = new World();
  text.run = (file, args) => (args[0] === "repo" ? "not json" : "[]");
  assertFailed(record(text), /not JSON/);
});

test("a repository whose default branch differs from origin's is refused", () => {
  for (const defaultBranchRef of [{ name: "trunk" }, { name: "Main" }, null, {}, "main"]) {
    const w = new World();
    w.addPr(1);
    w.repoView = { nameWithOwner: SLUG, defaultBranchRef };
    assertFailed(record(w), /default branch/);
    assert.equal(w.calls.some((c) => c[0] === "pr"), false, "no listing is read from a mismatched repository");
  }
});

test("a malformed listing exits 1 before any comment is read, saying what is wrong", () => {
  const good = { number: 1, headRefOid: sha(1), labels: [], mergedAt: "2026-09-01T00:00:00Z" };
  const listings = [
    ["not an array", { number: 1 }, /listing is not an array/],
    ["entry is null", [null], /entry 1 is not an object/],
    ["entry is an array", [[]], /entry 1 is not an object/],
    ["number zero", [{ ...good, number: 0 }], /no valid number/],
    ["number string", [{ ...good, number: "1" }], /no valid number/],
    ["number fraction", [{ ...good, number: 1.5 }], /no valid number/],
    ["number missing", [{ ...good, number: undefined }], /no valid number/],
    ["head short", [{ ...good, headRefOid: "abc123" }], /no valid head commit/],
    ["head upper case", [{ ...good, headRefOid: sha(255).toUpperCase() }], /no valid head commit/],
    ["head not a string", [{ ...good, headRefOid: 5 }], /no valid head commit/],
    ["head wrapped in an array", [{ ...good, headRefOid: [sha(1)] }], /no valid head commit/],
    ["head missing", [{ ...good, headRefOid: undefined }], /no valid head commit/],
    ["labels not an array", [{ ...good, labels: "bug" }], /no valid labels/],
    ["label not an object", [{ ...good, labels: ["bug"] }], /no valid labels/],
    ["label without a name", [{ ...good, labels: [{ id: 1 }] }], /no valid labels/],
    ["label name not a string", [{ ...good, labels: [{ name: 7 }] }], /no valid labels/],
    ["labels missing", [{ ...good, labels: undefined }], /no valid labels/],
    ["mergedAt null", [{ ...good, mergedAt: null }], /no valid merge time/],
    ["mergedAt missing", [{ ...good, mergedAt: undefined }], /no valid merge time/],
    ["mergedAt unparseable", [{ ...good, mergedAt: "yesterday-ish" }], /no valid merge time/],
    ["mergedAt a number", [{ ...good, mergedAt: 1780000000000 }], /no valid merge time/],
    ["same PR twice", [good, { ...good }], /names a pull request twice/],
    ["more entries than --limit", [good, { ...good, number: 2 }, { ...good, number: 3 }], /3 entries for --limit 2/],
  ];
  for (const [note, value, pattern] of listings) {
    const w = new World();
    w.listing = value;
    const r = record(w, [SEAT, "--limit", "2"]);
    assert.equal(r.code, 1, note);
    assert.equal(r.out, "", note);
    assert.match(r.err, pattern, note);
    assert.equal(w.commentsCalls().length, 0, note);
  }
});

test("a listing that is not JSON exits 1", () => {
  const w = new World();
  w.listingText = "HTTP 502: Bad Gateway";
  assertFailed(record(w), /not JSON/);
});

// the command ---------------------------------------------------------------

test("the script is executable and starts with the node shebang", () => {
  assert.equal(readFileSync(SCRIPT, "utf8").split("\n")[0], "#!/usr/bin/env node");
  assert.ok((statSync(SCRIPT).mode & 0o111) !== 0, "executable bit");
});

function run(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...isolatedEnv(), ...env } });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A clone whose origin's default branch carries a default-filled config. */
function cloneWithConfig(t, config = { schemaVersion: 1, shipKit: { version: "0.2.0", sha: sha(1) } }) {
  const root = tempDir(t);
  const origin = join(root, "origin");
  mkdirSync(join(origin, ".ship-kit"), { recursive: true });
  git(root, "init", "-q", "-b", BRANCH, origin);
  writeFileSync(join(origin, ".ship-kit", "config.json"), JSON.stringify(config));
  git(origin, "add", ".ship-kit/config.json");
  git(origin, "commit", "-q", "-m", "config");
  const clone = join(root, "clone");
  git(root, "clone", "-q", origin, clone);
  return clone;
}

test("run as a command: a bad seat exits 2 with a usage message and no output", () => {
  const r = run(["bogus"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /usage: shadow-record\.mjs/);
});

test("run as a command: a directory with no origin config exits 3", (t) => {
  const r = run([SEAT], { cwd: tempDir(t) });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unreadable/);
});

test("run as a command: a clone whose origin has no config exits 3", (t) => {
  const root = tempDir(t);
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", BRANCH, origin);
  writeFileSync(join(origin, "README.md"), "x\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "-q", "-m", "readme");
  git(root, "clone", "-q", origin, join(root, "clone"));
  const r = run([SEAT], { cwd: join(root, "clone") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /config\.json is absent/);
});

test("run as a command: real git, a scripted gh; one merged PR without a state prints the record and exits 0", (t) => {
  const clone = cloneWithConfig(t);
  const fake = makeFakeGhApi([
    { args: ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], stdout: JSON.stringify({ nameWithOwner: SLUG, defaultBranchRef: { name: BRANCH } }) },
    {
      args: ["pr", "list", "-R", SLUG, "--base", BRANCH, "--state", "merged", "--limit", "9", "--json", "number,headRefOid,labels,mergedAt"],
      stdout: JSON.stringify([{ number: 4, headRefOid: sha(4), labels: [], mergedAt: "2026-09-01T00:00:00Z" }]),
    },
    { args: ["api", "--paginate", "--slurp", "repos/acme/widgets/issues/4/comments?per_page=100"], stdout: "[[]]" },
  ]);
  const r = run([SEAT, "--limit", "9"], { cwd: clone, env: { PATH: `${fake.dir}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    seat: SEAT, required: 5, cleanRuns: 0, streak: [], stoppedAt: { pr: 4, reason: REASONS.noState }, truncated: false,
  });
  assert.equal(fake.calls().length, 3);
});

test("run as a command: a gh call with no answer exits 1 and prints no result", (t) => {
  const clone = cloneWithConfig(t);
  const fake = makeFakeGhApi([]);
  const r = run([SEAT], { cwd: clone, env: { PATH: `${fake.dir}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /stopped on a failed call; no record printed/);
});

test("run as a command: the promotion settings of the origin config are used", (t) => {
  const clone = cloneWithConfig(t, {
    schemaVersion: 1,
    shipKit: { version: "0.2.0", sha: sha(1) },
    review: { promotion: { cleanRuns: 3 } },
  });
  const fake = makeFakeGhApi([
    { args: ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], stdout: JSON.stringify({ nameWithOwner: SLUG, defaultBranchRef: { name: BRANCH } }) },
    {
      args: ["pr", "list", "-R", SLUG, "--base", BRANCH, "--state", "merged", "--limit", "50", "--json", "number,headRefOid,labels,mergedAt"],
      stdout: "[]",
    },
  ]);
  const r = run([SEAT], { cwd: clone, env: { PATH: `${fake.dir}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).required, 3);
});
