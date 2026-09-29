// Decides whether a review state marker can be trusted (design 8.2, 20.1).
// Any workflow's token posts as github-actions[bot], including one a PR
// adds, so a marker's author proves nothing. A marker is trusted only when
// it is bound, through live API reads, to a pull_request_target run of the
// managed caller for its kind in this repository, and to that run's state
// artifact, which names this comment's id and carries the marker byte for
// byte. Every error, of any kind, is "not trusted", which can only cost a
// full review or a shorter promotion record. State artifacts expire with
// the repository's artifact retention; an expired one is never trusted.

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
 *   `cache` shares run lookups, artifact listings and downloads between
 *   calls; omitted, every call reads afresh
 */
export function makeTrustState({ gh, repo, defaultBranch, download }) {
  const { owner, name, slug } = repoSlug(repo);
  if (typeof defaultBranch !== "string" || defaultBranch === "") throw new TypeError("defaultBranch must be a non-empty string");
  if (!gh || typeof gh.get !== "function" || typeof gh.listKey !== "function") throw new TypeError("gh must provide get and listKey");
  if (typeof download !== "function") throw new TypeError("download must be a function");

  /** @returns {unknown} the run's path, once its status, id, event and repository check out */
  function runPath(runId) {
    const { status, json } = gh.get(api`repos/${owner}/${name}/actions/runs/${runId}`);
    if (status !== 200) throw new Error(`run lookup returned HTTP ${status}`);
    if (!isPlainObject(json)) throw new Error("run lookup returned no run object");
    if (json.id !== runId) throw new Error("run lookup returned another run");
    if (json.event !== "pull_request_target") throw new Error(`run event is ${JSON.stringify(json.event)}`);
    const fullName = isPlainObject(json.repository) ? json.repository.full_name : undefined;
    if (typeof fullName !== "string" || fullName.toLowerCase() !== slug.toLowerCase()) {
      throw new Error("run belongs to another repository");
    }
    return json.path;
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
      const path = cached(cache, `run:${runId}`, () => runPath(runId));
      if (!callerPathMatches(path, kind, defaultBranch)) {
        return { trusted: false, reason: `run path ${JSON.stringify(path)} is not the managed caller for ${kind}` };
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
