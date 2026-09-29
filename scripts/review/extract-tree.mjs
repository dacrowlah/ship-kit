#!/usr/bin/env node
// Writes a commit's tree into a directory as plain files, for a review seat
// to read as data. Every blob is read with `git cat-file blob`, so no
// attribute, filter or end-of-line conversion from the tree applies. A
// symlink becomes a text file `symlink to <target>`, a submodule a text file
// `submodule at <sha>`, and every file is created 0644 with flag `wx`, so an
// existing path (including a case-folded collision on a case-insensitive
// disk) is refused, never overwritten. Nothing written can be a symlink or an
// executable.
//
// A path is refused when it is empty, absolute, not UTF-8, contains a
// backslash, an empty, `.` or `..` component, a component equal to `.git`
// (or its short name `git~<n>`), a component ending in a dot or space, a
// component holding a colon (NTFS stream syntax, so `.claude::$INDEX_ALLOCATION`
// cannot create `.claude`) or one of `<>"|?*`, or a component that is a
// Windows device name; all comparisons ignore case, because a macOS or
// Windows disk does. A name the filesystem rejects is refused, not fatal. A
// basename `.ignore` or `.rgignore` becomes `<name>.ship-kit-renamed`, so it
// cannot hide files from Grep and Glob, and every component `.claude` becomes
// `.claude.ship-kit-renamed`, so nothing written can load as a skill,
// command, agent or setting; a rename whose target also exists in the tree is
// refused. The scope file lists every rename, refusal and written path, one
// JSON record per line.
//
// Usage (run with the workspace repository as the working directory):
//   node scripts/review/extract-tree.mjs --commit <40 hex> --out <dir> --scope <file>
//
// `--out` must be absent or an empty directory that is not a symlink.
// Exit 0: written. Exit 1: a git call failed, timed out or its output was
// unparseable, or a limit (100,000 entries, 512 MiB of blob bytes) was
// exceeded; the scope file is not written. Exit 2: usage.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_ENTRIES = 100000;
export const MAX_BYTES = 512 * 1024 * 1024;
export const GIT_TIMEOUT_MS = 120000;
const LS_TREE_MAX_BYTES = 256 * 1024 * 1024;
const RENAMED = ".ship-kit-renamed";
const USAGE = "usage: extract-tree.mjs --commit <40 hex> --out <dir> --scope <file>";

export class UsageError extends Error {}
export class CallError extends Error {}
export class LimitError extends Error {}

/** @param {string[]} argv @returns {{commit: string, out: string, scope: string}} */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--commit", "--out", "--scope"].includes(flag) || value === undefined) throw new UsageError(USAGE);
    opts[flag.slice(2)] = value;
  }
  if (!/^[0-9a-f]{40}$/.test(opts.commit ?? "")) {
    throw new UsageError(`--commit must be 40 lower-case hex characters\n${USAGE}`);
  }
  if (!opts.out) throw new UsageError(`--out is required\n${USAGE}`);
  if (!opts.scope) throw new UsageError(`--scope is required\n${USAGE}`);
  return opts;
}

/**
 * Parses `git ls-tree -r -z --full-tree <commit>` output. Paths are decoded
 * as UTF-8; invalid bytes become U+FFFD, which `refusalReason` refuses.
 * @param {Buffer} buffer
 * @returns {{mode: string, type: string, sha: string, path: string}[]}
 */
export function parseLsTree(buffer) {
  const entries = [];
  const decoder = new TextDecoder("utf-8");
  let start = 0;
  for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0, start)) {
    const record = buffer.subarray(start, end);
    const tab = record.indexOf(9);
    const header = tab === -1 ? null : record.subarray(0, tab).toString("latin1").match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})$/);
    if (!header) throw new CallError(`unparseable ls-tree output: ${JSON.stringify(record.toString("latin1"))}`);
    entries.push({ mode: header[1], type: header[2], sha: header[3], path: decoder.decode(record.subarray(tab + 1)) });
    start = end + 1;
  }
  if (start !== buffer.length) throw new CallError("unparseable ls-tree output: a record has no NUL terminator");
  return entries;
}

// A Windows device name, alone or before the first dot, with optional spaces
// before that dot; COM and LPT also take the superscript digits 1 to 3.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(\.|$)/i;

/** @param {string} path @returns {string | null} why the path is refused, or null */
export function refusalReason(path) {
  if (path === "") return "empty path";
  if (path.includes("\ufffd")) return "not valid UTF-8";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "a backslash";
  const components = path.split("/");
  if (components.some((c) => c === "" || c === "." || c === "..")) return "a component is empty, . or ..";
  if (components.some((c) => c.toLowerCase() === ".git" || /^git~[0-9]+$/i.test(c))) return "a component is .git";
  if (components.some((c) => c.endsWith(".") || c.endsWith(" "))) return "a component ends in a dot or space";
  if (components.some((c) => c.includes(":"))) return "a component contains a colon";
  if (components.some((c) => /[<>"|?*]/.test(c))) return "a component contains a character Windows forbids";
  if (components.some((c) => WINDOWS_DEVICE.test(c))) return "a component is a Windows device name";
  return null;
}

/** @param {string} path an accepted path @returns {string} the path it is written at */
export function targetPath(path) {
  const components = path.split("/").map((c) => (c.toLowerCase() === ".claude" ? `${c}${RENAMED}` : c));
  const last = components.length - 1;
  if ([".ignore", ".rgignore"].includes(components[last].toLowerCase())) components[last] += RENAMED;
  return components.join("/");
}

function supported({ mode, type }) {
  return ((mode === "100644" || mode === "100755" || mode === "120000") && type === "blob") ||
    (mode === "160000" && type === "commit");
}

const COLLISION_CODES = new Set(["EEXIST", "ENOTDIR", "EISDIR"]);
const NAME_CODES = new Set(["ENAMETOOLONG", "EINVAL"]);

/**
 * @param {{mode: string, type: string, sha: string, path: string}[]} entries
 * @param {{readBlob: (sha: string, maxBytes: number) => Buffer, out: string, maxEntries?: number, maxBytes?: number}} opts
 *   readBlob returns the raw blob and throws LimitError past maxBytes.
 * @returns {{written: string[], refused: {path: string, reason: string}[], renamed: {from: string, to: string}[]}}
 */
export function extractEntries(entries, { readBlob, out, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }) {
  if (entries.length > maxEntries) {
    throw new LimitError(`${entries.length} tree entries exceed the limit of ${maxEntries}`);
  }
  const treePaths = new Set(entries.map((e) => e.path.toLowerCase()));
  const result = { written: [], refused: [], renamed: [] };
  const refuse = (path, reason) => result.refused.push({ path, reason });
  let used = 0;
  for (const entry of entries) {
    const reason = refusalReason(entry.path);
    if (reason) {
      refuse(entry.path, reason);
      continue;
    }
    if (!supported(entry)) {
      refuse(entry.path, "unsupported entry");
      continue;
    }
    const to = targetPath(entry.path);
    if (to !== entry.path && treePaths.has(to.toLowerCase())) {
      refuse(entry.path, `renamed target exists in the tree: ${to}`);
      continue;
    }
    let content;
    if (entry.type === "commit") {
      content = Buffer.from(`submodule at ${entry.sha}`);
    } else {
      let blob;
      try {
        blob = readBlob(entry.sha, maxBytes - used);
      } catch (error) {
        if (error instanceof LimitError) throw new LimitError(`blob bytes exceed the limit of ${maxBytes} bytes`);
        throw error;
      }
      used += blob.length;
      if (used > maxBytes) throw new LimitError(`blob bytes exceed the limit of ${maxBytes} bytes`);
      content = entry.mode === "120000" ? Buffer.concat([Buffer.from("symlink to "), blob]) : blob;
    }
    const dest = join(out, ...to.split("/"));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if (COLLISION_CODES.has(error.code)) refuse(entry.path, "collides with an existing path");
      else if (NAME_CODES.has(error.code)) refuse(entry.path, "the filesystem refused the name");
      else throw error;
      continue;
    }
    result.written.push(to);
    if (to !== entry.path) result.renamed.push({ from: entry.path, to });
  }
  return result;
}

/** @param {{written: string[], refused: {path: string, reason: string}[], renamed: {from: string, to: string}[]}} result */
export function scopeLines(result) {
  const records = [
    ...result.renamed.map(({ from, to }) => ({ type: "renamed", from, to })),
    ...result.refused.map(({ path, reason }) => ({ type: "refused", path, reason })),
    ...result.written.map((path) => ({ type: "written", path })),
  ];
  return records.map((r) => `${JSON.stringify(r)}\n`).join("");
}

/**
 * @param {string} cwd the repository to read
 * @returns {(args: string[], maxBytes: number) => Buffer} runs git with a
 *   timeout; throws LimitError when stdout exceeds maxBytes and CallError on
 *   any other failure.
 */
export function gitRunner(cwd, { timeout = GIT_TIMEOUT_MS, command = "git" } = {}) {
  return (args, maxBytes) => {
    try {
      return execFileSync(command, args, {
        cwd, timeout, killSignal: "SIGKILL", maxBuffer: maxBytes + 1, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const label = `git ${args.join(" ")}`;
      if (error.code === "ENOBUFS") throw new LimitError(`${label}: output exceeds the limit of ${maxBytes} bytes`);
      const why = error.code === "ETIMEDOUT" ? "timed out" : error.status != null ? `exit ${error.status}` : error.code;
      const stderr = error.stderr ? String(error.stderr).trim() : "";
      throw new CallError(`${label} failed (${why})${stderr ? `: ${stderr}` : ""}`);
    }
  };
}

function checkOut(out, scope) {
  const root = resolve(out);
  const scopePath = resolve(scope);
  if (scopePath === root || scopePath.startsWith(`${root}${sep}`)) throw new UsageError("--scope must not be inside --out");
  const stat = lstatSync(out, { throwIfNoEntry: false });
  if (stat === undefined) {
    mkdirSync(out, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink()) throw new UsageError(`--out ${out} is a symlink`);
  if (!stat.isDirectory()) throw new UsageError(`--out ${out} is not a directory`);
  if (readdirSync(out).length > 0) throw new UsageError(`--out ${out} exists and is not empty`);
}

/** @returns {number} exit code */
export function main(argv, deps = { git: gitRunner(process.cwd()) }, io = { out: process.stdout, err: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
    checkOut(opts.out, opts.scope);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err.write(`${error.message}\n`);
    return 2;
  }
  let result;
  try {
    const entries = parseLsTree(deps.git(["ls-tree", "-r", "-z", "--full-tree", `${opts.commit}^{commit}`], LS_TREE_MAX_BYTES));
    result = extractEntries(entries, {
      readBlob: (sha, maxBytes) => deps.git(["cat-file", "blob", sha], maxBytes),
      out: opts.out,
      ...deps.limits,
    });
  } catch (error) {
    if (!(error instanceof CallError || error instanceof LimitError)) throw error;
    io.err.write(`extract-tree: stopped; no scope written.\n${error.message}\n`);
    return 1;
  }
  writeFileSync(opts.scope, scopeLines(result));
  io.out.write(`${result.written.length} written, ${result.renamed.length} renamed, ${result.refused.length} refused\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
