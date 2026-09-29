#!/usr/bin/env node
// Reads the required status checks of the default branch and judges each
// one on a pull request's head commit (design 16.3, 20.1).
//
// Required contexts are the union of every active ruleset's
// required_status_checks rule and classic branch protection's required
// status checks. A 404 from classic protection means none; any other
// failure of either read is "unreadable", and so is an empty union: an
// agent must never read "nothing required" as "everything green". The
// rulesets endpoint answers 200 with no rules for a name that is no branch,
// so the branch itself is looked up first and must come back under exactly
// the name asked for; a wrongly encoded name is refused rather than read as
// unprotected.
//
// Each context is green, failing, pending, missing or forged. A context
// named in the default branch's `render.checks` (coverage excepted) counts
// only when every check run of that name on the head, across all attempts,
// is a job of a pull_request_target run of its managed caller and no
// commit status carries the name; anything else is forged, which outranks
// every other state. With the config unreadable, every context named
// `ship-kit...` is forged, since its provenance cannot be proven.
//
// Usage: node scripts/merge/required-checks.mjs <pr>
// Exit 0: every required context is green. Exit 1: at least one is not.
// Exit 2: usage. Exit 3: unreadable, or no required checks at all.
// Network: `gh` calls to the current repository's GitHub API, and the
// config fetch of the default branch from `origin`.

import { pathToFileURL } from "node:url";
import { makeGit, readDefaultBranchConfig } from "../lib/config.mjs";
import { api, makeGh, repoSlug, seg } from "../lib/gh.mjs";
import { callerPathMatches } from "../review/trust-state.mjs";

export class Unreadable extends Error {
  constructor(message) {
    super(message);
    this.name = "Unreadable";
  }
}

export const STATES = Object.freeze(["green", "failing", "pending", "missing", "forged"]);

const USAGE = "usage: required-checks.mjs <pr>";
const PR = /^[1-9][0-9]{0,9}$/;
const SHA = /^[0-9a-f]{40}$/;
const CALLER = /^\.github\/workflows\/ship-kit-([a-z][a-z-]*)\.yml$/;
const SHIP_KIT_NAME = /^\s*ship-kit/i;
const ACTIONS_APP = "github-actions";
const CALLER_EVENT = "pull_request_target";
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const NO_CHECKS = "no required checks found; refusing";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isName(value) {
  return typeof value === "string" && value !== "";
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one read; any failure becomes Unreadable naming `what`. */
function reading(what, read) {
  try {
    return read();
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    throw new Unreadable(`${what}: ${messageOf(error)}`);
  }
}

/**
 * The contexts with provenance: every `render.checks` name except coverage,
 * mapped to its managed caller's path.
 * @param {{render: {checks: Record<string, string>}}} config a loaded config
 * @returns {Map<string, string>}
 */
export function managedChecks(config) {
  const managed = new Map();
  for (const [key, context] of Object.entries(config.render.checks)) {
    if (key !== "coverage") managed.set(context, `.github/workflows/ship-kit-${key}.yml`);
  }
  return managed;
}

function rulesetContexts(rules, into) {
  rules.forEach((rule, i) => {
    if (!isPlainObject(rule) || typeof rule.type !== "string") {
      throw new Unreadable(`rulesets: rule ${i + 1} is not an object with a type`);
    }
    if (rule.type !== "required_status_checks") return;
    const list = isPlainObject(rule.parameters) ? rule.parameters.required_status_checks : undefined;
    if (!Array.isArray(list)) throw new Unreadable(`rulesets: rule ${i + 1} has no required_status_checks list`);
    for (const entry of list) {
      if (!isPlainObject(entry) || !isName(entry.context)) {
        throw new Unreadable(`rulesets: rule ${i + 1} has an entry without a context`);
      }
      into.add(entry.context);
    }
  });
}

function classicContexts(body, into) {
  if (!isPlainObject(body) || !Array.isArray(body.contexts) || !Array.isArray(body.checks)) {
    throw new Unreadable("classic protection: the response has no contexts and checks lists");
  }
  for (const context of body.contexts) {
    if (!isName(context)) throw new Unreadable("classic protection: a context is not a non-empty string");
    into.add(context);
  }
  for (const check of body.checks) {
    if (!isPlainObject(check) || !isName(check.context)) throw new Unreadable("classic protection: a check has no context");
    into.add(check.context);
  }
}

/**
 * The required status check contexts of `branch`, from rulesets and classic
 * protection.
 * @param {{gh: {get: Function, list: Function}, repo: string, branch: string}} options
 * @returns {string[]} sorted, unique, never empty
 * @throws {Unreadable} when either source cannot be read, or the union is empty
 */
export function readRequired({ gh, repo, branch }) {
  const { owner, name } = repoSlug(repo);
  if (!isName(branch)) throw new TypeError("branch must be a non-empty string");
  const quoted = JSON.stringify(branch);

  const found = reading("branch lookup", () => gh.get(api`repos/${owner}/${name}/branches/${branch}`));
  if (found.status !== 200) throw new Unreadable(`branch lookup for ${quoted} returned HTTP ${found.status}`);
  if (!isPlainObject(found.json)) throw new Unreadable(`branch lookup for ${quoted} returned no branch object`);
  if (found.json.name !== branch) {
    throw new Unreadable(`branch lookup for ${quoted} resolved to ${JSON.stringify(found.json.name)}`);
  }

  const contexts = new Set();
  const rules = reading("rulesets", () => gh.list(api`repos/${owner}/${name}/rules/branches/${branch}`));
  rulesetContexts(rules, contexts);

  const classic = reading("classic protection", () => gh.get(api`repos/${owner}/${name}/branches/${branch}/protection/required_status_checks`));
  if (classic.status === 200) classicContexts(classic.json, contexts);
  else if (classic.status !== 404) throw new Unreadable(`classic protection returned HTTP ${classic.status}`);

  if (contexts.size === 0) throw new Unreadable(NO_CHECKS);
  return [...contexts].sort();
}

function checkRunsOf(page, what) {
  for (const run of page) {
    if (!isPlainObject(run) || !Number.isSafeInteger(run.id) || typeof run.name !== "string" || typeof run.status !== "string") {
      throw new Unreadable(`${what}: a check run has no id, name or status`);
    }
  }
  return page;
}

function statusesOf(page) {
  for (const status of page) {
    if (!isPlainObject(status) || typeof status.context !== "string" || typeof status.state !== "string") {
      throw new Unreadable("commit statuses: a status has no context or state");
    }
  }
  return page;
}

/** State from the latest check runs and statuses of one context. */
function stateOf(runs, statuses) {
  if (runs.length === 0 && statuses.length === 0) return "missing";
  let failing = false;
  let pending = false;
  for (const run of runs) {
    if (run.status !== "completed") pending = true;
    else if (!GREEN_CONCLUSIONS.has(run.conclusion)) failing = true;
  }
  for (const status of statuses) {
    if (status.state === "pending") pending = true;
    else if (status.state !== "success") failing = true;
  }
  if (failing) return "failing";
  return pending ? "pending" : "green";
}

/**
 * Judges each required context on `sha`.
 * @param {{gh: {get: Function, listKey: Function}, repo: string, sha: string, contexts: string[],
 *   managed: Map<string, string> | null, defaultBranch: string}} options
 *   `managed` maps each context with provenance to its caller path
 *   (`managedChecks`); null means the config is unreadable
 * @returns {{context: string, state: string, reason: string}[]} in `contexts` order
 * @throws {Unreadable} on an empty context list, a bad SHA or a failed read
 */
export function evaluate({ gh, repo, sha, contexts, managed, defaultBranch }) {
  const { owner, name, slug } = repoSlug(repo);
  if (!Array.isArray(contexts) || contexts.length === 0 || !contexts.every(isName)) throw new Unreadable(NO_CHECKS);
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Unreadable(`head SHA ${JSON.stringify(sha)} is not 40 lower-case hex`);
  if (!isName(defaultBranch)) throw new TypeError("defaultBranch must be a non-empty string");
  if (managed !== null && !(managed instanceof Map)) throw new TypeError("managed must be a Map or null");
  const kinds = new Map();
  for (const [context, path] of managed ?? []) {
    const match = typeof path === "string" ? CALLER.exec(path) : null;
    if (match === null) throw new TypeError(`managed caller path for ${JSON.stringify(context)} is not a ship-kit caller`);
    kinds.set(context, match[1]);
  }

  const commit = api`repos/${owner}/${name}/commits/${sha}`;
  // Latest before all: a run created between the two reads is then seen by
  // provenance, never only by the state.
  const latest = reading("check runs (filter=latest)", () => checkRunsOf(gh.listKey(`${commit}/check-runs?filter=latest`, "check_runs"), "check runs (filter=latest)"));
  const statuses = reading("commit statuses", () => statusesOf(gh.listKey(`${commit}/status`, "statuses")));
  const needAll = contexts.some((c) => kinds.has(c));
  const all = needAll
    ? reading("check runs (filter=all)", () => checkRunsOf(gh.listKey(`${commit}/check-runs?filter=all`, "check_runs"), "check runs (filter=all)"))
    : [];

  const suiteRuns = new Map();
  function workflowRunOf(suiteId) {
    if (!suiteRuns.has(suiteId)) {
      const runs = reading(`workflow runs of check suite ${suiteId}`, () => gh.listKey(
        `${api`repos/${owner}/${name}/actions/runs`}?check_suite_id=${seg(suiteId)}`, "workflow_runs"));
      suiteRuns.set(suiteId, runs);
    }
    const runs = suiteRuns.get(suiteId);
    if (runs.length !== 1) return { error: `check suite ${suiteId} lists ${runs.length} workflow runs; expected exactly one` };
    const run = runs[0];
    if (!isPlainObject(run) || !Number.isSafeInteger(run.id)) return { error: `check suite ${suiteId} lists a malformed workflow run` };
    if (run.check_suite_id !== suiteId) return { error: `workflow run ${run.id} belongs to another check suite` };
    const fullName = isPlainObject(run.repository) ? run.repository.full_name : undefined;
    if (typeof fullName !== "string" || fullName.toLowerCase() !== slug.toLowerCase()) {
      return { error: `workflow run ${run.id} belongs to another repository` };
    }
    return { run };
  }

  /** @returns {string | null} why `checkRun` is not from the managed caller, or null */
  function provenanceError(checkRun, context, kind) {
    const app = isPlainObject(checkRun.app) ? checkRun.app.slug : undefined;
    if (app !== ACTIONS_APP) return `check run ${checkRun.id} is from app ${JSON.stringify(app)}, not ${ACTIONS_APP}`;
    const suiteId = isPlainObject(checkRun.check_suite) ? checkRun.check_suite.id : undefined;
    if (!Number.isSafeInteger(suiteId) || suiteId < 1) return `check run ${checkRun.id} has no check suite id`;
    const { run, error } = workflowRunOf(suiteId);
    if (error) return error;
    if (run.event !== CALLER_EVENT) return `check run ${checkRun.id} comes from a ${JSON.stringify(run.event)} run, not ${CALLER_EVENT}`;
    if (!callerPathMatches(run.path, kind, defaultBranch)) {
      return `check run ${checkRun.id} comes from ${JSON.stringify(run.path)}, not the managed caller`;
    }
    // A workflow token can post a check run through the Checks API, and
    // which Actions check suite it is filed under is not documented; only
    // a job of the caller's run is the caller's check. A job's id is its
    // check run's id.
    const job = reading(`job lookup for check run ${checkRun.id}`, () => gh.get(api`repos/${owner}/${name}/actions/jobs/${checkRun.id}`));
    if (job.status === 404) return `check run ${checkRun.id} is not a job of any workflow run`;
    if (job.status !== 200) throw new Unreadable(`job lookup for check run ${checkRun.id} returned HTTP ${job.status}`);
    if (!isPlainObject(job.json) || job.json.id !== checkRun.id || job.json.run_id !== run.id || job.json.name !== context) {
      return `check run ${checkRun.id} is not the job ${JSON.stringify(context)} of workflow run ${run.id}`;
    }
    return null;
  }

  function judge(context) {
    const runs = latest.filter((r) => r.name === context);
    const named = statuses.filter((s) => s.context === context);
    const state = stateOf(runs, named);
    if (managed === null && SHIP_KIT_NAME.test(context)) {
      return { context, state: "forged", reason: "the default branch's config is unreadable, so provenance cannot be proven" };
    }
    if (!kinds.has(context)) return { context, state, reason: "" };
    const kind = kinds.get(context);
    const history = all.filter((r) => r.name === context);
    if (runs.length === 0 && named.length === 0 && history.length === 0) return { context, state, reason: "" };
    if (named.length > 0) {
      return { context, state: "forged", reason: "a commit status carries this name; only a check run from the managed caller counts" };
    }
    const ids = new Set(history.map((r) => r.id));
    const unseen = runs.find((r) => !ids.has(r.id));
    if (unseen) return { context, state: "forged", reason: `check run ${unseen.id} is missing from the filter=all listing` };
    for (const checkRun of history) {
      const error = provenanceError(checkRun, context, kind);
      if (error) return { context, state: "forged", reason: error };
    }
    return { context, state, reason: `provenance: ${CALLER_EVENT} run of ${managed.get(context)}` };
  }

  return contexts.map(judge);
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreadable(`${what}: output is not JSON`);
  }
}

function text(output) {
  return typeof output === "string" ? output : Buffer.from(output).toString("utf8");
}

/** The repository, its default branch, the PR head and the managed map. */
function inputs(pr, { gh, git, readConfig }, notes) {
  const view = parseJson(reading("gh repo view", () => gh.cli(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"])), "gh repo view");
  if (!isPlainObject(view) || !isPlainObject(view.defaultBranchRef) || !isName(view.defaultBranchRef.name)) {
    throw new Unreadable("gh repo view: no default branch");
  }
  const { slug } = reading("gh repo view", () => repoSlug(view.nameWithOwner));
  const branch = view.defaultBranchRef.name;
  const checked = branch.startsWith("-") ? "" : reading("git check-ref-format", () => text(git(["check-ref-format", "--branch", branch])).trim());
  if (checked !== branch) throw new Unreadable(`default branch ${JSON.stringify(branch)} is not a valid branch name`);

  const head = parseJson(reading("gh pr view", () => gh.cli(["pr", "view", pr, "-R", slug, "--json", "headRefOid,baseRefName"])), "gh pr view");
  const sha = isPlainObject(head) ? head.headRefOid : undefined;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Unreadable(`PR ${pr} head SHA ${JSON.stringify(sha)} is not 40 lower-case hex`);
  if (head.baseRefName !== branch) {
    throw new Unreadable(`PR ${pr} targets ${JSON.stringify(head.baseRefName)}; required checks are read for the default branch ${JSON.stringify(branch)} only`);
  }

  let managed = null;
  try {
    const config = readConfig();
    if (!config.ok) notes.push(`config unreadable: ${config.reason}`);
    else if (config.branch !== branch) notes.push(`config was read from ${JSON.stringify(config.branch)}, not the default branch ${JSON.stringify(branch)}`);
    else managed = managedChecks(config.config);
  } catch (error) {
    notes.push(`config unreadable: ${messageOf(error)}`);
  }
  if (managed === null) notes.push("every ship-kit context is reported forged: its provenance cannot be proven");
  return { slug, branch, sha, managed };
}

/**
 * The real dependencies: `gh`, and git in `cwd` for the branch-name check
 * and the default branch's config.
 * @param {string} [cwd]
 */
export function defaultDeps(cwd = process.cwd()) {
  const git = makeGit(cwd);
  return { gh: makeGh(), git, readConfig: () => readDefaultBranchConfig({ git }) };
}

/**
 * @param {string[]} argv
 * @param {{gh: object, git: (args: string[]) => Buffer | string, readConfig: () => object}} [deps]
 * @param {{out: {write: Function}, err: {write: Function}}} [io]
 * @returns {number} exit code
 */
export function main(argv, deps = defaultDeps(), io = { out: process.stdout, err: process.stderr }) {
  if (argv.length !== 1 || !PR.test(argv[0])) {
    io.err.write(`${USAGE}\n`);
    return 2;
  }
  const notes = [];
  let sha;
  let results;
  try {
    const found = inputs(argv[0], deps, notes);
    sha = found.sha;
    const contexts = readRequired({ gh: deps.gh, repo: found.slug, branch: found.branch });
    results = evaluate({ gh: deps.gh, repo: found.slug, sha, contexts, managed: found.managed, defaultBranch: found.branch });
  } catch (error) {
    for (const note of notes) io.err.write(`required-checks: ${note}\n`);
    io.err.write(`required-checks: refusing: ${messageOf(error)}\n`);
    return 3;
  }
  for (const note of notes) io.err.write(`required-checks: ${note}\n`);
  for (const { context, state, reason } of results) {
    io.out.write(`${state} ${JSON.stringify(context)}${reason === "" ? "" : ` -- ${reason}`}\n`);
  }
  const green = results.filter((r) => r.state === "green").length;
  io.out.write(`${green} of ${results.length} required checks green on ${sha}\n`);
  return green === results.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
