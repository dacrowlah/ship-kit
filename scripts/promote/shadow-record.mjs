#!/usr/bin/env node
// The shadow-seat promotion record (design 10.3): how many of the
// repository's most recently merged pull requests, in a row, a seat reviewed
// cleanly. It reads and prints; it proposes and changes nothing.
//
// Usage:
//   node scripts/promote/shadow-record.mjs <seat> [--limit N]
//
// `seat` is a ship-kit seat; `--limit` (1-200, default 50) is how many merged
// pull requests to list. Prints one JSON object:
//   {seat, required, cleanRuns, streak: [{pr, head}], stoppedAt: {pr, reason} | null, truncated}
// `required` is review.promotion.cleanRuns. `streak` lists the clean pull
// requests newest merge first, and `stoppedAt` names the first pull request
// that is not clean and why (null when the listing ran out first).
// `truncated` is true when the listing holds as many pull requests as the
// limit allows, so pull requests merged before the oldest one listed may
// exist that the streak never reached.
//
// The listing is the newest merged pull requests by merge time. `gh pr list`
// returns the most recently created ones, so when the listing is full a
// second, search-based listing of everything merged since the oldest listed
// merge must name exactly the same pull requests; any other answer is a
// failed call, because a pull request created early and merged late would
// otherwise vanish from an apparently unbroken streak.
//
// A pull request is clean when the newest trusted state of the seat for the
// pull request's final head is complete, and either records no BLOCKING
// finding or the pull request carries the confirmed label, and the pull
// request does not carry the false-positive label (which wins over the
// confirmed one). A state counts only when trustState binds it to a run of
// the managed caller and that run's state artifact, so a forged marker, an
// edited comment and an expired artifact all leave a pull request without a
// state. Labels are read from the live listing, never from a payload. The
// config is read from origin's default branch, never the working tree.
//
// A run of an empty pull request (one that changes no file) is a complete
// pass, and its state records nothing that tells it from a reviewed one, so
// it counts like any other clean run.
//
// Exit 0: the record was printed. Exit 1: a call failed, or answered in a
// way that cannot be trusted; nothing is printed as a result. Exit 2: usage.
// Exit 3: the config at origin's default branch is unreadable.
// Network: `gh` calls to the current repository's GitHub API, and the
// `git ls-remote` and `git fetch` against origin that read the config.

import { pathToFileURL } from "node:url";
import { SEATS, readDefaultBranchConfig } from "../lib/config.mjs";
import { CallError, api, makeGh, repoSlug } from "../lib/gh.mjs";
import { BLOCKING, severityOf } from "../review/review-mode.mjs";
import { collectTrustedStates, makeDownload, makeTrustState } from "../review/trust-state.mjs";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const REASONS = Object.freeze({
  noState: "no trusted state for the final head (artifacts may have expired under the repository's retention)",
  incomplete: "incomplete",
  unconfirmed: "blocking findings not confirmed",
  falsePositive: "false positive",
});

const USAGE = `usage: shadow-record.mjs <${SEATS.join("|")}> [--limit 1-${MAX_LIMIT}]`;
const SHA = /^[0-9a-f]{40}$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const LIST_FIELDS = "number,headRefOid,labels,mergedAt";
// `gh pr list --json labels` returns at most this many labels per pull request
// and says nothing when there are more, so a full page may hide the
// false-positive label.
const LABEL_PAGE = 100;

export class UsageError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{seat: string, limit: number}}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  let seat;
  let limit;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      i += 1;
      const value = argv[i];
      if (limit !== undefined) throw new UsageError(`--limit given twice\n${USAGE}`);
      if (typeof value !== "string" || !LIMIT.test(value) || Number(value) > MAX_LIMIT) {
        throw new UsageError(`--limit must be a whole number from 1 to ${MAX_LIMIT}\n${USAGE}`);
      }
      limit = Number(value);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option ${JSON.stringify(arg)}\n${USAGE}`);
    } else if (seat === undefined) {
      seat = arg;
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (seat === undefined || !SEATS.includes(seat)) {
    throw new UsageError(`the seat must be one of ${SEATS.join(", ")}\n${USAGE}`);
  }
  return { seat, limit: limit ?? DEFAULT_LIMIT };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CallError(`${what} is not JSON`);
  }
}

/** The repository gh addresses, checked against the default branch the config was read from. */
function resolveRepo(gh, branch) {
  const view = parseJson(gh.cli(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]), "gh repo view output");
  if (!isPlainObject(view)) throw new CallError("gh repo view: expected an object");
  let repo;
  try {
    repo = repoSlug(view.nameWithOwner);
  } catch (error) {
    throw new CallError(`gh repo view: ${messageOf(error)}`);
  }
  const theirs = isPlainObject(view.defaultBranchRef) ? view.defaultBranchRef.name : undefined;
  if (theirs !== branch) {
    throw new CallError(
      `gh repo view: ${repo.slug} has default branch ${JSON.stringify(theirs)} but origin's is ${JSON.stringify(branch)}; refusing to mix two repositories`,
    );
  }
  return repo;
}

function readPr(row, index) {
  if (!isPlainObject(row)) throw new CallError(`pull request listing entry ${index + 1} is not an object`);
  const { number, headRefOid, labels, mergedAt } = row;
  if (!Number.isSafeInteger(number) || number < 1) throw new CallError(`pull request listing entry ${index + 1} has no valid number`);
  if (typeof headRefOid !== "string" || !SHA.test(headRefOid)) throw new CallError(`pull request ${number} has no valid head commit`);
  if (!Array.isArray(labels) || !labels.every((l) => isPlainObject(l) && typeof l.name === "string")) {
    throw new CallError(`pull request ${number} has no valid labels`);
  }
  if (labels.length >= LABEL_PAGE) throw new CallError(`pull request ${number} lists ${labels.length} labels, so its label list may be truncated`);
  const merged = typeof mergedAt === "string" ? Date.parse(mergedAt) : Number.NaN;
  if (!Number.isFinite(merged)) throw new CallError(`pull request ${number} has no valid merge time`);
  // GitHub keeps label names unique ignoring case, so two spellings name one label.
  return { number, head: headRefOid, labels: new Set(labels.map((l) => l.name.toLowerCase())), merged };
}

function listArgs(slug, branch) {
  return ["pr", "list", "-R", slug, "--base", branch, "--state", "merged"];
}

/**
 * Refuses unless everything merged since the oldest merge in `prs` is `prs`.
 * `gh pr list` returns the most recently created merged pull requests, so a
 * pull request created before the window and merged inside it is missing
 * from a full one. The search listing is asked for one more entry than the
 * window holds: a pull request outside the window must then appear in it.
 * The two listings come from different indexes, so one that is behind reads
 * as a disagreement too.
 */
function assertWindowComplete(gh, { slug, branch, prs, limit }) {
  const oldest = Math.min(...prs.map((pr) => pr.merged));
  const since = new Date(Math.floor(oldest / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const args = [...listArgs(slug, branch), "--search", `merged:>=${since}`, "--limit", String(limit + 1), "--json", "number"];
  const rows = parseJson(gh.cli(args), "the merge-time listing");
  if (!Array.isArray(rows)) throw new CallError("the merge-time listing is not an array");
  const found = new Set(
    rows.map((row) => {
      if (!isPlainObject(row) || !Number.isSafeInteger(row.number) || row.number < 1) throw new CallError("the merge-time listing has an entry without a valid number");
      return row.number;
    }),
  );
  const listed = new Set(prs.map((pr) => pr.number));
  const missed = [...found].filter((number) => !listed.has(number));
  if (missed.length > 0) {
    throw new CallError(
      `the listing missed pull request(s) merged since ${since}: ${missed.map((n) => `#${n}`).join(", ")}; gh lists the most recently created merged pull requests, so raise --limit`,
    );
  }
  const absent = [...listed].filter((number) => !found.has(number));
  if (absent.length > 0) {
    throw new CallError(`the merge-time listing lacks listed pull request(s) ${absent.map((n) => `#${n}`).join(", ")}; the search index may be behind, so retry`);
  }
}

/**
 * Merged pull requests into the default branch, newest merge first. A full
 * listing is checked against a merge-time search (assertWindowComplete).
 */
function listMerged(gh, { slug, branch, limit }) {
  const rows = parseJson(gh.cli([...listArgs(slug, branch), "--limit", String(limit), "--json", LIST_FIELDS]), "the pull request listing");
  if (!Array.isArray(rows)) throw new CallError("the pull request listing is not an array");
  if (rows.length > limit) throw new CallError(`the pull request listing holds ${rows.length} entries for --limit ${limit}`);
  const prs = rows.map(readPr);
  if (new Set(prs.map((pr) => pr.number)).size !== prs.length) throw new CallError("the pull request listing names a pull request twice");
  if (prs.length >= limit) assertWindowComplete(gh, { slug, branch, prs, limit });
  return prs.sort((a, b) => b.merged - a.merged || b.number - a.number);
}

/**
 * trustState reads the API and answers "not trusted" to every error, which
 * is right for a forged marker and wrong for a rate limit or an outage that
 * would read as an expired artifact. This wrapper remembers the calls that
 * failed for a reason other than "no such run" so the record can refuse.
 * @returns {{gh: {get: Function, listKey: Function, cli: Function}, assertNoFailures: () => void}}
 */
function watchCalls(gh) {
  const failures = [];
  const note = (what, why) => failures.push(`${what}: ${why}`);
  return {
    gh: {
      get(path) {
        let result;
        try {
          result = gh.get(path);
        } catch (error) {
          note(`GET ${path}`, messageOf(error));
          throw error;
        }
        if (result.status !== 200 && result.status !== 404) note(`GET ${path}`, `HTTP ${result.status}`);
        return result;
      },
      listKey(path, key) {
        try {
          return gh.listKey(path, key);
        } catch (error) {
          note(`GET ${path}`, messageOf(error));
          throw error;
        }
      },
      cli(args) {
        try {
          return gh.cli(args);
        } catch (error) {
          note(`gh ${args[0]}`, messageOf(error));
          throw error;
        }
      },
    },
    assertNoFailures() {
      if (failures.length > 0) throw new CallError(`could not check a state marker: ${failures[0]}`);
    },
  };
}

/**
 * @param {{number: number, head: string, labels: Set<string>}} pr
 * @param {object[]} states the seat's trusted states on the pull request
 * @param {{falsePositiveLabel: string, confirmedLabel: string}} labels
 * @returns {{clean: true} | {clean: false, reason: string}}
 */
function judge(pr, states, { falsePositiveLabel, confirmedLabel }) {
  const forHead = states.filter((state) => state.head === pr.head);
  if (forHead.length === 0) return { clean: false, reason: REASONS.noState };
  const newest = forHead.reduce((latest, state) => (state.commentId > latest.commentId ? state : latest));
  if (newest.complete !== true) return { clean: false, reason: REASONS.incomplete };
  if (pr.labels.has(falsePositiveLabel.toLowerCase())) return { clean: false, reason: REASONS.falsePositive };
  const blocking = newest.findings.some((finding) => severityOf(finding.severity) === BLOCKING);
  if (blocking && !pr.labels.has(confirmedLabel.toLowerCase())) return { clean: false, reason: REASONS.unconfirmed };
  return { clean: true };
}

/**
 * @param {{seat: string, limit: number, branch: string, promotion: {cleanRuns: number, falsePositiveLabel: string, confirmedLabel: string}}} options
 * @param {{cli: Function, get: Function, list: Function, listKey: Function}} gh a client from makeGh
 * @returns {{seat: string, required: number, cleanRuns: number, streak: {pr: number, head: string}[], stoppedAt: {pr: number, reason: string} | null, truncated: boolean}}
 * @throws {CallError} on any failed or untrustworthy call
 */
export function buildRecord({ seat, limit, branch, promotion }, gh) {
  const { owner, name, slug } = resolveRepo(gh, branch);
  const prs = listMerged(gh, { slug, branch, limit });
  const watch = watchCalls(gh);
  const trustState = makeTrustState({
    gh: watch.gh,
    repo: slug,
    defaultBranch: branch,
    download: makeDownload({ gh: watch.gh, repo: slug }),
  });

  const streak = [];
  let stoppedAt = null;
  for (const pr of prs) {
    const comments = gh.list(api`repos/${owner}/${name}/issues/${pr.number}/comments`);
    const states = collectTrustedStates(comments, { kinds: [seat], trustState });
    watch.assertNoFailures();
    const verdict = judge(pr, states, promotion);
    if (!verdict.clean) {
      stoppedAt = { pr: pr.number, reason: verdict.reason };
      break;
    }
    streak.push({ pr: pr.number, head: pr.head });
  }
  return { seat, required: promotion.cleanRuns, cleanRuns: streak.length, streak, stoppedAt, truncated: prs.length >= limit };
}

function defaultDeps() {
  return { readConfig: () => readDefaultBranchConfig(), gh: makeGh() };
}

function readConfig(deps) {
  try {
    return deps.readConfig();
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{readConfig: () => object, gh: object}} [deps]
 * @param {{out: {write: Function}, err: {write: Function}}} [io]
 * @returns {number} exit code
 */
export function main(argv, deps = defaultDeps(), io = { out: process.stdout, err: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err.write(`${error.message}\n`);
    return 2;
  }
  const config = readConfig(deps);
  if (!config.ok) {
    io.err.write(`shadow-record: the config at origin's default branch is unreadable: ${config.reason}\n`);
    return 3;
  }
  let record;
  try {
    record = buildRecord({ ...options, branch: config.branch, promotion: config.config.review.promotion }, deps.gh);
  } catch (error) {
    io.err.write(`shadow-record: stopped on a failed call; no record printed.\n${messageOf(error)}\n`);
    return 1;
  }
  io.out.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
