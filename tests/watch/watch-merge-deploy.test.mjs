import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeFakeGh, json } from "./fake-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/watch/watch-merge-deploy.sh", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

function run(args, queue, extraEnv = {}) {
  const gh = makeFakeGh(queue);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}`, ...extraEnv },
  });
  return { ...result, calls: existsSync(`${gh.dir}/calls.log`) ? gh.calls() : [] };
}

test("the script keeps its executable bit", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111);
});

for (const bad of ["", "0123456", SHA.toUpperCase(), `${SHA}0`, `${SHA.slice(0, 39)}g`]) {
  test(`sha ${JSON.stringify(bad)} exits 2 without calling gh`, () => {
    const r = run([bad, "0", "1"], [json([])]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /full 40-character/);
  });
}

test("completed runs print one summary line and FAILED lines for non-success", () => {
  const r = run([SHA, "0", "1"], [
    json([{ name: "CI", status: "in_progress", conclusion: null }]),
    json([
      { name: "CI", status: "completed", conclusion: "success" },
      { name: "Deploy", status: "completed", conclusion: "failure" },
      { name: "Docs", status: "completed", conclusion: "skipped" },
      { name: "Odd", status: "completed", conclusion: null },
    ]),
  ]);
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    `runs for ${SHA} concluded: CI:success Deploy:failure Docs:skipped Odd:?\n` +
      "FAILED: Deploy (failure)\nFAILED: Odd (?)\n",
  );
  assert.deepEqual(r.calls[0], ["run", "list", "--commit", SHA, "--limit", "100", "--json", "name,status,conclusion"]);
});

test("no runs for more than max-empty polls raises the alarm and exits 1", () => {
  const r = run([SHA, "0", "1"], [json([])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no workflow runs found for/);
  assert.equal(r.calls.length, 2);
});

test("a bad poll argument exits 2", () => {
  assert.equal(run([SHA, "x"], [json([])]).status, 2);
});

test("21 runs with one failure beyond the old default-20 page are never reported as green", () => {
  const runs = Array.from({ length: 21 }, (_, i) => ({
    name: `job-${i}`,
    status: "completed",
    conclusion: i === 20 ? "failure" : "success",
  }));
  const r = run([SHA, "0", "1"], [json(runs)]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FAILED: job-20 \(failure\)/);
  assert.deepEqual(r.calls[0], ["run", "list", "--commit", SHA, "--limit", "100", "--json", "name,status,conclusion"]);
});

test("a run count exactly at the limit is reported FAILED, never green", () => {
  const runs = Array.from({ length: 3 }, (_, i) => ({
    name: `job-${i}`,
    status: "completed",
    conclusion: "success",
  }));
  const r = run([SHA, "0", "1"], [json(runs)], { WATCH_RUN_LIMIT: "3" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FAILED: too many runs to verify \(limit 3\); narrow or check manually/);
});
