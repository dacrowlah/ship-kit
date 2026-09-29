// Builds a directory holding a fake `gh` for the watcher tests. Each call
// prints the next queued response (stdout text and exit code) and appends
// its arguments to calls.log; once the queue is exhausted it repeats the
// last response.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
const queue = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8"));
const countFile = path.join(dir, "count");
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(count + 1));
const response = queue[Math.min(count, queue.length - 1)];
process.stdout.write(response.stdout);
process.exit(response.code);
`;

/** @param {{stdout: string, code: number}[]} queue */
export function makeFakeGh(queue) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "queue.json"), JSON.stringify(queue));
  return {
    dir,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export const json = (value, code = 0) => ({ stdout: JSON.stringify(value), code });

// A fake `gh` that dispatches on the leading words of each call, for a
// script that shells out to more than one `gh` subcommand (for example
// `gh pr view`, `gh repo view` and `gh api ...` before its main polling
// loop). Each route is `{ match: string[], queue: {stdout, code}[] }`;
// the first route whose `match` is a prefix of the call's arguments is
// used, and (as with makeFakeGh) each route's own queue repeats its last
// entry once exhausted. A call matching no route exits 1 with a message
// on stdout, which is deliberately noisy (so a missing route shows up as
// a visible test failure rather than a silently wrong response).
const FAKE_GH_ROUTER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
const routes = JSON.parse(fs.readFileSync(path.join(dir, "routes.json"), "utf8"));
const routeIndex = routes.findIndex((r) => r.match.every((word, i) => args[i] === word));
if (routeIndex === -1) {
  process.stdout.write("fake-gh: no route matched " + JSON.stringify(args));
  process.exit(1);
}
const countFile = path.join(dir, "count-" + routeIndex);
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(count + 1));
const queue = routes[routeIndex].queue;
const response = queue[Math.min(count, queue.length - 1)];
process.stdout.write(response.stdout);
process.exit(response.code);
`;

/** @param {{match: string[], queue: {stdout: string, code: number}[]}[]} routes */
export function makeRoutedFakeGh(routes) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-router-"));
  writeFileSync(join(dir, "gh"), FAKE_GH_ROUTER);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  return {
    dir,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// A plain-text response (not JSON), for `gh pr view`/`gh repo view -q
// .field` (which print the field's raw value) and `gh api ... --jq`
// (which prints one matched value per line).
export const text = (value, code = 0) => ({ stdout: value, code });
