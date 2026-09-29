#!/usr/bin/env node
// Bumps `.claude-plugin/plugin.json`'s `version` and regenerates every seat
// skill's marker token (`skill_marker: <skill>@<version>:<16 hex>`) to match.
//
// Every change is computed first, over the pre-change contents of every
// git-tracked file; nothing is written until every skill's marker line has
// been checked and every new token proven unique. A malformed marker line, a
// marker naming a directory other than the one its SKILL.md lives in, or a
// SKILL.md carrying the line more than once, fails the whole run and leaves
// every file byte-identical to before the run.
//
// Usage: node scripts/release/bump-version.mjs <x.y.z> [--root <dir>]

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { matchGlob } from "../lib/glob.mjs";

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PLUGIN_JSON_PATH = ".claude-plugin/plugin.json";
export const SKILL_MARKER_GLOB = "skills/*/SKILL.md";

const MARKER_LOOSE = /^skill_marker:.*$/gm;
const MARKER_STRICT = /^skill_marker: ([^\r\n@]+)@([^\r\n:]+):([0-9a-f]{16})\r?$/;
const MAX_TOKEN_ATTEMPTS = 100;

export class BumpVersionError extends Error {}

/** @returns {string} 16 lowercase hex characters */
export function defaultRandom() {
  return randomBytes(8).toString("hex");
}

/**
 * @param {string} root
 * @returns {string[]} repo-relative paths of every git-tracked file under `root`
 */
export function defaultListTracked(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) {
    throw new BumpVersionError(`git ls-files failed to run in ${root}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new BumpVersionError(`git ls-files exited ${result.status} in ${root}: ${result.stderr}`);
  }
  return result.stdout.split("\0").filter((line) => line.length > 0);
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Reads every tracked file (in full) so the caller can check whether a
 * candidate token already appears anywhere in the tree, before it writes
 * anything.
 * @param {string} root
 * @param {string[]} tracked
 * @returns {string[]} file contents, one per tracked path, unreadable paths as ""
 */
function readTrackedContents(root, tracked) {
  return tracked.map((path) => readTextOrEmpty(join(root, path)));
}

/**
 * @param {{ path: string, name: string, dirName: string, match: RegExpMatchArray, start: number }} candidate
 * @returns {void} throws BumpVersionError when the marker is malformed or misnamed
 */
function assertValidMarker(candidate, skillPath) {
  const { match, dirName } = candidate;
  const strict = MARKER_STRICT.exec(match[0]);
  if (!strict) {
    throw new BumpVersionError(`malformed skill_marker line in ${skillPath}: ${JSON.stringify(match[0])}`);
  }
  const [, name] = strict;
  if (name !== dirName) {
    throw new BumpVersionError(
      `skill_marker in ${skillPath} names "${name}", expected "${dirName}"`,
    );
  }
}

/**
 * Finds the skill_marker candidate line in a SKILL.md's content.
 * @param {string} content
 * @param {string} skillPath
 * @returns {{ match: RegExpMatchArray } | null} null when the file carries no marker
 */
function findMarkerCandidate(content, skillPath) {
  const matches = [...content.matchAll(MARKER_LOOSE)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new BumpVersionError(`skill_marker line appears ${matches.length} times in ${skillPath}`);
  }
  return { match: matches[0] };
}

/**
 * @param {() => string} random
 * @param {(token: string) => boolean} exists
 * @returns {string} a token that exists nowhere else in the tree and was not
 *   already handed out this run
 */
function generateUniqueToken(random, exists) {
  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const token = random();
    if (!exists(token)) return token;
  }
  throw new BumpVersionError(`could not generate a unique skill_marker token after ${MAX_TOKEN_ATTEMPTS} attempts`);
}

/**
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.version
 * @param {() => string} [options.random]
 * @param {(root: string) => string[]} [options.listTracked]
 * @returns {{ changed: string[] }} repo-relative paths written, plugin.json first
 */
export function bumpVersion({ root, version, random = defaultRandom, listTracked = defaultListTracked }) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new BumpVersionError(`invalid version (expected x.y.z): ${JSON.stringify(version)}`);
  }

  const tracked = listTracked(root);
  const trackedContents = readTrackedContents(root, tracked);
  const generatedTokens = new Set();

  function tokenExists(token) {
    if (generatedTokens.has(token)) return true;
    return trackedContents.some((text) => text.includes(token));
  }

  const skillFiles = tracked.filter((path) => matchGlob(path, SKILL_MARKER_GLOB)).sort();

  const plannedWrites = [];

  const pluginJsonAbsPath = join(root, PLUGIN_JSON_PATH);
  const pluginRaw = readFileSync(pluginJsonAbsPath, "utf8");
  const pluginJson = JSON.parse(pluginRaw);
  pluginJson.version = version;
  plannedWrites.push({
    path: pluginJsonAbsPath,
    content: `${JSON.stringify(pluginJson, null, 2)}\n`,
  });

  for (const skillPath of skillFiles) {
    const absPath = join(root, skillPath);
    const content = readFileSync(absPath, "utf8");
    const candidate = findMarkerCandidate(content, skillPath);
    if (candidate === null) continue;

    const dirName = basename(dirname(skillPath));
    assertValidMarker({ ...candidate, dirName }, skillPath);

    const { match } = candidate;
    const [, name] = MARKER_STRICT.exec(match[0]);
    const token = generateUniqueToken(random, tokenExists);
    generatedTokens.add(token);

    const start = match.index;
    const end = start + match[0].length;
    const newLine = `skill_marker: ${name}@${version}:${token}`;
    const newContent = content.slice(0, start) + newLine + content.slice(end);
    plannedWrites.push({ path: absPath, content: newContent });
  }

  for (const { path, content } of plannedWrites) {
    writeFileSync(path, content, "utf8");
  }

  return { changed: plannedWrites.map(({ path }) => relative(root, path)) };
}

/**
 * @param {string[]} args argv without the node and script entries
 * @returns {{ version: string, root: string }}
 */
export function parseArgs(args) {
  if (args.length === 0) {
    throw new BumpVersionError("usage: bump-version.mjs <x.y.z> [--root <dir>]");
  }
  const [version, ...rest] = args;
  let root = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") {
      if (i + 1 >= rest.length) {
        throw new BumpVersionError("--root requires a value");
      }
      root = rest[i + 1];
      i++;
    } else {
      throw new BumpVersionError(`unknown argument: ${rest[i]}`);
    }
  }
  return { version, root };
}

/**
 * @param {string[]} argv full process.argv
 * @returns {number} exit code
 */
export function main(argv) {
  try {
    const { version, root } = parseArgs(argv.slice(2));
    const { changed } = bumpVersion({ root, version });
    for (const path of changed) {
      console.log(path);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof BumpVersionError ? err.message : err.stack ?? String(err));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv);
}
