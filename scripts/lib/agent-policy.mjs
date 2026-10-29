#!/usr/bin/env node
// Decides whether an agent may take a governed step (design 5.4) and prints
// one word. Exit 0 with the word on stdout; exit 2 for an unknown argument,
// with a usage line on stderr and nothing on stdout.
//
//   node agent-policy.mjs           proceed | ask     (agents.commitAndPush)
//   node agent-policy.mjs --admin   proceed | refuse   (agents.adminMerge)
//
// The setting comes from the config on the remote's default branch, fetched
// fresh into refs/ship-kit/default, never from the working tree or the
// current branch, so a branch cannot grant itself permission. Only a valid
// config holding an explicit `true` proceeds. A missing origin remote, a
// failed ls-remote or fetch, an absent or invalid config, and any value that
// is not `true` all answer `ask` (`refuse` with --admin). A valid config that
// leaves a setting out takes the schema default (commitAndPush true,
// adminMerge false).
//
// The script never reads CI or GITHUB_ACTIONS: a skill treats `ask` under
// either as a no (design 5.4).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeGit, readDefaultBranchConfig } from "./config.mjs";

const USAGE = "usage: agent-policy.mjs [--admin]";

/**
 * The word for one governed step. Only an ok result whose config holds the
 * setting as the boolean `true` proceeds; a result that cannot be read is
 * treated as not granting. Any truthy `admin` is the admin question, so a
 * mistyped option cannot turn an admin step into a commit-and-push grant.
 * @param {any} result a `readDefaultBranchConfig` result
 * @param {{admin?: boolean}} [options]
 * @returns {"proceed" | "ask" | "refuse"}
 */
export function decide(result, options) {
  const admin = Boolean(options?.admin);
  const setting = admin ? "adminMerge" : "commitAndPush";
  let granted;
  try {
    granted = result?.ok === true && result.config?.agents?.[setting] === true;
  } catch {
    granted = false;
  }
  if (granted) return "proceed";
  return admin ? "refuse" : "ask";
}

/**
 * Reads the default branch's config through the remote named `origin`. That
 * remote must be configured: without it git would treat the name `origin` as
 * a path, and a directory of that name inside the working tree could stand in
 * for the remote.
 * @param {{git?: (args: string[]) => Buffer | string, read?: typeof readDefaultBranchConfig}} [options]
 */
export function readOriginDefaultBranchConfig({ git = makeGit(), read = readDefaultBranchConfig } = {}) {
  try {
    git(["remote", "get-url", "--", "origin"]);
  } catch {
    return { ok: false, reason: "no remote named origin is configured" };
  }
  return read({ git });
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{readDefaultBranchConfig: () => any}} [deps]
 * @param {{out: {write: (s: string) => unknown}, err: {write: (s: string) => unknown}}} [io]
 * @returns {number} exit code
 */
export function main(
  argv,
  deps = { readDefaultBranchConfig: readOriginDefaultBranchConfig },
  io = { out: process.stdout, err: process.stderr },
) {
  let admin = false;
  for (const arg of argv) {
    if (arg !== "--admin") {
      io.err.write(`unknown argument ${JSON.stringify(arg)}\n${USAGE}\n`);
      return 2;
    }
    admin = true;
  }
  let result;
  try {
    result = deps.readDefaultBranchConfig();
  } catch {
    result = { ok: false, reason: "the config reader threw" };
  }
  io.out.write(`${decide(result, { admin })}\n`);
  return 0;
}

/**
 * True when `argv1` (the script node was started with) is this module, so a
 * path through a symlink still counts.
 * @param {string | undefined} argv1
 * @param {string} moduleUrl
 */
export function isMain(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
