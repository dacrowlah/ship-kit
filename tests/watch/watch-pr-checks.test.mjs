import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeFakeGh, json } from "./fake-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/watch/watch-pr-checks.sh", import.meta.url));

function run(args, queue) {
  const gh = makeFakeGh(queue);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });
  return { ...result, calls: existsSync(`${gh.dir}/calls.log`) ? gh.calls() : [] };
}

test("the script keeps its executable bit", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111);
});

test("all checks passing prints one summary line and exits 0", () => {
  const r = run(["7", "0", "2"], [json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pass" }])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:2\n");
  assert.deepEqual(r.calls[0], ["pr", "checks", "7", "--json", "name,bucket"]);
});

test("pending then a failure prints the summary and a FAILED line", () => {
  const r = run(["7", "0", "2"], [
    json([{ name: "ci", bucket: "pending" }], 8),
    json([{ name: "ci", bucket: "fail" }, { name: "lint", bucket: "pass" }], 1),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: fail:1 pass:1\nFAILED: ci\n");
  assert.equal(r.calls.length, 2);
});

test("a cancelled check is reported as FAILED; a skipped one is not", () => {
  const r = run(["7", "0", "2"], [json([
    { name: "gate", bucket: "cancel" },
    { name: "docs", bucket: "skipping" },
  ])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: cancel:1 skipping:1\nFAILED: gate\n");
});

test("no checks for more than max-empty polls raises the alarm and exits 1", () => {
  const r = run(["7", "0", "2"], [json([])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^PR7: no checks appeared after 3 polls/);
  assert.equal(r.calls.length, 3);
});

test("a gh error or unparseable output counts as no checks, never as success", () => {
  const r = run(["7", "0", "1"], [{ stdout: "", code: 1 }, { stdout: "not json", code: 0 }]);
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 2);
});

test("pending checks reset the empty count", () => {
  const r = run(["7", "0", "1"], [
    json([]),
    json([{ name: "ci", bucket: "pending" }], 8),
    json([]),
    json([{ name: "ci", bucket: "pass" }]),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 4);
});

for (const args of [[], ["abc"], ["7", "x"], ["7", "0", "-1"]]) {
  test(`usage error for arguments ${JSON.stringify(args)} exits 2 without calling gh`, () => {
    const r = run(args, [json([])]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
  });
}
