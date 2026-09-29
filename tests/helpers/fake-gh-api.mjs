// Builds a directory holding a scripted fake `gh` for tests of code that
// calls the GitHub API through `gh`. Responses are keyed by the exact
// argument list: each route is `{ args: string[], stdout?, stderr?, code?,
// sleepMs? }`. A call whose argument list matches no route writes a message
// to stderr and exits 1, so a missing route is a visible failure. Every call
// appends `{argv, stdin}` to calls.log before answering; `sleepMs` delays
// the answer, for timeout tests.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; }
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv, stdin }) + "\\n");
const routes = JSON.parse(fs.readFileSync(path.join(dir, "routes.json"), "utf8"));
const key = JSON.stringify(argv);
const route = routes.find((r) => JSON.stringify(r.args) === key);
if (!route) {
  process.stderr.write("fake-gh-api: no route for " + key + "\\n");
  process.exit(1);
}
setTimeout(() => {
  process.stdout.write(route.stdout || "");
  process.stderr.write(route.stderr || "");
  process.exitCode = route.code || 0;
}, route.sleepMs || 0);
`;

/**
 * @param {{args: string[], stdout?: string, stderr?: string, code?: number, sleepMs?: number}[]} routes
 * @returns {{dir: string, bin: string, calls: () => {argv: string[], stdin: string}[]}}
 */
export function makeFakeGhApi(routes) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-api-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  const log = join(dir, "calls.log");
  return {
    dir,
    bin,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  };
}

/**
 * The stdout of `gh api --include` for one response: a status line ending
 * LF, headers ending CRLF, a blank CRLF line, then the body (as gh 2.x
 * prints it).
 * @param {number} status
 * @param {unknown} body a value to JSON-encode, or a string written as is
 * @param {string} [reason]
 */
export function included(status, body, reason = "Reason") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `HTTP/2.0 ${status} ${reason}\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: 0000:0000\r\n\r\n${text}`;
}
