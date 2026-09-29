import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { loadConfig } from "../lib/config.mjs";
import { makeGh } from "../lib/gh.mjs";
import { included } from "../../tests/helpers/fake-gh-api.mjs";
import { Unreadable, defaultDeps, evaluate, main, managedChecks, readRequired } from "./required-checks.mjs";

const SCRIPT = fileURLToPath(new URL("./required-checks.mjs", import.meta.url));
const OWNER = "octo";
const NAME = "widgets";
const REPO = `${OWNER}/${NAME}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR = "7";
const GENERAL = "ship-kit general review";
const ADVERSARIAL = "ship-kit adversarial review";
const COVERAGE = "ship-kit patch coverage";
const ACTIONS = { id: 15368, slug: "github-actions" };
const SUITE_TO_RUN = 1_000_000;

const CONFIG = (() => {
  const loaded = loadConfig(JSON.stringify({ schemaVersion: 1, shipKit: { version: "0.2.0", sha: "0".repeat(40) } }));
  assert.equal(loaded.ok, true, loaded.reason);
  return loaded.config;
})();
const MANAGED = managedChecks(CONFIG);

// --- fake gh ---------------------------------------------------------------

/** Response of `gh api --include`: gh exits 1 on a non-2xx status. */
function http(status, body) {
  const ok = status >= 200 && status < 300;
  return { stdout: included(status, body), code: ok ? 0 : 1, stderr: ok ? "" : `gh: HTTP ${status}` };
}

/** Response of `gh api --paginate --slurp` over an object endpoint. */
function slurp(key, items, extra = {}) {
  const pages = [];
  for (let i = 0; i === 0 || i < items.length; i += 100) {
    pages.push({ total_count: items.length, ...extra, [key]: items.slice(i, i + 100) });
  }
  return { stdout: JSON.stringify(pages) };
}

const failed = (stderr) => ({ code: 1, stdout: "", stderr });

const getArgs = (path) => ["api", "--include", path];
const pageArgs = (path) => ["api", "--paginate", "--slurp", `${path}${path.includes("?") ? "&" : "?"}per_page=100`];

function checkRun(id, name, { status = "completed", conclusion = "success", app = ACTIONS, suite = 500 } = {}) {
  return { id, name, status, conclusion, app, check_suite: { id: suite } };
}

function statusOf(context, state = "success") {
  return { context, state, id: 1 };
}

const rsc = (...contexts) => ({
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: contexts.map((context) => ({ context, integration_id: ACTIONS.id })),
  },
  ruleset_id: 1,
});

const OTHER_RULES = [
  { type: "deletion", ruleset_id: 1 },
  { type: "pull_request", parameters: { required_approving_review_count: 0 }, ruleset_id: 1 },
];

/** The managed caller path for a check name, or the path of an ordinary workflow. */
function callerFor(name) {
  return MANAGED.get(name) ?? ".github/workflows/ci.yml";
}

/**
 * A scripted GitHub. By default every Actions check run in `all` belongs to
 * a pull_request_target run of the caller its name implies (the managed
 * caller, or ci.yml for any other name), and is a job of that run. `suites`
 * and `jobs` override those answers per check suite id and check run id;
 * `routes` overrides any call by its argument list.
 */
function world(spec = {}) {
  const branch = spec.branch ?? "main";
  const b = encodeURIComponent(branch);
  const base = `repos/${OWNER}/${NAME}`;
  const latest = spec.latest ?? [];
  const all = spec.all ?? latest;
  const routes = new Map();
  const put = (args, response) => routes.set(JSON.stringify(args), response);

  put(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { stdout: JSON.stringify(spec.repoView ?? { nameWithOwner: REPO, defaultBranchRef: { name: branch } }) });
  put(["pr", "view", PR, "-R", REPO, "--json", "headRefOid,baseRefName"],
    { stdout: JSON.stringify(spec.pr ?? { headRefOid: SHA, baseRefName: branch }) });
  put(getArgs(`${base}/branches/${b}`), spec.branchLookup ?? http(200, { name: branch, protected: true }));
  put(pageArgs(`${base}/rules/branches/${b}`), spec.rulesRoute ?? { stdout: JSON.stringify([spec.rules ?? []]) });
  put(getArgs(`${base}/branches/${b}/protection/required_status_checks`),
    spec.classic ?? http(404, { message: "Branch not protected" }));
  put(pageArgs(`${base}/commits/${SHA}/check-runs?filter=latest`), spec.latestRoute ?? slurp("check_runs", latest));
  put(pageArgs(`${base}/commits/${SHA}/check-runs?filter=all`), spec.allRoute ?? slurp("check_runs", all));
  put(pageArgs(`${base}/commits/${SHA}/status`),
    spec.statusRoute ?? slurp("statuses", spec.statuses ?? [], { state: "pending", sha: SHA }));

  const suites = spec.suites ?? {};
  const jobs = spec.jobs ?? {};
  for (const run of all) {
    const suite = run && run.check_suite ? run.check_suite.id : undefined;
    if (!Number.isSafeInteger(suite)) continue;
    const runsArgs = pageArgs(`${base}/actions/runs?check_suite_id=${suite}`);
    if (!routes.has(JSON.stringify(runsArgs))) {
      const answer = suites[suite] ?? [{
        id: suite + SUITE_TO_RUN, check_suite_id: suite, event: "pull_request_target",
        path: callerFor(run.name), repository: { full_name: REPO },
      }];
      put(runsArgs, Array.isArray(answer) ? slurp("workflow_runs", answer) : answer);
    }
    put(getArgs(`${base}/actions/jobs/${run.id}`), jobs[run.id] ?? http(200, { id: run.id, run_id: suite + SUITE_TO_RUN, name: run.name }));
  }
  for (const [args, response] of spec.routes ?? []) put(args, response);

  const calls = [];
  const run = (file, args) => {
    assert.equal(file, "gh");
    calls.push(args);
    const route = routes.get(JSON.stringify(args));
    const answer = route ?? failed(`fake gh: no route for ${JSON.stringify(args)}`);
    if (answer.code) {
      const error = new Error(`gh exited ${answer.code}`);
      error.status = answer.code;
      error.stdout = answer.stdout ?? "";
      error.stderr = answer.stderr ?? "";
      throw error;
    }
    return answer.stdout ?? "";
  };
  return { gh: makeGh({ run }), calls };
}

function fakeGit(overrides = {}) {
  return (args) => {
    assert.equal(args[0], "check-ref-format");
    assert.equal(args[1], "--branch");
    if (overrides.throws) throw new Error("git check-ref-format exited 1");
    return `${overrides.output ?? args[2]}\n`;
  };
}

function runMain(spec = {}, { argv = [PR], git = fakeGit(), readConfig } = {}) {
  const w = world(spec);
  const branch = spec.branch ?? "main";
  const out = [];
  const err = [];
  const io = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } };
  const deps = { gh: w.gh, git, readConfig: readConfig ?? (() => ({ ok: true, config: CONFIG, branch, sha: "f".repeat(40) })) };
  const code = main(argv, deps, io);
  return { code, out: out.join(""), err: err.join(""), calls: w.calls };
}

function states(results) {
  return Object.fromEntries(results.map((r) => [r.context, r.state]));
}

function judge(spec, contexts, managed = MANAGED) {
  const w = world(spec);
  return { results: evaluate({ gh: w.gh, repo: REPO, sha: SHA, contexts, managed, defaultBranch: spec.branch ?? "main" }), calls: w.calls };
}

function required(spec) {
  const w = world(spec);
  return readRequired({ gh: w.gh, repo: REPO, branch: spec.branch ?? "main" });
}

const unreadable = (pattern) => (error) => error instanceof Unreadable && pattern.test(error.message);

// --- managedChecks ---------------------------------------------------------

test("managedChecks maps every render.checks name except coverage to its caller path", () => {
  assert.deepEqual([...MANAGED.entries()].sort(), [
    [ADVERSARIAL, ".github/workflows/ship-kit-adversarial.yml"],
    ["ship-kit change class", ".github/workflows/ship-kit-change-class.yml"],
    [GENERAL, ".github/workflows/ship-kit-general.yml"],
    ["ship-kit security review", ".github/workflows/ship-kit-security.yml"],
    ["ship-kit test-integrity review", ".github/workflows/ship-kit-test-integrity.yml"],
  ]);
  assert.equal(MANAGED.has(COVERAGE), false);
});

test("managedChecks follows renamed checks", () => {
  const loaded = loadConfig(JSON.stringify({
    schemaVersion: 1, shipKit: { version: "0.2.0", sha: "0".repeat(40) },
    render: { checks: { general: "review (general)" } },
  }));
  assert.equal(loaded.ok, true, loaded.reason);
  const managed = managedChecks(loaded.config);
  assert.equal(managed.get("review (general)"), ".github/workflows/ship-kit-general.yml");
  assert.equal(managed.has(GENERAL), false);
});

// --- readRequired: sources -------------------------------------------------

test("classic only: contexts plus checks[].context", () => {
  const classic = http(200, { strict: false, contexts: ["build"], checks: [{ context: "lint", app_id: 1 }, { context: "build", app_id: null }] });
  assert.deepEqual(required({ rules: [], classic }), ["build", "lint"]);
});

test("rulesets only: every required_status_checks rule's contexts", () => {
  assert.deepEqual(required({ rules: [...OTHER_RULES, rsc("gitleaks", "ci")] }), ["ci", "gitleaks"]);
});

test("both: the union of rulesets and classic protection, sorted and unique", () => {
  const classic = http(200, { strict: true, contexts: ["ci", "build"], checks: [{ context: "build", app_id: 1 }] });
  assert.deepEqual(required({ rules: [rsc("gitleaks", "ci"), rsc("lint")], classic }), ["build", "ci", "gitleaks", "lint"]);
});

test("classic 404 with a ruleset contributes nothing", () => {
  const classic = http(404, { message: "Branch not protected" });
  assert.deepEqual(required({ rules: [rsc("ci")], classic }), ["ci"]);
});

test("a required_status_checks rule on the second page of rules is read", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ type: "deletion", ruleset_id: i + 1 }));
  assert.deepEqual(required({ rulesRoute: { stdout: JSON.stringify([page1, [rsc("late")]]) } }), ["late"]);
});

test("both empty refuses (exit 3)", () => {
  assert.throws(() => required({ rules: OTHER_RULES }), unreadable(/no required checks found; refusing/));
  const r = runMain({ rules: OTHER_RULES });
  assert.equal(r.code, 3);
  assert.match(r.err, /no required checks found; refusing/);
  assert.equal(r.out, "");
});

test("a rulesets 403 is unreadable (exit 3)", () => {
  const rulesRoute = failed("gh: Resource not accessible by integration (HTTP 403)");
  assert.throws(() => required({ rulesRoute }), unreadable(/rulesets.*HTTP 403/s));
  const r = runMain({ rulesRoute, classic: http(200, { contexts: ["ci"], checks: [] }), latest: [checkRun(1, "ci")] });
  assert.equal(r.code, 3);
  assert.match(r.err, /rulesets/);
});

test("a classic protection 403 is unreadable (exit 3), never read as 404", () => {
  const classic = http(403, { message: "Resource not accessible by integration" });
  assert.throws(() => required({ rules: [rsc("ci")], classic }), unreadable(/classic protection.*HTTP 403/));
  const r = runMain({ rules: [rsc("ci")], classic, latest: [checkRun(1, "ci")] });
  assert.equal(r.code, 3);
  assert.match(r.err, /classic protection returned HTTP 403/);
});

test("any other classic status is unreadable", () => {
  for (const status of [301, 422, 500, 502]) {
    assert.throws(() => required({ rules: [rsc("ci")], classic: http(status, { message: "x" }) }), unreadable(new RegExp(`HTTP ${status}`)));
  }
});

test("a ruleset response that is not an array is unreadable (exit 3)", () => {
  const rulesRoute = { stdout: JSON.stringify([{ message: "not a list" }]) };
  assert.throws(() => required({ rulesRoute, classic: http(200, { contexts: ["ci"], checks: [] }) }), unreadable(/rulesets.*not an array/));
  assert.equal(runMain({ rulesRoute, classic: http(200, { contexts: ["ci"], checks: [] }), latest: [checkRun(1, "ci")] }).code, 3);
});

test("a malformed rule or required_status_checks entry is unreadable, never skipped", () => {
  const bad = [
    ["rule not an object", ["x"]],
    ["rule without a type", [{ parameters: {} }]],
    ["no parameters", [{ type: "required_status_checks" }]],
    ["parameters not an object", [{ type: "required_status_checks", parameters: [] }]],
    ["checks not an array", [{ type: "required_status_checks", parameters: { required_status_checks: {} } }]],
    ["entry not an object", [{ type: "required_status_checks", parameters: { required_status_checks: ["ci"] } }]],
    ["context not a string", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: 5 }] } }]],
    ["empty context", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "" }] } }]],
  ];
  for (const [label, rules] of bad) {
    assert.throws(() => required({ rules: [rsc("ci"), ...rules] }), unreadable(/rulesets/), label);
  }
});

test("a malformed classic protection body is unreadable", () => {
  const bad = [
    ["not an object", ["ci"]],
    ["contexts missing", { checks: [] }],
    ["checks missing", { contexts: ["ci"] }],
    ["contexts not strings", { contexts: [1], checks: [] }],
    ["empty context", { contexts: [""], checks: [] }],
    ["check not an object", { contexts: [], checks: ["ci"] }],
    ["check context not a string", { contexts: [], checks: [{ context: null }] }],
  ];
  for (const [label, body] of bad) {
    assert.throws(() => required({ rules: [], classic: http(200, body) }), unreadable(/classic protection/), label);
  }
});

test("a gh failure on the classic read is unreadable", () => {
  assert.throws(() => required({ rules: [rsc("ci")], classic: { code: 1, stdout: "", stderr: "connection reset" } }), unreadable(/classic protection/));
});

// --- readRequired: the branch reads are about this exact branch -------------

test("the rules read for a missing or mis-encoded branch is refused, even when rules exist for that name", () => {
  // rules/branches answers 200 [] (or an ~ALL ruleset's rules) for a name
  // that is no branch, so only the branch lookup shows the name was wrong.
  const rules = [rsc("lint")];
  assert.throws(() => required({ rules, branchLookup: http(404, { message: "Branch not found" }) }), unreadable(/branch lookup.*HTTP 404/));
  assert.throws(() => required({ rules, branchLookup: http(200, { name: "Main" }) }), unreadable(/resolved to "Main"/));
  assert.throws(() => required({ rules, branchLookup: http(200, ["main"]) }), unreadable(/branch lookup/));
  assert.throws(() => required({ rules, branchLookup: { code: 1, stdout: "", stderr: "timeout" } }), unreadable(/branch lookup/));
  const r = runMain({ rules, branchLookup: http(404, { message: "Branch not found" }), latest: [checkRun(1, "lint")] });
  assert.equal(r.code, 3);
});

test("readRequired rejects a non-string or empty branch", () => {
  const w = world();
  assert.throws(() => readRequired({ gh: w.gh, repo: REPO, branch: "" }), TypeError);
  assert.throws(() => readRequired({ gh: w.gh, repo: REPO, branch: 5 }), TypeError);
  assert.throws(() => readRequired({ gh: w.gh, repo: "no-slash", branch: "main" }), TypeError);
});

// --- evaluate: states --------------------------------------------------------

test("green: every latest check run success, neutral or skipped, and every status success", () => {
  const latest = [checkRun(1, "a"), checkRun(2, "b", { conclusion: "neutral" }), checkRun(3, "c", { conclusion: "skipped" }), checkRun(4, "d")];
  const statuses = [statusOf("d"), statusOf("e")];
  const { results } = judge({ latest, statuses }, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(states(results), { a: "green", b: "green", c: "green", d: "green", e: "green" });
});

test("a pending context: a run not completed, or a pending status", () => {
  const latest = [checkRun(1, "a", { status: "in_progress", conclusion: null }), checkRun(2, "b", { status: "queued", conclusion: null }), checkRun(3, "c")];
  const statuses = [statusOf("c", "pending"), statusOf("d", "pending")];
  const { results } = judge({ latest, statuses }, ["a", "b", "c", "d"]);
  assert.deepEqual(states(results), { a: "pending", b: "pending", c: "pending", d: "pending" });
});

test("a missing context: no check run and no status carries it", () => {
  const { results } = judge({ latest: [checkRun(1, "other")], statuses: [statusOf("also-other")] }, ["ci"]);
  assert.deepEqual(states(results), { ci: "missing" });
});

test("a status failing and a check run succeeding under one name is failing", () => {
  const { results } = judge({ latest: [checkRun(1, "ci")], statuses: [statusOf("ci", "failure")] }, ["ci"]);
  assert.deepEqual(states(results), { ci: "failing" });
  const r = runMain({ rules: [rsc("ci")], latest: [checkRun(1, "ci")], statuses: [statusOf("ci", "error")] });
  assert.equal(r.code, 1);
  assert.match(r.out, /^failing "ci"/m);
});

test("cancelled is failing, as is every failing conclusion and anything unknown", () => {
  const conclusions = ["cancelled", "failure", "timed_out", "action_required", "startup_failure", "stale", null, "surprise"];
  const latest = conclusions.map((conclusion, i) => checkRun(i + 1, `c${i}`, { conclusion }));
  const { results } = judge({ latest }, latest.map((r) => r.name));
  assert.ok(results.every((r) => r.state === "failing"), JSON.stringify(results));
  const { results: fromStatus } = judge({ statuses: [statusOf("e", "error"), statusOf("u", "weird")] }, ["e", "u"]);
  assert.deepEqual(states(fromStatus), { e: "failing", u: "failing" });
});

test("failing outranks pending, and one failing run among green ones is failing", () => {
  const latest = [checkRun(1, "ci"), checkRun(2, "ci", { status: "in_progress", conclusion: null }), checkRun(3, "ci", { conclusion: "failure" })];
  assert.deepEqual(states(judge({ latest }, ["ci"]).results), { ci: "failing" });
});

test("101 check runs are all evaluated: a failure on the second page counts", () => {
  const latest = Array.from({ length: 101 }, (_, i) => checkRun(i + 1, "ci", { conclusion: i === 100 ? "failure" : "success" }));
  const { results, calls } = judge({ latest }, ["ci"]);
  assert.deepEqual(states(results), { ci: "failing" });
  assert.ok(calls.some((a) => a.includes("--paginate")));
});

test("a total_count mismatch is unreadable (exit 3)", () => {
  const latestRoute = { stdout: JSON.stringify([{ total_count: 3, check_runs: [checkRun(1, "ci"), checkRun(2, "ci")] }]) };
  assert.throws(() => judge({ latestRoute }, ["ci"]), unreadable(/check runs.*collected 2 of 3/));
  assert.equal(runMain({ rules: [rsc("ci")], latestRoute }).code, 3);
  const statusRoute = { stdout: JSON.stringify([{ total_count: 2, statuses: [statusOf("ci")] }]) };
  assert.throws(() => judge({ latest: [checkRun(1, "ci")], statusRoute }, ["ci"]), unreadable(/commit statuses/));
});

test("malformed check runs or statuses are unreadable", () => {
  const bad = [
    { latest: [{ id: 1, name: 5, status: "completed", conclusion: "success" }] },
    { latest: [{ id: 1, name: "ci", conclusion: "success" }] },
    { latest: ["ci"] },
    { statuses: [{ context: "ci" }] },
    { statuses: [{ state: "success" }] },
    { statuses: [null] },
  ];
  for (const spec of bad) assert.throws(() => judge(spec, ["ci"]), Unreadable, JSON.stringify(spec));
});

test("evaluate refuses an empty or invalid context list", () => {
  const w = world();
  for (const contexts of [[], undefined, "ci", [""], [5]]) {
    assert.throws(() => evaluate({ gh: w.gh, repo: REPO, sha: SHA, contexts, managed: MANAGED, defaultBranch: "main" }),
      unreadable(/no required checks found; refusing/));
  }
});

test("evaluate refuses a head SHA that is not 40 lower-case hex", () => {
  const w = world();
  for (const sha of ["abc", SHA.toUpperCase(), `${SHA}0`, undefined]) {
    assert.throws(() => evaluate({ gh: w.gh, repo: REPO, sha, contexts: ["ci"], managed: MANAGED, defaultBranch: "main" }), unreadable(/head SHA/));
  }
});

test("evaluate rejects a bad managed map or default branch", () => {
  const w = world();
  const call = (extra) => evaluate({ gh: w.gh, repo: REPO, sha: SHA, contexts: ["ci"], managed: MANAGED, defaultBranch: "main", ...extra });
  assert.throws(() => call({ managed: {} }), TypeError);
  assert.throws(() => call({ managed: new Map([["x", ".github/workflows/other.yml"]]) }), TypeError);
  assert.throws(() => call({ managed: new Map([["x", 5]]) }), TypeError);
  assert.throws(() => call({ defaultBranch: "" }), TypeError);
});

// --- evaluate: provenance -----------------------------------------------------

test("a managed context whose check runs all come from its caller is green", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 })];
  const { results } = judge({ latest }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "green" });
  assert.match(results[0].reason, /ship-kit-general\.yml/);
});

test("the caller path may carry @refs/heads/<default branch>", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 })];
  const suites = { 501: [{ id: 77, check_suite_id: 501, event: "pull_request_target", path: ".github/workflows/ship-kit-general.yml@refs/heads/main", repository: { full_name: REPO } }] };
  const jobs = { 10: http(200, { id: 10, run_id: 77, name: GENERAL }) };
  assert.deepEqual(states(judge({ latest, suites, jobs }, [GENERAL]).results), { [GENERAL]: "green" });
  const other = { 501: [{ ...suites[501][0], path: ".github/workflows/ship-kit-general.yml@refs/heads/feature" }] };
  assert.deepEqual(states(judge({ latest, suites: other, jobs }, [GENERAL]).results), { [GENERAL]: "forged" });
});

test("a failed first attempt fixed by a full re-run is green on latest", () => {
  // Both attempts are jobs of one workflow run in one check suite.
  const attempt1 = checkRun(10, GENERAL, { suite: 501, conclusion: "failure" });
  const attempt2 = checkRun(11, GENERAL, { suite: 501 });
  const { results } = judge({ latest: [attempt2], all: [attempt1, attempt2] }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "green" });
});

test("a same-named check from a second workflow is forged (exit 1), even when it is older", () => {
  const genuine = checkRun(20, GENERAL, { suite: 502 });
  const forged = checkRun(19, GENERAL, { suite: 499 });
  const suites = { 499: [{ id: 66, check_suite_id: 499, event: "pull_request", path: ".github/workflows/sneaky.yml", repository: { full_name: REPO } }] };
  const jobs = { 19: http(200, { id: 19, run_id: 66, name: GENERAL }) };
  const { results } = judge({ latest: [genuine], all: [forged, genuine], suites, jobs }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  const r = runMain({ rules: [rsc(GENERAL)], latest: [genuine], all: [forged, genuine], suites, jobs });
  assert.equal(r.code, 1);
  assert.match(r.out, /^forged "ship-kit general review"/m);
});

test("a same-named check from a pull_request_target run of another workflow is forged", () => {
  const latest = [checkRun(20, GENERAL, { suite: 502 })];
  const suites = { 502: [{ id: 67, check_suite_id: 502, event: "pull_request_target", path: ".github/workflows/ship-kit-adversarial.yml", repository: { full_name: REPO } }] };
  const jobs = { 20: http(200, { id: 20, run_id: 67, name: GENERAL }) };
  assert.deepEqual(states(judge({ latest, suites, jobs }, [GENERAL]).results), { [GENERAL]: "forged" });
});

test("a same-named check from another app is forged", () => {
  const latest = [checkRun(20, GENERAL, { suite: 502 }), checkRun(21, GENERAL, { suite: 503, app: { id: 9, slug: "some-ci-app" } })];
  const { results, calls } = judge({ latest }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  assert.match(results[0].reason, /"some-ci-app"/);
  assert.equal(calls.some((a) => a.join(" ").includes("check_suite_id=503")), false);
});

test("a check run with no app or no check suite id is forged", () => {
  for (const run of [
    { ...checkRun(20, GENERAL), app: null },
    { ...checkRun(20, GENERAL), check_suite: null },
    { ...checkRun(20, GENERAL), check_suite: { id: "501" } },
  ]) {
    const w = world({ latest: [run], routes: [] });
    const results = evaluate({ gh: w.gh, repo: REPO, sha: SHA, contexts: [GENERAL], managed: MANAGED, defaultBranch: "main" });
    assert.deepEqual(states(results), { [GENERAL]: "forged" }, JSON.stringify(run));
  }
});

test("a managed context carried only by a success status is forged", () => {
  const { results } = judge({ statuses: [statusOf(GENERAL)] }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  assert.match(results[0].reason, /commit status/);
});

test("a managed context whose check runs all pass provenance plus a same-named success status is forged", () => {
  const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], statuses: [statusOf(GENERAL)] }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
});

test("a managed context with no check run and no status is missing, never green", () => {
  const { results, calls } = judge({ latest: [checkRun(1, "ci")] }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "missing" });
  assert.ok(calls.some((a) => a.join(" ").includes("filter=all")));
  const r = runMain({ rules: [rsc(GENERAL)], latest: [checkRun(1, "ci")] });
  assert.equal(r.code, 1);
});

test("a managed check run seen only in the full listing still needs provenance", () => {
  const stray = checkRun(30, GENERAL, { suite: 504 });
  const suites = { 504: [{ id: 68, check_suite_id: 504, event: "push", path: ".github/workflows/x.yml", repository: { full_name: REPO } }] };
  assert.deepEqual(states(judge({ latest: [], all: [stray], suites }, [GENERAL]).results), { [GENERAL]: "forged" });
  assert.deepEqual(states(judge({ latest: [], all: [stray] }, [GENERAL]).results), { [GENERAL]: "missing" });
});

test("a managed check run on filter=latest but absent from filter=all is forged", () => {
  const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], all: [] }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  assert.match(results[0].reason, /filter=all/);
});

test("provenance refuses a check suite with zero workflow runs (a non-Actions suite)", () => {
  const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], suites: { 501: [] } }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  assert.match(results[0].reason, /0 workflow runs/);
});

test("provenance refuses a check suite with more than one workflow run", () => {
  const one = { id: 1000501, check_suite_id: 501, event: "pull_request_target", path: ".github/workflows/ship-kit-general.yml", repository: { full_name: REPO } };
  const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], suites: { 501: [one, { ...one, id: 5 }] } }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
});

test("provenance refuses a listed workflow run of another check suite or repository", () => {
  const base = { id: 1000501, check_suite_id: 501, event: "pull_request_target", path: ".github/workflows/ship-kit-general.yml", repository: { full_name: REPO } };
  for (const run of [{ ...base, check_suite_id: 9 }, { ...base, repository: { full_name: "someone/else" } }, { ...base, repository: null }, { ...base, id: "x" }, "run"]) {
    const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], suites: { 501: [run] } }, [GENERAL]);
    assert.deepEqual(states(results), { [GENERAL]: "forged" }, JSON.stringify(run));
  }
  const upper = { ...base, repository: { full_name: REPO.toUpperCase() } };
  assert.deepEqual(states(judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], suites: { 501: [upper] } }, [GENERAL]).results), { [GENERAL]: "green" });
});

test("provenance refuses a run whose event is not pull_request_target", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch", "issue_comment", undefined]) {
    const suites = { 501: [{ id: 1000501, check_suite_id: 501, event, path: ".github/workflows/ship-kit-general.yml", repository: { full_name: REPO } }] };
    const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], suites }, [GENERAL]);
    assert.deepEqual(states(results), { [GENERAL]: "forged" }, String(event));
  }
});

test("a check run posted through the Checks API into the caller's suite is forged: it is no job of that run", () => {
  const genuine = checkRun(10, GENERAL, { suite: 501 });
  const posted = checkRun(11, GENERAL, { suite: 501 });
  const jobs = { 11: http(404, { message: "Not Found" }) };
  const { results } = judge({ latest: [genuine, posted], jobs }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "forged" });
  assert.match(results[0].reason, /not a job/);
});

test("a job lookup naming another run, another id or another name is forged", () => {
  for (const job of [{ id: 10, run_id: 1, name: GENERAL }, { id: 99, run_id: 1000501, name: GENERAL }, { id: 10, run_id: 1000501, name: "other" }, ["job"]]) {
    const { results } = judge({ latest: [checkRun(10, GENERAL, { suite: 501 })], jobs: { 10: http(200, job) } }, [GENERAL]);
    assert.deepEqual(states(results), { [GENERAL]: "forged" }, JSON.stringify(job));
  }
});

test("a failed provenance lookup is unreadable, never green", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 })];
  assert.throws(() => judge({ latest, jobs: { 10: http(500, { message: "boom" }) } }, [GENERAL]), unreadable(/job lookup.*HTTP 500/));
  assert.throws(() => judge({ latest, jobs: { 10: { code: 1, stdout: "", stderr: "timeout" } } }, [GENERAL]), unreadable(/job lookup/));
  assert.throws(() => judge({ latest, suites: { 501: failed("gh: HTTP 502") } }, [GENERAL]), unreadable(/workflow runs/));
  assert.throws(() => judge({ latest, allRoute: failed("gh: HTTP 502") }, [GENERAL]), unreadable(/check runs/));
});

test("provenance lookups are shared: one runs listing per check suite", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 }), checkRun(11, GENERAL, { suite: 501 })];
  const { results, calls } = judge({ latest }, [GENERAL]);
  assert.deepEqual(states(results), { [GENERAL]: "green" });
  assert.equal(calls.filter((a) => a.join(" ").includes("check_suite_id=501")).length, 1);
});

test("a context that is not managed is judged on its state alone", () => {
  const latest = [checkRun(1, "ci", { suite: 600 })];
  const suites = { 600: [{ id: 3, check_suite_id: 600, event: "pull_request", path: ".github/workflows/anything.yml", repository: { full_name: REPO } }] };
  const { results, calls } = judge({ latest, suites, statuses: [statusOf("ci")] }, ["ci"]);
  assert.deepEqual(states(results), { ci: "green" });
  assert.equal(calls.some((a) => a.join(" ").includes("filter=all")), false);
  assert.equal(calls.some((a) => a.join(" ").includes("actions/")), false);
});

test("the coverage context is exempt from provenance when the config is readable", () => {
  const latest = [checkRun(1, COVERAGE, { suite: 600 })];
  const suites = { 600: [{ id: 3, check_suite_id: 600, event: "pull_request", path: ".github/workflows/test.yml", repository: { full_name: REPO } }] };
  assert.deepEqual(states(judge({ latest, suites }, [COVERAGE]).results), { [COVERAGE]: "green" });
});

test("an unreadable config makes every ship-kit-named context forged and judges the rest", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 }), checkRun(1, "ci"), checkRun(2, COVERAGE)];
  const { results } = judge({ latest }, [COVERAGE, GENERAL, "Ship-Kit custom", "ci", "missing-one"], null);
  assert.deepEqual(states(results), {
    [COVERAGE]: "forged", [GENERAL]: "forged", "Ship-Kit custom": "forged", ci: "green", "missing-one": "missing",
  });
  assert.match(results[0].reason, /config/);
});

// --- main -------------------------------------------------------------------

test("main exits 0 when every required context is green, and prints one line per context", () => {
  const latest = [checkRun(1, "ci"), checkRun(2, "gitleaks"), checkRun(10, GENERAL, { suite: 501 }), checkRun(11, ADVERSARIAL, { suite: 502 })];
  const r = runMain({ rules: [rsc("gitleaks", "ci", GENERAL, ADVERSARIAL)], latest });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  const lines = r.out.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 4).map((l) => l.split(" -- ")[0]), [
    'green "ci"', 'green "gitleaks"', `green "${ADVERSARIAL}"`, `green "${GENERAL}"`,
  ]);
  assert.match(lines[2], /provenance: pull_request_target run of \.github\/workflows\/ship-kit-adversarial\.yml/);
  assert.equal(lines[4], `4 of 4 required checks green on ${SHA}`);
});

test("main exits 1 when any context is not green", () => {
  for (const latest of [
    [checkRun(1, "ci", { conclusion: "failure" })],
    [checkRun(1, "ci", { status: "in_progress", conclusion: null })],
    [],
  ]) {
    const r = runMain({ rules: [rsc("ci")], latest });
    assert.equal(r.code, 1, JSON.stringify(latest));
    assert.match(r.out, /0 of 1 required checks green/);
  }
});

test("a default branch named release/1.x is read through encoded paths", () => {
  const branch = "release/1.x";
  const r = runMain({ branch, rules: [rsc("ci")], latest: [checkRun(1, "ci")] });
  assert.equal(r.code, 0, r.err);
  const argv = r.calls.map((a) => a.join(" "));
  assert.ok(argv.includes(`api --include repos/${REPO}/branches/release%2F1.x`), argv.join("\n"));
  assert.ok(argv.includes(`api --paginate --slurp repos/${REPO}/rules/branches/release%2F1.x?per_page=100`), argv.join("\n"));
  assert.ok(argv.includes(`api --include repos/${REPO}/branches/release%2F1.x/protection/required_status_checks`), argv.join("\n"));
  const apiPaths = r.calls.filter((a) => a[0] === "api").map((a) => a[a.length - 1]);
  assert.equal(apiPaths.some((p) => p.includes("release/1.x") || p.includes("%25")), false, apiPaths.join("\n"));
});

test("main exits 3 when the head SHA is not 40 hex", () => {
  for (const headRefOid of ["abc123", SHA.toUpperCase(), `${SHA}00`, null]) {
    const r = runMain({ rules: [rsc("ci")], latest: [checkRun(1, "ci")], pr: { headRefOid, baseRefName: "main" } });
    assert.equal(r.code, 3, String(headRefOid));
    assert.match(r.err, /PR 7 head SHA/);
  }
});

test("main exits 3 when the PR targets another branch", () => {
  const r = runMain({ rules: [rsc("ci")], latest: [checkRun(1, "ci")], pr: { headRefOid: SHA, baseRefName: "develop" } });
  assert.equal(r.code, 3);
  assert.match(r.err, /targets "develop"/);
});

test("main exits 3 on an unusable repository answer", () => {
  for (const repoView of [
    { nameWithOwner: "not a slug", defaultBranchRef: { name: "main" } },
    { nameWithOwner: REPO, defaultBranchRef: null },
    { nameWithOwner: REPO, defaultBranchRef: { name: "" } },
    [],
  ]) {
    const r = runMain({ repoView, rules: [rsc("ci")] });
    assert.equal(r.code, 3, JSON.stringify(repoView));
  }
  const notJson = runMain({ routes: [[["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { stdout: "<html>" }]] });
  assert.equal(notJson.code, 3);
  assert.match(notJson.err, /not JSON/);
});

test("main accepts git output as a Buffer", () => {
  const git = (args) => Buffer.from(`${args[2]}\n`);
  assert.equal(runMain({ rules: [rsc("ci")], latest: [checkRun(1, "ci")] }, { git }).code, 0);
});

test("main exits 3 when the PR answer is not an object", () => {
  const r = runMain({ pr: [], rules: [rsc("ci")] });
  assert.equal(r.code, 3);
  assert.match(r.err, /head SHA undefined/);
});

test("main prints the config note before refusing", () => {
  const r = runMain({ rules: OTHER_RULES }, { readConfig: () => ({ ok: false, reason: "invalid JSON" }) });
  assert.equal(r.code, 3);
  assert.match(r.err, /config unreadable: invalid JSON\n.*refusing: no required checks found; refusing/s);
});

test("defaultDeps reads the config through git in the given directory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "required-checks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "-q", dir], { env: { ...isolatedEnv(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(init.status, 0);
  const deps = defaultDeps(dir);
  assert.equal(typeof deps.gh.get, "function");
  assert.equal(String(deps.git(["check-ref-format", "--branch", "release/1.x"])).trim(), "release/1.x");
  const config = deps.readConfig();
  assert.equal(config.ok, false);
  assert.match(config.reason, /origin/);
});

test("main exits 3 when git rejects the default branch name", () => {
  assert.equal(runMain({ rules: [rsc("ci")] }, { git: fakeGit({ throws: true }) }).code, 3);
  assert.equal(runMain({ rules: [rsc("ci")] }, { git: fakeGit({ output: "other" }) }).code, 3);
  const dash = runMain({ branch: "-x", rules: [rsc("ci")] });
  assert.equal(dash.code, 3);
  assert.match(dash.err, /not a valid branch name/);
});

test("main exits 3 when a gh command fails", () => {
  const r = runMain({ routes: [[["pr", "view", PR, "-R", REPO, "--json", "headRefOid,baseRefName"], failed("no pull requests found")]] });
  assert.equal(r.code, 3);
  assert.match(r.err, /no pull requests found/);
});

test("main exits 2 on usage errors, before any call", () => {
  for (const argv of [[], ["7", "8"], ["abc"], ["0"], ["-7"], ["07"], ["7.0"], ["12345678901"]]) {
    const r = runMain({}, { argv });
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /usage: required-checks\.mjs <pr>/);
    assert.equal(r.calls.length, 0);
  }
});

test("main reports managed contexts forged when the config is unreadable", () => {
  const latest = [checkRun(1, "ci"), checkRun(10, GENERAL, { suite: 501 })];
  const r = runMain({ rules: [rsc("ci", GENERAL)], latest }, { readConfig: () => ({ ok: false, reason: ".ship-kit/config.json is absent at refs/ship-kit/default" }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /^green "ci"/m);
  assert.match(r.out, /^forged "ship-kit general review"/m);
  assert.match(r.err, /config.*absent/);
});

test("main treats a config read from another branch, or a config read that throws, as unreadable", () => {
  const latest = [checkRun(10, GENERAL, { suite: 501 })];
  const spec = { rules: [rsc(GENERAL)], latest };
  const other = runMain(spec, { readConfig: () => ({ ok: true, config: CONFIG, branch: "develop", sha: "f".repeat(40) }) });
  assert.equal(other.code, 1);
  assert.match(other.out, /^forged/m);
  assert.match(other.err, /"develop"/);
  const threw = runMain(spec, { readConfig: () => { throw new Error("git missing"); } });
  assert.equal(threw.code, 1);
  assert.match(threw.err, /git missing/);
  const odd = runMain(spec, { readConfig: () => { throw "odd"; } }); // eslint-disable-line no-throw-literal
  assert.equal(odd.code, 1);
});

test("main exits 3 on a null repository answer and on any unexpected error", () => {
  const r = runMain({ routes: [[["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { stdout: "null" }]] });
  assert.equal(r.code, 3);
  const err = [];
  const io = { out: { write() {} }, err: { write: (s) => err.push(s) } };
  const gh = { cli() { throw "odd"; } }; // eslint-disable-line no-throw-literal
  assert.equal(main([PR], { gh, git: fakeGit(), readConfig: () => ({ ok: false, reason: "x" }) }, io), 3);
  assert.match(err.join(""), /odd/);
});

test("running the script with no argument prints usage and exits 2", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { env: isolatedEnv(), encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: required-checks\.mjs <pr>/);
});

test("main's default dependencies are built without any call when usage fails", () => {
  const err = [];
  assert.equal(main([], undefined, { out: { write() {} }, err: { write: (s) => err.push(s) } }), 2);
  assert.match(err.join(""), /usage/);
});
