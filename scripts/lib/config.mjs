// Reads `.ship-kit/config.json`. `schemas/config.schema.json` is the only
// definition of its shape (design 5.2): `loadConfig` migrates an older
// `schemaVersion` in memory, validates against the schema (filling every
// default) and then applies the few rules a schema cannot state. Local
// readers never trust the working tree: `readDefaultBranchConfig` fetches the
// remote's default branch into the private ref `refs/ship-kit/default` and
// reads the file from that commit (design 5.3, 5.4). Every failure is a
// `{ok: false, reason}` answer, never a throw, so a caller falls back to its
// fail-closed default.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { checkSchema, validate } from "./schema.mjs";
import { MIGRATIONS, checkChain } from "../setup/migrations/index.mjs";

export const SCHEMA_VERSION = 1;
export const SEATS = Object.freeze(["general", "adversarial", "security", "test-integrity"]);
export const DEFAULT_REF = "refs/ship-kit/default";
export const MAX_CONFIG_BYTES = 1024 * 1024;

const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/config.schema.json", import.meta.url), "utf8"));
checkSchema(SCHEMA);

const FILE = new RegExp(SCHEMA.properties.review.properties.huntLists.properties.code.pattern, "u");
const MODEL = new RegExp(SCHEMA.properties.review.properties.model.pattern, "u");
const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 120_000;
const REGULAR_MODES = new Set(["100644", "100755"]);
// ignoreBOM keeps a leading BOM in the text, so loadConfig alone decides
// how many it accepts (one).
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A thrown value's message; migrations and injected runners may throw anything. */
function describe(err) {
  return err instanceof Error ? err.message : `threw a non-Error value (${err === null ? "null" : typeof err})`;
}

/**
 * Rules the schema cannot state. Returns one message per violation.
 * @param {any} config a config that already passed schema validation
 * @returns {string[]}
 */
export function semanticErrors(config) {
  const errors = [];
  const checks = Object.entries(config.render.checks);
  const seen = new Map();
  for (const [seat, name] of checks) {
    if (seen.has(name)) errors.push(`render.checks.${seat} repeats the check name of render.checks.${seen.get(name)}: ${JSON.stringify(name)}`);
    else seen.set(name, seat);
  }
  const seats = config.render.seats;
  if (new Set(seats).size !== seats.length) errors.push("render.seats lists a seat more than once");
  for (const seat of Object.keys(config.review.seats)) {
    if (!SEATS.includes(seat)) errors.push(`review.seats.${seat} is not a ship-kit seat`);
  }
  return errors;
}

function migrate(value, from, migrations) {
  try {
    checkChain(migrations, SCHEMA_VERSION);
  } catch (err) {
    return { ok: false, reason: `invalid migration chain: ${describe(err)}` };
  }
  let current = value;
  for (let version = from; version < SCHEMA_VERSION; version += 1) {
    const step = migrations.find((m) => m.from === version);
    if (step === undefined) return { ok: false, reason: `no migration from schemaVersion ${version}` };
    let next;
    try {
      next = step.migrate(deepFreeze(copy(current)));
    } catch (err) {
      return { ok: false, reason: `migration from schemaVersion ${version} failed: ${describe(err)}` };
    }
    if (!isPlainObject(next) || next.schemaVersion !== step.to) {
      return { ok: false, reason: `migration from schemaVersion ${version} did not produce schemaVersion ${step.to}` };
    }
    current = next;
  }
  return { ok: true, value: current };
}

/**
 * Parses, migrates and validates config text.
 * @param {string} text
 * @param {{migrations?: readonly {from: number, to: number, migrate: Function}[]}} [options]
 * @returns {{ok: true, config: any, migratedFrom: number | null} | {ok: false, reason: string}}
 */
export function loadConfig(text, { migrations = MIGRATIONS } = {}) {
  if (typeof text !== "string") return { ok: false, reason: "config text must be a string" };
  let value;
  try {
    value = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${describe(err)}` };
  }
  if (!isPlainObject(value)) return { ok: false, reason: "config must be a JSON object" };
  const version = value.schemaVersion;
  let migratedFrom = null;
  if (Number.isInteger(version) && version > SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion ${version} was written by a newer ship-kit; this one reads ${SCHEMA_VERSION}` };
  }
  if (Number.isInteger(version) && version < SCHEMA_VERSION) {
    const migrated = migrate(value, version, migrations);
    if (!migrated.ok) return migrated;
    value = migrated.value;
    migratedFrom = version;
  }
  const result = validate(SCHEMA, value);
  if (!result.ok) {
    return { ok: false, reason: result.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ") };
  }
  const errors = semanticErrors(result.value);
  if (errors.length > 0) return { ok: false, reason: errors.join("; ") };
  return { ok: true, config: result.value, migratedFrom };
}

/**
 * The config a run uses when the trusted one is absent or invalid (design
 * 5.3): every default, no design-doc directories, every seat required,
 * maintainer approval only from an admin, and agents that ask before they
 * commit or push and never admin-merge. It describes no install, so it has
 * no `shipKit`.
 */
export function strictConfig() {
  const filled = validate(SCHEMA, { schemaVersion: SCHEMA_VERSION, shipKit: { version: "0.0.0", sha: "0".repeat(40) } }).value;
  delete filled.shipKit;
  filled.review.specDirs = [];
  filled.review.planDirs = [];
  for (const seat of Object.values(filled.review.seats)) seat.mode = "required";
  filled.review.override.minPermission = "admin";
  filled.agents.commitAndPush = false;
  return filled;
}

const SHOWN_MAX = 40;

/** A value as an error message may show it: strings cut to SHOWN_MAX characters, anything else by type. */
function shown(value) {
  if (typeof value !== "string") return value === null ? "null" : typeof value;
  return JSON.stringify(value.length > SHOWN_MAX ? `${value.slice(0, SHOWN_MAX)}...` : value);
}

/**
 * The model a seat runs: its own `review.seats.<seat>.model`, or `review.model`
 * when that is null or the seat has no entry (design 5.1, 6.3). Over a config
 * `loadConfig` or `strictConfig` returned this is always a model id, so a seat
 * never runs on the action's default model. A seat name outside `SEATS` (a
 * typo must not quietly fall back to the review-wide model), and a config built
 * any other way that resolves to anything but a model id, are refused with a
 * throw rather than passed on to a workflow. The messages show at most
 * `SHOWN_MAX` characters of a value.
 * @param {any} config
 * @param {string} seat one of `SEATS`
 * @returns {string}
 */
export function seatModel(config, seat) {
  if (!SEATS.includes(seat)) throw new TypeError(`${shown(seat)} is not a ship-kit seat`);
  const model = config.review.seats[seat]?.model ?? config.review.model;
  if (typeof model !== "string" || !MODEL.test(model)) {
    throw new TypeError(`no valid model for seat ${shown(seat)}: got ${shown(model)}`);
  }
  return model;
}

/**
 * A git runner for `cwd`: bounded, never prompting, ignoring replace refs and
 * running no hooks (a checked-out branch's hooks must not move the ref this
 * module reads). Returns stdout as a Buffer and throws on any failure.
 * @param {string} [cwd]
 * @returns {(args: string[]) => Buffer}
 */
export function makeGit(cwd = process.cwd()) {
  return (args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${devNull}`, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * MAX_CONFIG_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} exited ${result.status ?? result.signal}: ${String(result.stderr).trim()}`);
    }
    return result.stdout;
  };
}

function text(output) {
  return typeof output === "string" ? output : utf8.decode(output);
}

/**
 * Reads and loads the config file `path` at `ref`, which is a full commit SHA
 * or exactly the ref `refs/ship-kit/default` (never a branch or tag that
 * abbreviates to it). Only a regular file counts: a symlink, submodule or
 * directory at `path` is refused.
 * @param {string} ref
 * @param {string} path
 * @param {{git: (args: string[]) => Buffer | string, migrations?: readonly object[]}} options
 * @returns {{ok: true, config: any, migratedFrom: number | null, sha: string} | {ok: false, reason: string}}
 */
export function readConfigAt(ref, path, { git, migrations = MIGRATIONS }) {
  if (typeof ref !== "string" || !(SHA.test(ref) || ref === DEFAULT_REF)) {
    return { ok: false, reason: `ref must be a full commit SHA or ${DEFAULT_REF}` };
  }
  if (typeof path !== "string" || !FILE.test(path)) {
    return { ok: false, reason: `config path ${JSON.stringify(path)} is not a relative file path` };
  }
  try {
    const target = ref === DEFAULT_REF ? text(git(["show-ref", "--verify", "--hash", DEFAULT_REF])).trim() : ref;
    if (!SHA.test(target)) return { ok: false, reason: `could not resolve ${ref} to a commit` };
    const sha = text(git(["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`])).trim();
    if (!SHA.test(sha)) return { ok: false, reason: `could not resolve ${ref} to a commit` };
    const listing = text(git(["ls-tree", "-l", "-z", "--full-tree", sha, "--", path])).split("\0").filter(Boolean);
    if (listing.length === 0) return { ok: false, reason: `${path} is absent at ${ref}` };
    const entry = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(-|\d+)\t(.*)$/s.exec(listing[0]);
    if (listing.length !== 1 || entry === null || entry[5] !== path) {
      return { ok: false, reason: `unexpected tree listing for ${path} at ${ref}` };
    }
    const [, mode, type, oid, size] = entry;
    if (type !== "blob" || !REGULAR_MODES.has(mode)) {
      return { ok: false, reason: `${path} at ${ref} is not a regular file (mode ${mode})` };
    }
    if (Number(size) > MAX_CONFIG_BYTES) return { ok: false, reason: `${path} at ${ref} is larger than ${MAX_CONFIG_BYTES} bytes` };
    if (text(git(["cat-file", "-t", oid])).trim() !== "blob") return { ok: false, reason: `${path} at ${ref} is not a blob` };
    const loaded = loadConfig(text(git(["cat-file", "blob", oid])), { migrations });
    if (!loaded.ok) return { ok: false, reason: `${path} at ${ref}: ${loaded.reason}` };
    return { ...loaded, sha };
  } catch (err) {
    return { ok: false, reason: `could not read ${path} at ${ref}: ${describe(err)}` };
  }
}

/** `git check-ref-format --branch` output for `name`, or "" when git rejects it. */
function validBranch(git, name) {
  try {
    return text(git(["check-ref-format", "--branch", name])).trim();
  } catch {
    return "";
  }
}

/**
 * The local equivalent of CI's trusted commit (design 5.3): finds the
 * remote's default branch, fetches it into `refs/ship-kit/default` and reads
 * the config there, never from the working tree or a local branch.
 * @param {{git?: (args: string[]) => Buffer | string, path?: string, migrations?: readonly object[]}} [options]
 * @returns {{ok: true, config: any, migratedFrom: number | null, branch: string, sha: string} | {ok: false, reason: string, branch?: string}}
 */
export function readDefaultBranchConfig({ git = makeGit(), path = ".ship-kit/config.json", migrations = MIGRATIONS } = {}) {
  let branch;
  try {
    const lines = text(git(["ls-remote", "--symref", "origin", "HEAD"])).split("\n").filter((l) => l.startsWith("ref: "));
    const match = lines.length === 1 ? /^ref: refs\/heads\/(.+)\tHEAD$/.exec(lines[0]) : null;
    if (match === null) return { ok: false, reason: "origin does not name its default branch (ls-remote --symref origin HEAD)" };
    branch = match[1];
    if (branch.startsWith("-") || validBranch(git, branch) !== branch) {
      return { ok: false, reason: `origin's default branch name ${JSON.stringify(branch)} is not a valid branch name`, branch };
    }
    git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${branch}:${DEFAULT_REF}`]);
  } catch (err) {
    return { ok: false, reason: `could not fetch origin's default branch: ${describe(err)}`, ...(branch === undefined ? {} : { branch }) };
  }
  const read = readConfigAt(DEFAULT_REF, path, { git, migrations });
  return { ...read, branch };
}
