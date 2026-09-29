// Setup's release pin. The running plugin's version names a tag on the
// ship-kit remote; the tag's peeled commit becomes the pin only when the
// plugin's templates, schemas and migrations are byte-for-byte the files at
// that commit. A plugin installed from the default branch or a checkout
// mid-release would otherwise render callers for a workflow the pinned commit
// does not have. Every failure, including any git error, is a PinError.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RELEASE_TAG, parseLsRemote } from "../lib/release-tags.mjs";

export class PinError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinError";
  }
}

export const COMPARED_ROOTS = ["templates", "schemas", "scripts/setup/migrations"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 120_000;
export const MAX_FILES = 10_000;
const HASH_BATCH = 100;
const REGULAR_MODES = new Set(["100644", "100755"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * git's environment: the caller's, minus every inherited GIT_* variable (a
 * hook in a linked worktree inherits GIT_DIR, which would point every
 * command at the caller's repository), with no global or system config (a
 * url.<base>.insteadOf there could redirect the remote), no replace refs and
 * no terminal prompt. `gitDir`, when given, is the only repository git sees.
 * ship-kit is public, so no credential helper is needed.
 * @param {string | undefined} gitDir
 * @param {NodeJS.ProcessEnv} [inherited]
 */
export function gitEnv(gitDir, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  if (gitDir !== undefined) env.GIT_DIR = gitDir;
  return env;
}

/**
 * Runs git with a timeout in an isolated environment; throws on any failure.
 * @param {string[]} args
 * @param {{ cwd: string, gitDir?: string }} options
 * @returns {Buffer} stdout
 */
export function runGit(args, { cwd, gitDir }) {
  const result = spawnSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv(gitDir),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} exited ${result.status ?? result.signal}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function text(output, what) {
  if (typeof output === "string") return output;
  try {
    return utf8.decode(output);
  } catch {
    throw new PinError(`${what} is not valid UTF-8`);
  }
}

function readVersion(pluginRoot) {
  const manifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    throw new PinError(`cannot read the plugin version from ${manifest}: ${error.message}`);
  }
  const version = parsed?.version;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new PinError(`plugin.json version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`);
  }
  return version;
}

function chooseTag(version, tag) {
  const release = `ship-kit--v${version}`;
  if (tag === undefined) return release;
  if (typeof tag === "string" && RELEASE_TAG.test(tag) && (tag === release || tag.startsWith(`${release}-rc.`))) {
    return tag;
  }
  throw new PinError(`--tag ${JSON.stringify(tag)} is neither ${release} nor ${release}-rc.<n>`);
}

/**
 * The plugin's side: every path under the compared roots, as
 * Map<path, oid | null> where null marks a symlink or other non-regular file.
 */
function pluginEntries(pluginRoot, git, cwd, maxFiles) {
  const entries = new Map();
  const regular = [];
  const visit = (rel) => {
    const stat = lstatSync(join(pluginRoot, rel), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      for (const raw of readdirSync(join(pluginRoot, rel), { encoding: "buffer" })) {
        visit(`${rel}/${text(raw, `a file name under ${rel}`)}`);
      }
      return;
    }
    if (entries.size >= maxFiles) throw tooMany(maxFiles);
    entries.set(rel, null);
    if (stat.isFile()) regular.push(rel);
  };
  for (const root of COMPARED_ROOTS) {
    // Each leading component must be a real directory: a symlinked
    // `scripts` would otherwise redirect the walk outside the plugin.
    const parts = root.split("/");
    let rel = parts[0];
    let ok = true;
    for (let i = 1; i < parts.length && ok; i += 1) {
      const stat = lstatSync(join(pluginRoot, rel), { throwIfNoEntry: false });
      if (stat === undefined) ok = false;
      else if (!stat.isDirectory()) {
        entries.set(rel, null);
        ok = false;
      } else rel = `${rel}/${parts[i]}`;
    }
    if (ok) visit(rel);
  }
  for (let i = 0; i < regular.length; i += HASH_BATCH) {
    const batch = regular.slice(i, i + HASH_BATCH);
    const oids = text(
      git(["hash-object", "--no-filters", "--", ...batch.map((rel) => join(pluginRoot, rel))], { cwd }),
      "git hash-object output",
    ).split("\n");
    batch.forEach((rel, j) => {
      if (!SHA.test(oids[j] ?? "")) throw new PinError(`git hash-object gave no object id for ${rel}`);
      entries.set(rel, oids[j]);
    });
  }
  return entries;
}

function tooMany(maxFiles) {
  return new PinError(`more than ${maxFiles} files under ${COMPARED_ROOTS.join(", ")}`);
}

function underRoots(path) {
  return COMPARED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The tag's side, from `git ls-tree -r -z`: Map<path, oid | null>. */
function tagEntries(sha, git, cwd, maxFiles) {
  const out = text(git(["ls-tree", "-r", "-z", "--full-tree", sha, "--", ...COMPARED_ROOTS], { cwd }), "git ls-tree output");
  const entries = new Map();
  const records = out.split("\0");
  if (records[records.length - 1] === "") records.pop();
  if (records.length > maxFiles) throw tooMany(maxFiles);
  for (const record of records) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(record);
    if (!match) throw new PinError(`unreadable git ls-tree entry: ${JSON.stringify(record)}`);
    const [, mode, type, oid, path] = match;
    if (!underRoots(path)) continue;
    entries.set(path, type === "blob" && REGULAR_MODES.has(mode) ? oid : null);
  }
  return entries;
}

function firstDifference(plugin, tag) {
  const paths = [...new Set([...plugin.keys(), ...tag.keys()])].sort();
  return paths.find((path) => {
    const mine = plugin.get(path);
    // undefined (absent) or null (not a regular file) on either side differs.
    return mine == null || mine !== tag.get(path);
  });
}

/**
 * @param {{ pluginRoot: string, remote?: string, tag?: string,
 *   git?: (args: string[], options: { cwd: string, gitDir: string }) => Buffer | string,
 *   maxFiles?: number }} options
 * @returns {{ tag: string, sha: string, version: string }}
 */
export function resolvePin({ pluginRoot, remote = "https://github.com/dacrowlah/ship-kit", tag, git = runGit, maxFiles = MAX_FILES }) {
  const root = resolve(pluginRoot);
  const version = readVersion(root);
  const chosen = chooseTag(version, tag);
  if (typeof remote !== "string" || remote === "" || remote.startsWith("-")) {
    throw new PinError(`unusable remote ${JSON.stringify(remote)}`);
  }
  const work = mkdtempSync(join(tmpdir(), "ship-kit-pin-"));
  try {
    return pinAt({ root, remote, chosen, version, git, work, maxFiles });
  } catch (error) {
    if (error instanceof PinError) throw error;
    throw new PinError(`cannot resolve the pin: ${error.message}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function pinAt({ root, remote, chosen, version, git, work, maxFiles }) {
  const call = (args) => {
    try {
      return git(args, { cwd: work, gitDir: work });
    } catch (error) {
      throw new PinError(`git ${args[0]} failed: ${error.message}`);
    }
  };
  call(["init", "--bare", "--quiet", work]);
  const listing = text(
    call(["ls-remote", "--end-of-options", remote, `refs/tags/${chosen}`, `refs/tags/${chosen}^{}`]),
    "git ls-remote output",
  );
  let tags;
  try {
    tags = parseLsRemote(listing);
  } catch (error) {
    throw new PinError(`cannot read git ls-remote output: ${error.message}`);
  }
  const found = tags.get(chosen);
  if (found === undefined) throw new PinError(`tag ${chosen} not found on ${remote}`);
  const sha = found.commit;
  call(["fetch", "--quiet", "--no-tags", "--depth", "1", "--end-of-options", remote, sha]);
  const peeled = text(call(["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`]), "git rev-parse output").trim();
  if (peeled !== sha) throw new PinError(`tag ${chosen} does not peel to the commit ${sha}`);
  const differing = firstDifference(pluginEntries(root, call, work, maxFiles), tagEntries(sha, call, work, maxFiles));
  if (differing !== undefined) {
    throw new PinError(`${differing} differs between the running plugin and ${chosen} (${sha})`);
  }
  return { tag: chosen, sha, version };
}
