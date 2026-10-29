// Decides whether a review state marker can be trusted (design 8.2, 20.1).
// Any workflow's token posts as github-actions[bot], including one a PR
// adds, so a marker's author proves nothing. A marker is trusted only when
// it is bound, through live API reads, to a pull_request_target run of the
// managed caller for its kind in this repository, and to that run's state
// artifact, which names this comment's id and carries the marker byte for
// byte. Every error, of any kind, is "not trusted", which can only cost a
// full review or a shorter promotion record. State artifacts expire with
// the repository's artifact retention; an expired one is never trusted.
// Two effects of this design fail closed: a PR workflow that floods bot
// comments can push real states past the 30-marker cap, and editing the
// newest genuine comment untrusts it; both only widen the review, never
// trust a forgery.
//
// A pull_request_target run of a PR into any branch other than the default
// one runs that branch's copy of the caller and reports the same bare path,
// so a writer can push an edited caller to a branch, open a PR into it, and
// have that run grant itself write access, post a marker on any PR and
// upload a matching artifact. So the run must also be bound to the PR the
// comment is on: the single-run lookup's `pull_requests` lists exactly one
// PR, with the number in the comment's `issue_url`, in this repository and
// based on the default branch, and the run's `head_sha` equals the head the
// state records. Consequences, fail closed:
// - A fork PR's run lists no PR, so a fork PR never has a trusted prior
//   state: every round is a full review and earns no promotion credit.
// - GitHub fills `pull_requests` when it is read, from the open PRs whose
//   head is the run's head branch; it is empty once the PR is merged or
//   closed. States on a merged or closed PR are therefore never trusted.
// - A genuine run whose head branch also heads another open PR lists both
//   and is not trusted.
// Residual risk: no run field records which branch's copy of the caller a
// run executed, so the live association is the only tie. A writer who
// opens a second PR from this PR's head branch into a branch holding an
// edited caller, lets its run post here and then closes it, or who
// retargets this PR from such a branch to the default branch after the run
// posts, leaves a run that passes. Proof of the ref a run executed (an
// OIDC token's claims) is planned for release 6.

import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, repoSlug } from "../lib/gh.mjs";
import { decodeStateMarker } from "../lib/state-marker.mjs";

/** Any attempt's state artifact: aggregate names it with the run attempt. */
export const STATE_ARTIFACT = /^ship-kit-state-[1-9][0-9]{0,2}$/;
export const STATE_AUTHOR = "github-actions[bot]";
export const STATE_FILE = "state.json";
export const MAX_STATE_BYTES = 256 * 1024;

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const PAYLOAD_KEYS = ["commentId", "marker"];
/** A REST issue comment's `issue_url`: the API host, optionally /api/v3, then the issue. */
const ISSUE_URL = /^https:\/\/[^/?#]+(?:\/api\/v3)?\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]{0,9})$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} path a workflow run's `path`
 * @param {unknown} kind the state's seat kind
 * @param {unknown} defaultBranch
 * @returns {boolean} true only for `.github/workflows/ship-kit-<kind>.yml`,
 *   bare or followed by `@refs/heads/<defaultBranch>`
 */
export function callerPathMatches(path, kind, defaultBranch) {
  if (typeof path !== "string" || typeof kind !== "string" || kind === "") return false;
  if (typeof defaultBranch !== "string" || defaultBranch === "") return false;
  const caller = `.github/workflows/ship-kit-${kind}.yml`;
  return path === caller || path === `${caller}@refs/heads/${defaultBranch}`;
}

/**
 * The checks that need no API call: a marker on the first line, the bot
 * author with user type Bot, an unedited comment and a usable id.
 * @returns {{ok: true, state: object, line: string} | {ok: false, reason: string}}
 */
function precheck(comment) {
  if (!isPlainObject(comment)) return { ok: false, reason: "comment is not an object" };
  const decoded = decodeStateMarker(comment.body);
  if (!decoded.ok) return { ok: false, reason: `no state marker: ${decoded.reason}` };
  const user = comment.user;
  if (!isPlainObject(user) || user.login !== STATE_AUTHOR || user.type !== "Bot") {
    return { ok: false, reason: "comment author is not the Actions bot" };
  }
  if (typeof comment.created_at !== "string" || comment.created_at !== comment.updated_at) {
    return { ok: false, reason: "comment was edited" };
  }
  if (!Number.isSafeInteger(comment.id) || comment.id < 1) return { ok: false, reason: "comment id is invalid" };
  const line = comment.body.split("\n", 1)[0].replace(/\r$/, "");
  return { ok: true, state: decoded.state, line };
}

/**
 * The pull request a comment is on, from the `issue_url` the API gives
 * every issue comment; it must name `slug`'s repository.
 * @returns {{ok: true, number: number} | {ok: false, reason: string}}
 */
function pullRequestOf(comment, slug) {
  const match = typeof comment.issue_url === "string" ? ISSUE_URL.exec(comment.issue_url) : null;
  if (match === null) return { ok: false, reason: "comment's issue_url names no pull request" };
  if (`${match[1]}/${match[2]}`.toLowerCase() !== slug.toLowerCase()) {
    return { ok: false, reason: "comment is on another repository's pull request" };
  }
  return { ok: true, number: Number(match[3]) };
}

/** Evaluates `read` once per key in `cache`, remembering failures too. */
function cached(cache, key, read) {
  if (!cache.has(key)) {
    try {
      cache.set(key, { ok: true, value: read() });
    } catch (error) {
      cache.set(key, { ok: false, reason: messageOf(error) });
    }
  }
  const entry = cache.get(key);
  if (!entry.ok) throw new Error(entry.reason);
  return entry.value;
}

/**
 * @param {{gh: {get: Function, listKey: Function}, repo: string, defaultBranch: string,
 *   download: (runId: number, artifactName: string) => string}} deps
 * @returns {(comment: object, cache?: Map) => ({trusted: true, state: object} | {trusted: false, reason: string})}
 *   `comment` is a REST issue comment, whose `issue_url` names the pull
 *   request it is on; `cache` shares run lookups, artifact listings and
 *   downloads between calls; omitted, every call reads afresh
 */
export function makeTrustState({ gh, repo, defaultBranch, download }) {
  const { owner, name, slug } = repoSlug(repo);
  if (typeof defaultBranch !== "string" || defaultBranch === "") throw new TypeError("defaultBranch must be a non-empty string");
  if (!gh || typeof gh.get !== "function" || typeof gh.listKey !== "function") throw new TypeError("gh must provide get and listKey");
  if (typeof download !== "function") throw new TypeError("download must be a function");

  /**
   * @returns {{path: unknown, headSha: unknown, pullRequests: unknown, repositoryId: unknown}}
   *   the run's own record, once its status, id, event and repository check out
   */
  function readRun(runId) {
    const { status, json } = gh.get(api`repos/${owner}/${name}/actions/runs/${runId}`);
    if (status !== 200) throw new Error(`run lookup returned HTTP ${status}`);
    if (!isPlainObject(json)) throw new Error("run lookup returned no run object");
    if (json.id !== runId) throw new Error("run lookup returned another run");
    if (json.event !== "pull_request_target") throw new Error(`run event is ${JSON.stringify(json.event)}`);
    const fullName = isPlainObject(json.repository) ? json.repository.full_name : undefined;
    if (typeof fullName !== "string" || fullName.toLowerCase() !== slug.toLowerCase()) {
      throw new Error("run belongs to another repository");
    }
    return { path: json.path, headSha: json.head_sha, pullRequests: json.pull_requests, repositoryId: json.repository.id };
  }

  /**
   * @returns {string | null} why the run is not bound to pull request
   *   `number` of this repository into the default branch, or null
   */
  function unbound(run, number) {
    const prs = run.pullRequests;
    if (!Array.isArray(prs) || prs.length !== 1) {
      return `run lists ${Array.isArray(prs) ? prs.length : "no"} pull requests, not exactly the one this comment is on`;
    }
    const [pr] = prs;
    if (!isPlainObject(pr) || pr.number !== number) return `run is for another pull request than #${number}`;
    const base = isPlainObject(pr.base) ? pr.base : {};
    if (base.ref !== defaultBranch) return `run's pull request is based on ${JSON.stringify(base.ref)}, not the default branch`;
    const baseRepoId = isPlainObject(base.repo) ? base.repo.id : undefined;
    if (!Number.isSafeInteger(run.repositoryId) || run.repositoryId < 1 || baseRepoId !== run.repositoryId) {
      return "run's pull request is in another repository";
    }
    return null;
  }

  function stateArtifacts(runId) {
    return gh.listKey(api`repos/${owner}/${name}/actions/runs/${runId}/artifacts`, "artifacts")
      .filter((a) => isPlainObject(a) && typeof a.name === "string" && STATE_ARTIFACT.test(a.name) && a.expired === false)
      .map((a) => a.name);
  }

  function readPayload(runId, artifactName) {
    const text = download(runId, artifactName);
    if (typeof text !== "string") throw new Error(`${artifactName}: download returned no text`);
    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new Error(`${artifactName}: ${STATE_FILE} exceeds ${MAX_STATE_BYTES} bytes`);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function matches(payload, commentId, line) {
    if (!isPlainObject(payload)) return false;
    const keys = Object.keys(payload);
    if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((k) => keys.includes(k))) return false;
    return payload.commentId === commentId && payload.marker === line;
  }

  return function trustState(comment, cache = new Map()) {
    try {
      const pre = precheck(comment);
      if (!pre.ok) return { trusted: false, reason: pre.reason };
      const { state, line } = pre;
      const { runId, kind } = state;
      const pr = pullRequestOf(comment, slug);
      if (!pr.ok) return { trusted: false, reason: pr.reason };
      const run = cached(cache, `run:${runId}`, () => readRun(runId));
      if (!callerPathMatches(run.path, kind, defaultBranch)) {
        return { trusted: false, reason: `run path ${JSON.stringify(run.path)} is not the managed caller for ${kind}` };
      }
      const problem = unbound(run, pr.number);
      if (problem !== null) return { trusted: false, reason: problem };
      if (run.headSha !== state.head) {
        return { trusted: false, reason: `run head ${JSON.stringify(run.headSha)} is not the state's head ${state.head}` };
      }
      const names = cached(cache, `artifacts:${runId}`, () => stateArtifacts(runId));
      if (names.length === 0) return { trusted: false, reason: "run has no unexpired state artifact" };
      for (const artifactName of names) {
        const payload = cached(cache, `download:${runId}:${artifactName}`, () => readPayload(runId, artifactName));
        if (matches(payload, comment.id, line)) return { trusted: true, state };
      }
      return { trusted: false, reason: "no state artifact matches this comment and marker" };
    } catch (error) {
      return { trusted: false, reason: messageOf(error) };
    }
  };
}

/**
 * Trusted states among `comments`. Comments failing the checks that need
 * no API call are dropped first, so marker-shaped comments by anyone else
 * cannot use up the cap; then at most `cap` of the newest (by id) per kind
 * are evaluated, sharing one cache.
 * @param {object[]} comments REST issue comments
 * @param {{kinds: string[], trustState: Function, cap?: number}} options
 * @returns {object[]} trusted states ascending by comment id, each with `commentId`
 */
export function collectTrustedStates(comments, { kinds, trustState, cap = 30 } = {}) {
  if (!Array.isArray(comments)) throw new TypeError("comments must be an array");
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => typeof k === "string" && k !== "")) {
    throw new TypeError("kinds must be a non-empty array of non-empty strings");
  }
  if (typeof trustState !== "function") throw new TypeError("trustState must be a function");
  if (!Number.isSafeInteger(cap) || cap < 1) throw new TypeError("cap must be a positive integer");

  const byKind = new Map(kinds.map((k) => [k, []]));
  for (const comment of comments) {
    const pre = precheck(comment);
    if (pre.ok && byKind.has(pre.state.kind)) byKind.get(pre.state.kind).push(comment);
  }

  const cache = new Map();
  const trusted = [];
  for (const group of byKind.values()) {
    const newest = group.sort((a, b) => b.id - a.id).slice(0, cap);
    for (const comment of newest) {
      let result;
      try {
        result = trustState(comment, cache);
      } catch {
        continue;
      }
      if (result && result.trusted === true) trusted.push({ ...result.state, commentId: comment.id });
    }
  }
  return trusted.sort((a, b) => a.commentId - b.commentId);
}

/**
 * The real `download` for makeTrustState: `gh run download <runId> -R
 * <repo> -n <name> -D <fresh temp dir>`, bounded by gh's timeout, then
 * `state.json` read as a regular file of at most MAX_STATE_BYTES of UTF-8.
 * The directory is removed whatever happens.
 * @param {{gh: {cli: Function}, repo: string, tmpRoot?: string}} deps
 * @returns {(runId: number, artifactName: string) => string}
 */
export function makeDownload({ gh, repo, tmpRoot = tmpdir() }) {
  if (!gh || typeof gh.cli !== "function") throw new TypeError("gh must provide cli");
  const { slug } = repoSlug(repo);
  if (typeof tmpRoot !== "string" || tmpRoot === "") throw new TypeError("tmpRoot must be a non-empty string");

  return function download(runId, artifactName) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new TypeError(`not a run id: ${String(runId)}`);
    if (typeof artifactName !== "string" || !ARTIFACT_NAME.test(artifactName)) {
      throw new TypeError(`not an artifact name: ${JSON.stringify(artifactName) ?? String(artifactName)}`);
    }
    const dir = mkdtempSync(join(tmpRoot, "ship-kit-artifact-"));
    try {
      gh.cli(["run", "download", String(runId), "-R", slug, "-n", artifactName, "-D", dir]);
      const file = join(dir, STATE_FILE);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new Error(`${artifactName}: ${STATE_FILE} is not a regular file`);
      if (stat.size > MAX_STATE_BYTES) throw new Error(`${artifactName}: ${STATE_FILE} exceeds ${MAX_STATE_BYTES} bytes`);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
      } catch {
        throw new Error(`${artifactName}: ${STATE_FILE} is not UTF-8`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
