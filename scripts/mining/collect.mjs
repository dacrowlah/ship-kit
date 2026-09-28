#!/usr/bin/env node
// Collects mining evidence into an output directory: merged PRs since a
// date with their comments and reviews, commit subjects, the target hunt
// list and its history, and every review state marker decoded from a
// comment's first line. Markers are labelled "unverified": this release
// does not check that a trusted run wrote them.
//
// Usage:
//   node scripts/mining/collect.mjs --target code|design --since YYYY-MM-DD \
//     --list <hunt-list path> --out <empty or absent dir> [--limit N]
//
// Exit 0: evidence written. Exit 1: a gh or git call failed; nothing is
// written, so a failed call never leaves a silent gap. Exit 2: usage.
// Network: only `gh` calls to the current repository's GitHub API.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeStateMarker } from "../lib/state-marker.mjs";

export const DEFAULT_LIMIT = 1000;
// gh pr list --search never returns more than this many results, regardless
// of --limit, so a --limit above it could never be satisfied and a PR count
// that reaches it is not necessarily "every PR since --since".
const MAX_SEARCH_RESULTS = 1000;
const USAGE =
  "usage: collect.mjs --target code|design --since YYYY-MM-DD --list <path> --out <dir> [--limit N]";

export class UsageError extends Error {}
export class CallError extends Error {}

/** @param {string[]} argv @returns {{target: string, since: string, list: string, out: string, limit: number}} */
export function parseArgs(argv) {
  const opts = { limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--target", "--since", "--list", "--out", "--limit"].includes(flag) || value === undefined) {
      throw new UsageError(USAGE);
    }
    opts[flag.slice(2)] = value;
  }
  if (!["code", "design"].includes(opts.target)) throw new UsageError(`--target must be code or design\n${USAGE}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since ?? "") || Number.isNaN(Date.parse(opts.since))) {
    throw new UsageError(`--since must be a YYYY-MM-DD date\n${USAGE}`);
  }
  if (!opts.list) throw new UsageError(`--list is required\n${USAGE}`);
  if (!opts.out) throw new UsageError(`--out is required\n${USAGE}`);
  opts.limit = Number(opts.limit);
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new UsageError(`--limit must be a positive integer\n${USAGE}`);
  if (opts.limit > MAX_SEARCH_RESULTS) {
    throw new UsageError(
      `--limit cannot exceed ${MAX_SEARCH_RESULTS}: gh pr list --search never returns more than that\n${USAGE}`,
    );
  }
  return opts;
}

function parseJson(text, call) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CallError(`${call}: output is not JSON`);
  }
}

// `gh api --paginate --slurp` returns one array per page.
function paginated(gh, path) {
  const args = ["api", "--paginate", "--slurp", path];
  const pages = parseJson(gh(args), `gh ${args.join(" ")}`);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new CallError(`gh ${args.join(" ")}: expected an array of pages`);
  }
  return pages.flat();
}

function markersFrom(pr, source, items, bodyOf) {
  const markers = [];
  for (const item of items) {
    const decoded = decodeStateMarker(bodyOf(item) ?? "");
    if (!decoded.ok) continue;
    markers.push({
      pr,
      source,
      id: item.id,
      url: item.html_url ?? null,
      createdAt: item.created_at ?? item.submitted_at ?? null,
      updatedAt: item.updated_at ?? null,
      edited: item.updated_at !== undefined && item.created_at !== item.updated_at,
      trust: "unverified",
      state: decoded.state,
    });
  }
  return markers;
}

/**
 * @param {{target: string, since: string, list: string, limit: number}} opts
 * @param {{gh: (args: string[]) => string, git: (args: string[]) => string, readFile: (path: string) => string}} deps
 *   gh and git return stdout and throw on a non-zero exit.
 * @returns {{files: Record<string, string>, reconciliation: string}}
 */
export function collect(opts, { gh, git, readFile }) {
  const listText = readFile(opts.list);
  const listHistory = git(["log", "--format=%H%x09%cs%x09%s", "--", opts.list]);
  const commits = git(["log", `--since=${opts.since}`, "--format=%H%x09%cs%x09%s", "HEAD"]);
  const listArgs = [
    "pr", "list", "--state", "merged", "--search", `merged:>=${opts.since}`,
    "--limit", String(opts.limit), "--json", "number,title,body,mergedAt,mergeCommit,headRefName",
  ];
  const prs = parseJson(gh(listArgs), `gh ${listArgs.join(" ")}`);
  if (!Array.isArray(prs)) throw new CallError("gh pr list: expected an array");

  const kept = [];
  const markers = [];
  let withAggregate = 0;
  for (const pr of prs) {
    const issueComments = paginated(gh, `repos/{owner}/{repo}/issues/${pr.number}/comments`);
    const reviewComments = paginated(gh, `repos/{owner}/{repo}/pulls/${pr.number}/comments`);
    const reviews = paginated(gh, `repos/{owner}/{repo}/pulls/${pr.number}/reviews`);
    const prMarkers = [
      ...markersFrom(pr.number, "issue-comment", issueComments, (c) => c.body),
      ...markersFrom(pr.number, "review", reviews, (r) => r.body),
    ];
    if (prMarkers.length > 0) withAggregate += 1;
    const keep = opts.target === "code" || prMarkers.some((m) => m.state.mode === "design-doc");
    if (!keep) continue;
    kept.push({ ...pr, issueComments, reviewComments, reviews });
    markers.push(...prMarkers);
  }

  const lines = [
    `target: ${opts.target}; since: ${opts.since}; list: ${opts.list}`,
    `PRs listed: ${prs.length}`,
    `PRs with at least one aggregate comment: ${withAggregate}`,
    `PRs kept for the ${opts.target} target: ${kept.length}`,
    `state markers decoded (all unverified): ${markers.length}`,
  ];
  const effectiveCap = Math.min(opts.limit, MAX_SEARCH_RESULTS);
  if (prs.length >= effectiveCap) {
    const atSearchCap = effectiveCap === MAX_SEARCH_RESULTS;
    lines.push(
      `WARNING: the PR count equals ${
        atSearchCap ? `GitHub's ${MAX_SEARCH_RESULTS}-result search cap` : `--limit (${opts.limit})`
      }; the listing is probably truncated. ` +
        (atSearchCap
          ? "gh pr list --search cannot return more; re-run with a later --since to narrow the date window."
          : "Re-run with a larger --limit or a later --since."),
    );
  }
  const reconciliation = `${lines.join("\n")}\n`;
  return {
    reconciliation,
    files: {
      "prs.json": `${JSON.stringify(kept, null, 2)}\n`,
      "markers.json": `${JSON.stringify(markers, null, 2)}\n`,
      "commits.tsv": commits,
      "list.md": listText,
      "list-history.tsv": listHistory,
      "reconciliation.txt": reconciliation,
    },
  };
}

function run(command) {
  return (args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const stderr = error.stderr ? String(error.stderr).trim() : error.message;
      throw new CallError(`${command} ${args.join(" ")} failed: ${stderr}`);
    }
  };
}

/** @returns {number} exit code */
export function main(argv, deps = { gh: run("gh"), git: run("git"), readFile: (p) => readFileSync(p, "utf8") }, io = { out: process.stdout, err: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!existsSync(opts.list)) throw new UsageError(`--list ${opts.list} does not exist`);
    if (existsSync(opts.out) && readdirSync(opts.out).length > 0) {
      throw new UsageError(`--out ${opts.out} exists and is not empty`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err.write(`${error.message}\n`);
    return 2;
  }
  let result;
  try {
    result = collect(opts, deps);
  } catch (error) {
    if (!(error instanceof CallError)) throw error;
    io.err.write(`collect: stopped on a failed call; no evidence written.\n${error.message}\n`);
    return 1;
  }
  mkdirSync(opts.out, { recursive: true });
  for (const [name, text] of Object.entries(result.files)) writeFileSync(join(opts.out, name), text);
  io.out.write(`${result.reconciliation}evidence: ${opts.out}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
