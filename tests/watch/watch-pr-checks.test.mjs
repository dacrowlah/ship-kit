import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeRoutedFakeGh, json, text } from "./fake-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/watch/watch-pr-checks.sh", import.meta.url));

// Before its polling loop, the script derives the base branch's required
// check names: `gh pr view` for the base branch, `gh repo view` for
// owner/repo, then two `gh api` lookups. Every test routes those four
// calls (defaulting to "no required checks derived", i.e. empty rules and
// empty classic protection) so the polling behavior under test is
// unaffected unless a test overrides one of them.
//
// WATCH_SETTLE_SECONDS defaults to 0 so tests that exercise the
// settle-and-reconfirm loop do not actually sleep.
function run(args, checksQueue, opts = {}) {
  const {
    baseName = "main",
    repoName = "dacrowlah/ship-kit",
    baseResponse = text(baseName),
    repoResponse = text(repoName),
    rulesResponse = text(""),
    protectionResponse = text(""),
    extraEnv = {},
  } = opts;
  // The script percent-encodes the base branch name (jq's `@uri`) before
  // using it in either API path, since it is a middle path segment in the
  // protection URL; encodeURIComponent matches `@uri` for the characters
  // that matter here (in particular "/" -> "%2F"). "main" round-trips
  // unchanged, so this is a no-op for every test that does not override
  // baseName.
  const encodedBaseName = encodeURIComponent(baseName);
  const gh = makeRoutedFakeGh([
    { match: ["pr", "view"], queue: [baseResponse] },
    { match: ["repo", "view"], queue: [repoResponse] },
    { match: ["api", `repos/${repoName}/rules/branches/${encodedBaseName}`], queue: [rulesResponse] },
    { match: ["api", `repos/${repoName}/branches/${encodedBaseName}/protection/required_status_checks`], queue: [protectionResponse] },
    { match: ["pr", "checks"], queue: checksQueue },
  ]);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}`, WATCH_SETTLE_SECONDS: "0", ...extraEnv },
  });
  const calls = existsSync(`${gh.dir}/calls.log`) ? gh.calls() : [];
  return { ...result, calls, pollCalls: calls.filter((c) => c[0] === "pr" && c[1] === "checks") };
}

test("the script keeps its executable bit", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111);
});

test("all checks passing prints one summary line and exits 0", () => {
  const r = run(["7", "0", "2"], [json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pass" }])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:2\n");
  assert.deepEqual(r.pollCalls[0], ["pr", "checks", "7", "--json", "name,bucket"]);
});

test("pending then a failure prints the summary and a FAILED line", () => {
  const r = run(["7", "0", "2"], [
    json([{ name: "ci", bucket: "pending" }], 8),
    json([{ name: "ci", bucket: "fail" }, { name: "lint", bucket: "pass" }], 1),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: fail:1 pass:1\nFAILED: ci\n");
  // 1 pending poll, 1 poll that first sees the conclusion, 1 settle
  // reconfirm poll that sees the same names again before it concludes.
  assert.equal(r.pollCalls.length, 3);
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
  assert.equal(r.pollCalls.length, 3);
});

test("a gh error or unparseable output counts as no checks, never as success", () => {
  const r = run(["7", "0", "1"], [{ stdout: "", code: 1 }, { stdout: "not json", code: 0 }]);
  assert.equal(r.status, 1);
  assert.equal(r.pollCalls.length, 2);
});

test("pending checks reset the empty count", () => {
  const r = run(["7", "0", "1"], [
    json([]),
    json([{ name: "ci", bucket: "pending" }], 8),
    json([]),
    json([{ name: "ci", bucket: "pass" }]),
  ]);
  assert.equal(r.status, 0);
  // empty, pending (resets), empty, pass (first stable), settle reconfirm
  // (queue exhausted, repeats the pass response) -> concludes.
  assert.equal(r.pollCalls.length, 5);
});

test("a non-required check that registers after the first settle poll is waited for and included", () => {
  const r = run(["7", "0", "3"], [
    json([{ name: "ci", bucket: "pass" }]),
    json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pending" }]),
    json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pass" }]),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:2\n");
  assert.equal(r.pollCalls.length, 4);
});

test("an explicitly required check that never appears is reported FAILED at the alarm timeout", () => {
  const r = run(["7", "0", "1", "--require", "ci"], [json([{ name: "lint", bucket: "pass" }])]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "PR7 checks concluded: pass:1\nFAILED: ci (never appeared)\n");
  assert.equal(r.pollCalls.length, 2);
});

test("an explicitly required check that does appear concludes green like any other", () => {
  const r = run(["7", "0", "1", "--require", "ci"], [json([{ name: "ci", bucket: "pass" }])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:1\n");
});

test("a required check that appears but stays pending is FAILED at the timeout, not waited for forever", () => {
  const r = run(["7", "0", "1", "--require", "ci"], [json([{ name: "ci", bucket: "pending" }], 8)]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "PR7 checks concluded: pending:1\nFAILED: ci (still pending)\n");
  assert.equal(r.pollCalls.length, 2);
});

for (const args of [[], ["abc"], ["7", "x"], ["7", "0", "-1"]]) {
  test(`usage error for arguments ${JSON.stringify(args)} exits 2 without calling gh`, () => {
    const r = run(args, [json([])]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
  });
}

test("a bad --require without a value exits 2 without calling gh", () => {
  const r = run(["7", "0", "1", "--require"], [json([])]);
  assert.equal(r.status, 2);
  assert.equal(r.calls.length, 0);
});

// --- Deriving the required set from the base branch's protection rules ---

test("a check required by the base branch's repository rules is waited for across several polls, even though it registers after ci has already settled", () => {
  const r = run(["7", "0", "5"], [
    json([{ name: "ci", bucket: "pass" }]), // poll 1: lint (required) missing
    json([{ name: "ci", bucket: "pass" }]), // poll 2: lint still missing
    json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pass" }]), // poll 3: lint appears
  ], {
    rulesResponse: text("ci\nlint\n"),
    // Classic protection responds 404 ("Branch not protected"), exactly
    // as dacrowlah/ship-kit's own `main` does (it uses rulesets, not
    // classic protection): contributes nothing, and is not an error.
    protectionResponse: text("gh: Branch not protected (HTTP 404)", 1),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:2\n");
  // poll1, poll2: lint missing (status 5, counted toward tries). poll3:
  // both present, stable -> settle. poll4 (queue exhausted, repeats
  // poll3's response): same names -> concludes.
  assert.equal(r.pollCalls.length, 4);
});

test("required names from repository rules and classic protection are unioned and deduped", () => {
  const r = run(["7", "0", "1"], [json([{ name: "other", bucket: "pass" }])], {
    rulesResponse: text("ci\nci\n"),
    protectionResponse: text("ci\n"),
  });
  assert.equal(r.status, 1);
  // Exactly one FAILED line for "ci", not one per source or per
  // duplicate line.
  assert.equal(r.stdout, "PR7 checks concluded: pass:1\nFAILED: ci (never appeared)\n");
  assert.equal(r.pollCalls.length, 2);
});

test("a lookup failure with no explicit --require exits nonzero with a warning and polls nothing", () => {
  const r = run(["7", "0", "1"], [json([{ name: "ci", bucket: "pass" }])], {
    rulesResponse: text("gh: Bad credentials (HTTP 401)", 1),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WARNING: could not read required checks for main; pass --require/);
  assert.equal(r.pollCalls.length, 0);
});

test("a lookup failure with an explicit --require proceeds using only the explicit names", () => {
  const r = run(["7", "0", "1", "--require", "ci"], [json([{ name: "ci", bucket: "pass" }])], {
    rulesResponse: text("gh: Bad credentials (HTTP 401)", 1),
  });
  assert.match(r.stderr, /WARNING: could not read required checks for main; pass --require/);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:1\n");
});

test("a base branch name containing a slash is percent-encoded in both API paths", () => {
  const r = run(["7", "0", "1"], [json([{ name: "ci", bucket: "pass" }])], {
    baseName: "release/1.0",
    rulesResponse: text("ci\n"),
    protectionResponse: text("gh: Branch not protected (HTTP 404)", 1),
  });
  assert.equal(r.status, 0);
  const apiCalls = r.calls.filter((c) => c[0] === "api");
  assert.deepEqual(apiCalls[0], [
    "api",
    "repos/dacrowlah/ship-kit/rules/branches/release%2F1.0",
    "--jq",
    '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context',
  ]);
  assert.deepEqual(apiCalls[1], [
    "api",
    "repos/dacrowlah/ship-kit/branches/release%2F1.0/protection/required_status_checks",
    "--jq",
    ".contexts[]?",
  ]);
});
