import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CallError, DEFAULT_LIMIT, collect, main, parseArgs } from "../../scripts/mining/collect.mjs";
import { encodeStateMarker } from "../../scripts/lib/state-marker.mjs";

const state = (mode, runId) => ({
  v: 1, kind: "adversarial", head: "1".repeat(40), mode, complete: true,
  mergeBase: "2".repeat(40), findings: [], runId,
});

// A fake GitHub: PR 1 is a design-doc PR with a marker comment (edited) and
// a review whose body is a marker; PR 2 has only ordinary comments.
function fakeGh({ prs = [{ number: 1, title: "Design", body: "" }, { number: 2, title: "Code", body: "" }], failOn } = {}) {
  const calls = [];
  const pages = {
    "repos/{owner}/{repo}/issues/1/comments": [[
      { id: 11, body: `${encodeStateMarker(state("design-doc", 5))}\nsummary`, created_at: "t1", updated_at: "t2" },
    ], [{ id: 12, body: "plain comment", created_at: "t1", updated_at: "t1" }]],
    "repos/{owner}/{repo}/pulls/1/comments": [[]],
    "repos/{owner}/{repo}/pulls/1/reviews": [[{ id: 13, body: encodeStateMarker(state("full", 6)), submitted_at: "t3" }]],
    "repos/{owner}/{repo}/issues/2/comments": [[{ id: 21, body: "looks good", created_at: "t", updated_at: "t" }]],
    "repos/{owner}/{repo}/pulls/2/comments": [[{ id: 22, body: `line 2\n${encodeStateMarker(state("full", 7))}` }]],
    "repos/{owner}/{repo}/pulls/2/reviews": [[]],
  };
  const gh = (args) => {
    calls.push(args);
    if (failOn && calls.length === failOn) throw new CallError("gh api failed: HTTP 403: API rate limit exceeded");
    if (args[0] === "pr") return JSON.stringify(prs);
    return JSON.stringify(pages[args[3]]);
  };
  return { gh, calls };
}

const deps = (gh) => ({
  gh,
  git: (args) => (args.includes("--") ? "aaa\t2026-01-01\tAdd shape R1\n" : "bbb\t2026-02-01\tFix a thing\n"),
  readFile: () => "# Code shapes\n",
});

const OPTS = { target: "code", since: "2026-01-01", list: ".ship-kit/hunt-lists/code.md", limit: DEFAULT_LIMIT };

test("code target keeps every PR and decodes first-line markers only, all unverified", () => {
  const { gh, calls } = fakeGh();
  const { files } = collect(OPTS, deps(gh));
  assert.deepEqual(JSON.parse(files["prs.json"]).map((p) => p.number), [1, 2]);
  const markers = JSON.parse(files["markers.json"]);
  assert.deepEqual(markers.map((m) => [m.pr, m.id, m.source, m.trust]), [
    [1, 11, "issue-comment", "unverified"],
    [1, 13, "review", "unverified"],
  ]);
  assert.equal(markers[0].edited, true);
  assert.equal(JSON.parse(files["prs.json"])[0].issueComments.length, 2, "pages are flattened");
  assert.deepEqual(calls[0], [
    "pr", "list", "--state", "merged", "--search", "merged:>=2026-01-01",
    "--limit", "1000", "--json", "number,title,body,mergedAt,mergeCommit,headRefName",
  ]);
  assert.ok(calls.slice(1).every((c) => c[0] === "api" && c[1] === "--paginate" && c[2] === "--slurp"));
  assert.equal(files["list.md"], "# Code shapes\n");
  assert.match(files["reconciliation.txt"], /PRs listed: 2\nPRs with at least one aggregate comment: 1\n/);
});

test("design target keeps only PRs with a design-doc marker", () => {
  const { files } = collect({ ...OPTS, target: "design" }, deps(fakeGh().gh));
  assert.deepEqual(JSON.parse(files["prs.json"]).map((p) => p.number), [1]);
});

test("a PR count equal to --limit prints the truncation warning; one less does not", () => {
  assert.match(collect({ ...OPTS, limit: 2 }, deps(fakeGh().gh)).reconciliation, /WARNING: the PR count equals --limit \(2\)/);
  assert.doesNotMatch(collect({ ...OPTS, limit: 3 }, deps(fakeGh().gh)).reconciliation, /WARNING/);
});

test("a failed call mid-collection stops with a CallError", () => {
  assert.throws(() => collect(OPTS, deps(fakeGh({ failOn: 4 }).gh)), CallError);
});

test("a non-array page response is a CallError, not an empty result", () => {
  const gh = (args) => (args[0] === "pr" ? JSON.stringify([{ number: 1 }]) : JSON.stringify({ message: "Not Found" }));
  assert.throws(() => collect(OPTS, deps(gh)), /expected an array of pages/);
});

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "collect-"));
  const list = join(root, "code.md");
  writeFileSync(list, "# Code shapes\n");
  return { root, list, out: join(root, "evidence") };
}

const sink = () => {
  let text = "";
  return { write: (s) => (text += s), text: () => text };
};

test("main writes every evidence file and exits 0", () => {
  const { list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  const code = main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh().gh), io);
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(out).sort(), [
    "commits.tsv", "list-history.tsv", "list.md", "markers.json", "prs.json", "reconciliation.txt",
  ]);
  assert.match(io.out.text(), /evidence: /);
});

test("main exits 1 and writes nothing when a call fails", () => {
  const { list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  const code = main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh({ failOn: 3 }).gh), io);
  assert.equal(code, 1);
  assert.equal(existsSync(out), false);
  assert.match(io.err.text(), /rate limit/);
});

test("main exits 2 on a missing list file or a non-empty --out", () => {
  const { root, list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  assert.equal(main(["--target", "code", "--since", "2026-01-01", "--list", join(root, "nope.md"), "--out", out], deps(fakeGh().gh), io), 2);
  mkdirSync(out);
  writeFileSync(join(out, "old"), "x");
  assert.equal(main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh().gh), io), 2);
});

for (const [name, argv] of [
  ["no --list", ["--target", "code", "--since", "2026-01-01", "--out", "o"]],
  ["no --out", ["--target", "code", "--since", "2026-01-01", "--list", "l"]],
  ["bad target", ["--target", "docs", "--since", "2026-01-01", "--list", "l", "--out", "o"]],
  ["bad date", ["--target", "code", "--since", "Jan 1", "--list", "l", "--out", "o"]],
  ["bad limit", ["--target", "code", "--since", "2026-01-01", "--list", "l", "--out", "o", "--limit", "0"]],
  ["unknown flag", ["--target", "code", "--since", "2026-01-01", "--list", "l", "--out", "o", "--repo", "x"]],
  ["dangling flag", ["--target"]],
]) {
  test(`parseArgs refuses ${name}`, () => {
    assert.throws(() => parseArgs(argv), /usage|must be|required/);
  });
}
