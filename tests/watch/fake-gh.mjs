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
