// Fixture builders for scripts/review/plan.test.mjs. Nothing here is a
// static repository: each test builds what it needs.
//
// - makeRepo: a git repository whose "default branch" commit is checked out
//   detached (the workspace at TRUSTED_SHA) and whose PR head commits are
//   reachable only through refs/ship-kit/head, as the plan job's fetch
//   leaves them. Trees are built with plumbing, so a file name that is not
//   UTF-8, holds a newline or starts with a dash needs no file on disk.
// - makeRoot: a SHIP_KIT_ROOT holding src/ (this repository's own contract,
//   hunt lists and plugin manifest) and deps/ (a marketplace naming the
//   superpowers commit).
// - fakeGh: an in-memory stand-in for scripts/lib/gh.mjs's client.
// - tagLine and annotatedTag: `git ls-remote` listings.
// - patchPaths: the file paths a patch's `diff --git` headers name.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const REPOSITORY = "example-org/app";
export const REPOSITORY_ID = "1001";
export const FORK = "someone/app";
export const FORK_ID = "2002";
export const WORKFLOW_REPOSITORY = "example-org/ship-kit";
export const WORKFLOW_SHA = "c".repeat(40);
export const TAG_OBJECT = "7".repeat(40);
export const SUPERPOWERS_SHA = "5".repeat(40);
export const SRC_FILES = [
  "review/contract/output.md",
  "review/contract/design-doc.md",
  "review/contract/untrusted-data.md",
  "review/hunt-lists/design-shared.md",
  "review/hunt-lists/code-shared.md",
  ".claude-plugin/plugin.json",
];

/** The environment every fixture git command runs with: no user or system config. */
function gitEnv(extra = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

/** Runs git in `dir`; returns stdout as a Buffer. */
export function git(dir, args, { input, env = {} } = {}) {
  return execFileSync("git", args, { cwd: dir, input, env: gitEnv(env), maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

/** A path as plan.mjs holds it: one character per byte. */
export const bytes = (path) => (Buffer.isBuffer(path) ? path.toString("latin1") : Buffer.from(path, "utf8").toString("latin1"));

function normalize(spec) {
  if (spec === null) return null;
  if (typeof spec === "string" || Buffer.isBuffer(spec)) return { mode: "100644", content: spec };
  if (spec.symlink !== undefined) return { mode: "120000", content: spec.symlink };
  return { mode: spec.mode ?? "100644", content: spec.content };
}

/** Applies `changes` (an object or [path, spec] pairs; null deletes) to a file map. */
function apply(files, changes) {
  const next = new Map(files);
  for (const [path, spec] of Array.isArray(changes) ? changes : Object.entries(changes)) {
    const file = normalize(spec);
    if (file === null) next.delete(bytes(path));
    else next.set(bytes(path), file);
  }
  return next;
}

let indexCounter = 0;

function commit(dir, files, parents) {
  indexCounter += 1;
  const env = { GIT_INDEX_FILE: join(dir, ".git", `fixture-index-${indexCounter}`) };
  git(dir, ["read-tree", "--empty"], { env });
  const records = [];
  for (const [path, file] of files) {
    const oid = git(dir, ["hash-object", "-w", "--stdin"], { input: Buffer.from(file.content) }).toString().trim();
    records.push(Buffer.from(`${file.mode} ${oid}\t`, "latin1"), Buffer.from(path, "latin1"), Buffer.from([0]));
  }
  if (records.length > 0) git(dir, ["update-index", "-z", "--index-info"], { input: Buffer.concat(records), env });
  const tree = git(dir, ["write-tree"], { env }).toString().trim();
  return git(dir, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "fixture"]).toString().trim();
}

/**
 * @param {{base?: object, heads?: object[], unrelatedHead?: boolean}} [spec]
 *   `base` is the default-branch commit's files; each entry of `heads` is
 *   one PR commit's changes on top of the previous one; `unrelatedHead`
 *   makes the first head commit a root commit.
 * @returns {{dir: string, base: string, heads: string[], head: string,
 *   commitOn: (parent: string, changes: object) => string}}
 */
export function makeRepo({ base = {}, heads = [{}], unrelatedHead = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-repo-"));
  git(dir, ["init", "-q"]);
  const filesAt = new Map();
  let files = apply(new Map(), base);
  const baseSha = commit(dir, files, []);
  filesAt.set(baseSha, files);
  const headShas = [];
  let parent = baseSha;
  heads.forEach((changes, i) => {
    files = apply(files, changes);
    parent = commit(dir, files, unrelatedHead && i === 0 ? [] : [parent]);
    filesAt.set(parent, files);
    headShas.push(parent);
  });
  const head = headShas.length > 0 ? headShas[headShas.length - 1] : baseSha;
  git(dir, ["update-ref", "refs/ship-kit/head", head]);
  git(dir, ["update-ref", "--no-deref", "HEAD", baseSha]);
  git(dir, ["reset", "-q", "--hard"]);
  return {
    dir,
    base: baseSha,
    heads: headShas,
    head,
    commitOn(parentSha, changes) {
      const next = apply(filesAt.get(parentSha), changes);
      const sha = commit(dir, next, [parentSha]);
      filesAt.set(sha, next);
      return sha;
    },
  };
}

/**
 * @param {{outputContract?: string, plugin?: string, marketplace?: string}} [overrides]
 * @returns {string} a fresh SHIP_KIT_ROOT
 */
export function makeRoot({ outputContract, plugin, marketplace } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plan-root-"));
  for (const rel of SRC_FILES) {
    mkdirSync(dirname(join(root, "src", rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(root, "src", rel));
  }
  if (outputContract !== undefined) writeFileSync(join(root, "src/review/contract/output.md"), outputContract);
  if (plugin !== undefined) writeFileSync(join(root, "src/.claude-plugin/plugin.json"), plugin);
  const market = join(root, "deps/claude-plugins-official/.claude-plugin/marketplace.json");
  mkdirSync(dirname(market), { recursive: true });
  writeFileSync(market, marketplace ?? JSON.stringify({
    name: "claude-plugins-official",
    plugins: [
      { name: "other", source: { source: "url", url: "https://example.com/other.git", sha: "6".repeat(40) } },
      { name: "superpowers", source: { source: "url", url: "https://example.com/superpowers.git", sha: SUPERPOWERS_SHA } },
    ],
  }));
  return root;
}

/** A trusted config's text: `review` merged into a minimal valid config. */
export function configText(review = {}) {
  return JSON.stringify({ schemaVersion: 1, shipKit: { version: "0.1.0", sha: "1".repeat(40) }, review });
}

/**
 * An in-memory gh client. `permissions` maps a login to a permission name or
 * a full response body; an unknown login is a 404. `runs`, `artifacts` and
 * `payloads` (keyed "<runId>:<artifact name>") back trustState.
 * `repoResponse` answers the repository read (an Error is thrown);
 * `branchesWhereHead(sha)` answers the branches-where-head read (by default
 * every commit heads "main"); `events` are the PR's issue events.
 */
export function fakeGh({
  permissions = { writer: "write", maint: "maintain", boss: "admin", outsider: "read" },
  comments = [],
  commentsError = null,
  runs = {},
  artifacts = {},
  payloads = {},
  repoResponse = { status: 200, json: { default_branch: "main" } },
  branchesWhereHead = (sha) => ({ status: 200, json: [{ name: "main", commit: { sha }, protected: false }] }),
  events = [],
  eventsError = null,
} = {}) {
  const calls = [];
  const prefix = `repos/${REPOSITORY}`;
  return {
    calls,
    get(path) {
      calls.push(["get", path]);
      const permission = new RegExp(`^${prefix}/collaborators/([^/]+)/permission$`).exec(path);
      if (permission) {
        const value = permissions[decodeURIComponent(permission[1])];
        if (value === undefined) return { status: 404, json: { message: "Not Found" } };
        return { status: 200, json: typeof value === "string" ? { permission: value } : value };
      }
      const run = new RegExp(`^${prefix}/actions/runs/(\\d+)$`).exec(path);
      if (run) {
        return runs[run[1]] === undefined ? { status: 404, json: { message: "Not Found" } } : { status: 200, json: runs[run[1]] };
      }
      if (path === prefix) {
        if (repoResponse instanceof Error) throw repoResponse;
        return repoResponse;
      }
      const heads = new RegExp(`^${prefix}/commits/([0-9a-f]{40})/branches-where-head$`).exec(path);
      if (heads) return branchesWhereHead(heads[1]);
      throw new Error(`fakeGh: unexpected get ${path}`);
    },
    list(path) {
      calls.push(["list", path]);
      if (new RegExp(`^${prefix}/issues/\\d+/events$`).test(path)) {
        if (eventsError) throw eventsError;
        return events;
      }
      if (!new RegExp(`^${prefix}/issues/\\d+/comments$`).test(path)) throw new Error(`fakeGh: unexpected list ${path}`);
      if (commentsError) throw commentsError;
      return comments;
    },
    listKey(path, key) {
      calls.push(["listKey", path, key]);
      const match = new RegExp(`^${prefix}/actions/runs/(\\d+)/artifacts$`).exec(path);
      if (!match || key !== "artifacts") throw new Error(`fakeGh: unexpected listKey ${path}`);
      return artifacts[match[1]] ?? [];
    },
    cli(args) {
      calls.push(["cli", args]);
      const [verb, sub, runId, , , , name, , dir] = args;
      if (verb !== "run" || sub !== "download") throw new Error(`fakeGh: unexpected cli ${args.join(" ")}`);
      const payload = payloads[`${runId}:${name}`];
      if (payload === undefined) throw new Error(`fakeGh: no artifact ${runId}:${name}`);
      writeFileSync(join(dir, "state.json"), payload);
      return "";
    },
  };
}

/** An ls-remote line for a lightweight tag. */
export const tagLine = (sha, name = "ship-kit--v0.2.0") => `${sha}\trefs/tags/${name}\n`;

/** The two ls-remote lines of an annotated tag. */
export const annotatedTag = (tagObject, commitSha, name) => `${tagObject}\trefs/tags/${name}\n${commitSha}\trefs/tags/${name}^{}\n`;

/** Reads one C-quoted token (as git writes it) from the start of `text`. */
export function unquote(text) {
  const named = { n: "\n", t: "\t", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
  let out = "";
  let i = 1;
  while (text[i] !== '"') {
    if (text[i] !== "\\") {
      out += text[i];
      i += 1;
    } else if (/[0-7]/.test(text[i + 1])) {
      out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      out += named[text[i + 1]];
      i += 2;
    }
  }
  return out;
}

/**
 * The paths a patch's `diff --git` headers name, as byte strings.
 * @param {Buffer} patch
 */
export function patchPaths(patch) {
  return patch.toString("latin1").split("\n").filter((line) => line.startsWith("diff --git ")).map((line) => {
    const rest = line.slice("diff --git ".length);
    if (rest.startsWith('"')) return unquote(rest).slice(2);
    const size = (rest.length - 5) / 2;
    return rest.slice(2, 2 + size);
  });
}
