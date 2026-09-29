// Every GitHub API call ship-kit makes goes through this module, and through
// the `gh` CLI only (no other network access). It exists so that the rules
// every trust decision depends on are implemented once:
//
// - every user-, branch- or event-derived URL path segment is encoded
//   (`seg`, `api`), so a value such as `release/1.x`, `a?b` or `..` can never
//   change which endpoint is read;
// - `get` and `send` report the HTTP status even when `gh` exits non-zero,
//   so a caller can tell a 404 ("absent") from a 403 ("unreadable");
// - `list` and `listKey` read every page or throw: a failed page, a page of
//   the wrong shape or (for object endpoints) a collected count that differs
//   from `total_count` is a `CallError`, never a silently shorter list;
// - every `gh` process is bounded by a timeout and an output limit, and a
//   request body travels on stdin, never in argv.

import { execFileSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;
const STDERR_LIMIT = 500;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
// A path handed to gh: printable ASCII without spaces, not starting with "-"
// (which gh would read as a flag). Values are expected to be seg()-encoded.
const PATH = /^[!-~]+$/;
const PER_PAGE = /[?&]per_page=/i;
const STATUS_LINE = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d\d)(?: [^\r\n]*)?\r?\n/;

export class CallError extends Error {
  constructor(message) {
    super(message);
    this.name = "CallError";
  }
}

/**
 * @param {unknown} value "owner/name"
 * @returns {{owner: string, name: string, slug: string}}
 */
export function repoSlug(value) {
  if (typeof value !== "string") throw new TypeError("repository slug must be a string");
  const parts = value.split("/");
  if (parts.length !== 2) throw new TypeError(`not an owner/name slug: ${JSON.stringify(value)}`);
  const [owner, name] = parts;
  if (!OWNER.test(owner)) throw new TypeError(`invalid repository owner: ${JSON.stringify(owner)}`);
  if (!NAME.test(name) || name === "." || name === "..") {
    throw new TypeError(`invalid repository name: ${JSON.stringify(name)}`);
  }
  return { owner, name, slug: `${owner}/${name}` };
}

/**
 * One URL path segment, percent-encoded.
 * @param {unknown} value a non-empty string other than "." and "..", or a
 *   safe integer >= 1
 * @returns {string}
 */
export function seg(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`not a path segment: ${value}`);
    return String(value);
  }
  if (typeof value !== "string" || value === "" || value === "." || value === "..") {
    throw new TypeError(`not a path segment: ${JSON.stringify(value) ?? String(value)}`);
  }
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError("path segment is not well-formed UTF-16");
  }
}

/**
 * Tagged template for API paths: literal parts are trusted, every
 * interpolated value goes through seg().
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {string}
 */
export function api(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += seg(values[i]) + strings[i + 1];
  return out;
}

function checkPath(path) {
  if (typeof path !== "string" || !PATH.test(path) || path.startsWith("-")) {
    throw new TypeError(`not an API path: ${JSON.stringify(path) ?? String(path)}`);
  }
  return path;
}

function pagedPath(path) {
  checkPath(path);
  if (PER_PAGE.test(path)) throw new TypeError(`path already sets per_page: ${path}`);
  return `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
}

function stderrOf(error) {
  const text = error && error.stderr != null ? String(error.stderr).trim() : "";
  return text === "" ? "" : `: ${text.slice(0, STDERR_LIMIT)}`;
}

/**
 * Splits `gh api --include` output into status and body.
 * @returns {{status: number, body: string}}
 */
function splitIncluded(stdout, command) {
  const match = STATUS_LINE.exec(stdout);
  if (!match) throw new CallError(`${command}: no HTTP status line in the output`);
  let pos = match[0].length;
  for (;;) {
    const newline = stdout.indexOf("\n", pos);
    if (newline === -1) throw new CallError(`${command}: no blank line after the response headers`);
    const line = stdout.slice(pos, newline);
    pos = newline + 1;
    if (line === "" || line === "\r") break;
  }
  return { status: Number(match[1]), body: stdout.slice(pos) };
}

function parseJson(text, command, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CallError(`${command}: ${what} is not JSON`);
  }
}

/**
 * @param {{run?: (file: string, args: string[], options: object) => string, timeoutMs?: number}} [options]
 *   `run` has execFileSync's signature and is called with "gh"
 */
export function makeGh({ run = execFileSync, timeoutMs = 60000 } = {}) {
  if (typeof run !== "function") throw new TypeError("run must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");

  /**
   * Runs gh once. Returns the exit code and stdout of a process that ran to
   * an exit; throws CallError for anything else (timeout, output over the
   * limit, a kill by signal, a gh that could not be started).
   * @returns {{code: number, stdout: string, error: unknown}}
   */
  function exec(args, input) {
    const command = `gh ${args.join(" ")}`;
    const options = { timeout: timeoutMs, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" };
    if (input !== undefined) options.input = input;
    try {
      return { command, code: 0, stdout: String(run("gh", args, options)), error: null };
    } catch (error) {
      const code = error && error.code;
      if (code === "ETIMEDOUT") throw new CallError(`${command}: timed out after ${timeoutMs} ms`);
      if (code === "ENOBUFS") throw new CallError(`${command}: output exceeded ${MAX_BUFFER} bytes`);
      if (!error || typeof error.status !== "number") {
        const why = error && error.signal ? `killed by ${error.signal}` : `did not run (${error && error.message ? error.message : String(error)})`;
        throw new CallError(`${command}: ${why}`);
      }
      return { command, code: error.status, stdout: String(error.stdout ?? ""), error };
    }
  }

  function included(args, input) {
    const { command, code, stdout, error } = exec(args, input);
    const { status, body } = splitIncluded(stdout, command);
    const ok = status >= 200 && status < 300;
    if (ok && code !== 0) throw new CallError(`${command}: HTTP ${status} but gh exited ${code}${stderrOf(error)}`);
    if (body.trim() === "") return { status, json: null };
    if (ok) return { status, json: parseJson(body, command, `the HTTP ${status} body`) };
    try {
      return { status, json: JSON.parse(body) };
    } catch {
      return { status, json: null };
    }
  }

  function succeeded(args) {
    const { command, code, stdout, error } = exec(args);
    if (code !== 0) throw new CallError(`${command}: exited ${code}${stderrOf(error)}`);
    return { command, stdout };
  }

  function pages(path) {
    const { command, stdout } = succeeded(["api", "--paginate", "--slurp", path]);
    const all = parseJson(stdout, command, "the paginated output");
    if (!Array.isArray(all) || all.length === 0) throw new CallError(`${command}: expected a non-empty array of pages`);
    return { command, all };
  }

  return {
    get(path) {
      return included(["api", "--include", checkPath(path)]);
    },

    list(path) {
      const { command, all } = pages(pagedPath(path));
      const out = [];
      all.forEach((page, i) => {
        if (!Array.isArray(page)) throw new CallError(`${command}: page ${i + 1} is not an array`);
        out.push(...page);
      });
      return out;
    },

    listKey(path, key) {
      if (typeof key !== "string" || key === "") throw new TypeError("key must be a non-empty string");
      const { command, all } = pages(pagedPath(path));
      const out = [];
      all.forEach((page, i) => {
        if (page === null || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page[key])) {
          throw new CallError(`${command}: page ${i + 1} is not an object with a ${key} array`);
        }
        out.push(...page[key]);
      });
      const total = all[0].total_count;
      if (!Number.isSafeInteger(total) || total < 0) throw new CallError(`${command}: page 1 has no valid total_count`);
      if (out.length !== total) {
        throw new CallError(`${command}: listing truncated or inconsistent: collected ${out.length} of ${total} ${key}`);
      }
      return out;
    },

    send(method, path, body) {
      if (typeof method !== "string" || !METHODS.has(method)) throw new TypeError(`unsupported method: ${JSON.stringify(method)}`);
      checkPath(path);
      if (body === undefined) return included(["api", "--include", "--method", method, path]);
      return included(["api", "--include", "--method", method, "--input", "-", path], JSON.stringify(body));
    },

    cli(args) {
      if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) {
        throw new TypeError("cli args must be a non-empty array of strings");
      }
      return succeeded(args).stdout;
    },
  };
}
