// Reads `.ship-kit/config.json`. `schemas/config.schema.json` is the only
// definition of its shape (design 5.2): `loadConfig` migrates an older
// `schemaVersion` in memory, validates against the schema (filling every
// default) and then applies the few rules a schema cannot state. Local
// readers never trust the working tree: `readDefaultBranchConfig` fetches the
// remote's default branch into the private ref `refs/ship-kit/default` and
// reads the file from that commit (design 5.3, 5.4). The remote is `origin`,
// and only as a configured remote with a network URL: git reads an
// unconfigured name as a path and resolves a local-path URL against the
// working tree, so either would let a directory committed on a branch stand
// in for the remote. The working directory must also be inside an ordinary
// checkout, since a bare repository committed on a branch would otherwise be
// taken as the repository, bringing its own `origin`.
//
// `readOriginRepository({ git, gh })` answers which GitHub repository that
// same `origin` is, `{ok: true, owner, name, slug}`, for a caller that reads
// the config from `origin` and calls the GitHub API: it takes owner/name from
// origin's URL (https://host/owner/name, ssh://host/owner/name or
// host:owner/name) and refuses unless `gh repo view` names the same
// repository (compared without regard to case, as GitHub does), so a second
// remote that gh resolves to instead can never pair one repository's config
// with another's pull requests. The slug it answers is gh's spelling.
//
// Every failure is a `{ok: false, reason}` answer, never a throw, so a caller
// falls back to its fail-closed default.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { makeGh, repoSlug } from "./gh.mjs";
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
// The schemes whose transports reach another machine. `file` and every
// other scheme are refused, as is a `<helper>::<address>` remote helper.
const NETWORK_SCHEMES = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"]);
// The URL forms readOriginRepository reads owner and name from: https and
// ssh URLs, and the scp-like ssh form. `repoSlug` then validates both parts.
const GITHUB_URLS = [
  /^https:\/\/(?:[^@/]+@)?[^@/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/(?:[^@/]+@)?[^@/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  /^(?:[^@/:]+@)?[^@/:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
];
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
 * A git runner for `cwd`: bounded, never prompting, ignoring replace refs,
 * running no hooks (a checked-out branch's hooks must not move the ref this
 * module reads) and never adopting a bare repository it was not pointed at
 * (a bare repository committed on a branch would bring its own config, and
 * with it its own `origin`). Returns stdout as a Buffer and throws on any
 * failure.
 * @param {string} [cwd]
 * @returns {(args: string[]) => Buffer}
 */
export function makeGit(cwd = process.cwd()) {
  return (args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "safe.bareRepository=explicit", ...args], {
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

/**
 * Whether `url` is one the trusted config may be fetched from: a URL whose
 * scheme is in NETWORK_SCHEMES, or an scp-like `[user@]host:path` (a colon
 * after a host of two or more characters, before any slash or backslash).
 * Everything else is refused: a local path, which git resolves against the
 * working tree's top level; a one-letter host, which is a drive letter on
 * Windows; another scheme, `file` included; a remote helper; a value that
 * starts with a dash; one holding a control character. `allowLocalRemote:
 * true` (tests only) also admits an absolute local path; a relative one is
 * never admitted.
 * @param {unknown} url
 * @param {{allowLocalRemote?: boolean}} [options]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkRemoteUrl(url, { allowLocalRemote = false } = {}) {
  const refuse = (why) => ({ ok: false, reason: `origin's URL ${why}` });
  if (typeof url !== "string" || url === "") return refuse("is missing");
  if (/[\x00-\x1f\x7f]/.test(url)) return refuse("holds a control character");
  if (url.startsWith("-")) return refuse("starts with a dash");
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url)) return refuse("names a remote helper");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme !== null) {
    return NETWORK_SCHEMES.has(scheme[1]) ? { ok: true } : refuse(`uses the ${scheme[1]} scheme, not a network one`);
  }
  const colon = url.indexOf(":");
  const separator = url.search(/[/\\]/);
  if (colon > 1 && (separator === -1 || separator > colon)) return { ok: true };
  if (allowLocalRemote === true && url.startsWith("/")) return { ok: true };
  return refuse("is a local path");
}

/** `output` without its one trailing newline. */
function line(output) {
  const value = text(output);
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

/**
 * Refuses a working directory that is not inside an ordinary checkout: a bare
 * repository, or a git directory other than the one the checkout's top level
 * uses (a directory planted to look like a git directory, whose config names
 * a work tree). `makeGit` already stops git 2.38 and later from adopting a
 * bare repository it finds; these checks hold on any git.
 * @param {(args: string[]) => Buffer | string} git
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkRepository(git) {
  try {
    if (line(git(["rev-parse", "--is-bare-repository"])) !== "false") {
      return { ok: false, reason: "the working directory is inside a bare repository, not a checkout" };
    }
    const top = line(git(["rev-parse", "--show-toplevel"]));
    const here = line(git(["rev-parse", "--absolute-git-dir"]));
    if (top === "" || line(git(["-C", top, "rev-parse", "--absolute-git-dir"])) !== here) {
      return { ok: false, reason: "the working directory's git directory is not the one its checkout's top level uses" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not identify the working directory's repository: ${describe(err)}` };
  }
}

/**
 * The URL to fetch `origin` from. The working directory must pass
 * checkRepository; `remote.origin.url` must be set and non-empty (a
 * `remote.origin` section without one makes `git remote get-url` print the
 * bare word `origin`, which git would read as a path); the URL git uses for
 * it (after `url.<base>.insteadOf`, as `git remote get-url` gives it) must
 * pass checkRemoteUrl; and rewriting that URL again must leave it unchanged,
 * so the URL checked here is the one git contacts when it is passed on the
 * command line. The URL, not the name, goes to git: settings kept under
 * `remote.origin.*` (a proxy, an upload-pack path) do not apply to this read.
 * @param {(args: string[]) => Buffer | string} git
 * @param {{allowLocalRemote?: boolean}} options
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function originUrl(git, options) {
  const repository = checkRepository(git);
  if (!repository.ok) return repository;
  let configured;
  try {
    configured = line(git(["config", "--get", "remote.origin.url"]));
  } catch {
    configured = "";
  }
  if (configured === "") return { ok: false, reason: "no remote named origin is configured with a url" };
  const url = line(git(["remote", "get-url", "--", "origin"]));
  const checked = checkRemoteUrl(url, options);
  if (!checked.ok) return checked;
  if (line(git(["ls-remote", "--get-url", "--", url])) !== url) {
    return { ok: false, reason: "origin's URL is rewritten again by a url.<base>.insteadOf setting" };
  }
  return { ok: true, url };
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
 * the config there, never from the working tree or a local branch. The
 * remote is `origin`'s URL as `originUrl` checks it, passed to git after
 * `--`; without such a remote the answer is not ok. `allowLocalRemote: true`
 * exists for tests, whose remotes are local repositories.
 * @param {{git?: (args: string[]) => Buffer | string, path?: string, migrations?: readonly object[], allowLocalRemote?: boolean}} [options]
 * @returns {{ok: true, config: any, migratedFrom: number | null, branch: string, sha: string} | {ok: false, reason: string, branch?: string}}
 */
export function readDefaultBranchConfig({
  git = makeGit(),
  path = ".ship-kit/config.json",
  migrations = MIGRATIONS,
  allowLocalRemote = false,
} = {}) {
  let branch;
  try {
    const origin = originUrl(git, { allowLocalRemote });
    if (!origin.ok) return origin;
    const lines = text(git(["ls-remote", "--symref", "--", origin.url, "HEAD"])).split("\n").filter((l) => l.startsWith("ref: "));
    const match = lines.length === 1 ? /^ref: refs\/heads\/(.+)\tHEAD$/.exec(lines[0]) : null;
    if (match === null) return { ok: false, reason: "origin does not name its default branch (ls-remote --symref origin HEAD)" };
    branch = match[1];
    if (branch.startsWith("-") || validBranch(git, branch) !== branch) {
      return { ok: false, reason: `origin's default branch name ${JSON.stringify(branch)} is not a valid branch name`, branch };
    }
    git(["fetch", "--no-tags", "--quiet", "--", origin.url, `+refs/heads/${branch}:${DEFAULT_REF}`]);
  } catch (err) {
    return { ok: false, reason: `could not fetch origin's default branch: ${describe(err)}`, ...(branch === undefined ? {} : { branch }) };
  }
  const read = readConfigAt(DEFAULT_REF, path, { git, migrations });
  return { ...read, branch };
}

/** The repository `url` names in one of GITHUB_URLS' forms, or null. */
function githubSlug(url) {
  const match = GITHUB_URLS.map((form) => form.exec(url)).find((m) => m !== null);
  if (match === undefined) return null;
  try {
    return repoSlug(`${match[1]}/${match[2]}`);
  } catch {
    return null;
  }
}

/**
 * The GitHub repository `origin` names, confirmed against `gh repo view`
 * (see the module header). gh resolves the repository from the process's
 * working directory, so `git` must run in that same directory, as the
 * default runner does.
 * @param {{git?: (args: string[]) => Buffer | string, gh?: {cli: (args: string[]) => string}}} [options]
 * @returns {{ok: true, owner: string, name: string, slug: string} | {ok: false, reason: string}}
 */
export function readOriginRepository({ git = makeGit(), gh = makeGh() } = {}) {
  let origin;
  try {
    origin = originUrl(git, {});
  } catch (err) {
    return { ok: false, reason: `could not read origin's URL: ${describe(err)}` };
  }
  if (!origin.ok) return origin;
  const named = githubSlug(origin.url);
  if (named === null) {
    return {
      ok: false,
      reason: "origin's URL does not name a GitHub repository as https://host/owner/name, ssh://host/owner/name or host:owner/name",
    };
  }
  let viewed;
  try {
    viewed = repoSlug(JSON.parse(gh.cli(["repo", "view", "--json", "nameWithOwner"]))?.nameWithOwner);
  } catch (err) {
    return { ok: false, reason: `could not read gh repo view: ${describe(err)}` };
  }
  if (viewed.slug.toLowerCase() !== named.slug.toLowerCase()) {
    return { ok: false, reason: `gh repo view names ${viewed.slug} but origin names ${named.slug}; refusing to mix two repositories` };
  }
  return { ok: true, owner: viewed.owner, name: viewed.name, slug: viewed.slug };
}
