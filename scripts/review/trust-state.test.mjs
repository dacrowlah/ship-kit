import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeGh } from "../lib/gh.mjs";
import { encodeStateMarker } from "../lib/state-marker.mjs";
import {
  MAX_STATE_BYTES, STATE_ARTIFACT, STATE_AUTHOR, STATE_FILE,
  callerPathMatches, collectTrustedStates, makeDownload, makeTrustState,
} from "./trust-state.mjs";

const REPO = "Owner/Repo";
const DEFAULT = "main";
const HEAD = "a".repeat(40);
const CREATED = "2026-01-01T00:00:00Z";

function marker(overrides = {}) {
  return encodeStateMarker({
    v: 1, kind: "general", head: HEAD, mode: "design-doc", complete: true,
    mergeBase: null, findings: [], runId: 500, ...overrides,
  });
}

function comment(id, line, overrides = {}) {
  return {
    id,
    body: `${line}\n\nReview summary text.`,
    created_at: CREATED,
    updated_at: CREATED,
    user: { login: STATE_AUTHOR, type: "Bot" },
    ...overrides,
  };
}

function run(runId, kind = "general", overrides = {}) {
  return {
    id: runId,
    event: "pull_request_target",
    path: `.github/workflows/ship-kit-${kind}.yml`,
    repository: { full_name: "owner/repo" },
    ...overrides,
  };
}

/**
 * A fake world: `runs` maps run id to a run object (or a {status, json}
 * response), `artifacts` maps run id to its artifact list (or an Error to
 * throw), `files` maps "runId/name" to state.json text (or an Error).
 */
function world({ runs = {}, artifacts = {}, files = {} } = {}) {
  const calls = { get: [], listKey: [], download: [] };
  const gh = {
    get(path) {
      calls.get.push(path);
      const id = Number(path.split("/").pop());
      const entry = runs[id];
      if (entry instanceof Error) throw entry;
      if (entry === undefined) return { status: 404, json: { message: "Not Found" } };
      if ("status" in entry && "json" in entry) return entry;
      return { status: 200, json: entry };
    },
    listKey(path, key) {
      calls.listKey.push([path, key]);
      const id = Number(path.split("/")[5]);
      const entry = artifacts[id];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
  };
  const download = (runId, name) => {
    calls.download.push([runId, name]);
    const entry = files[`${runId}/${name}`];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) throw new Error(`no artifact ${name}`);
    return entry;
  };
  return { gh, download, calls };
}

function artifact(name, expired = false) {
  return { id: 1, name, expired };
}

function payload(commentId, line) {
  return JSON.stringify({ commentId, marker: line });
}

/** A consistent world where comment `id` carries a genuine state of `kind` from run `runId`. */
function genuine(id, runId, kind = "general", extra = {}) {
  const line = marker({ runId, kind, ...extra });
  return {
    comment: comment(id, line),
    line,
    run: run(runId, kind),
    artifacts: [artifact("ship-kit-state-1")],
    files: { [`${runId}/ship-kit-state-1`]: payload(id, line) },
  };
}

function trustWith(w) {
  return makeTrustState({ gh: w.gh, repo: REPO, defaultBranch: DEFAULT, download: w.download });
}

function single(g, mutate = {}) {
  const w = world({
    runs: { [g.run.id]: mutate.run ?? g.run },
    artifacts: { [g.run.id]: mutate.artifacts ?? g.artifacts },
    files: mutate.files ?? g.files,
  });
  return { w, trust: trustWith(w) };
}

// constants and callerPathMatches -------------------------------------

test("constants", () => {
  assert.equal(STATE_AUTHOR, "github-actions[bot]");
  assert.equal(STATE_FILE, "state.json");
  assert.equal(MAX_STATE_BYTES, 256 * 1024);
  for (const ok of ["ship-kit-state-1", "ship-kit-state-2", "ship-kit-state-999"]) assert.ok(STATE_ARTIFACT.test(ok), ok);
  for (const bad of ["ship-kit-state", "ship-kit-state-0", "ship-kit-state-01", "ship-kit-state-1000", "ship-kit-state-1x", "xship-kit-state-1", "ship-kit-plan-1"]) {
    assert.ok(!STATE_ARTIFACT.test(bad), bad);
  }
});

test("callerPathMatches accepts the managed caller path, bare or at the default branch", () => {
  assert.ok(callerPathMatches(".github/workflows/ship-kit-general.yml", "general", "main"));
  assert.ok(callerPathMatches(".github/workflows/ship-kit-general.yml@refs/heads/main", "general", "main"));
  assert.ok(callerPathMatches(".github/workflows/ship-kit-general.yml@refs/heads/release/1.x", "general", "release/1.x"));
});

test("callerPathMatches refuses every other path, ref or kind", () => {
  const refuse = [
    [".github/workflows/evil.yml", "general", "main"],
    [".github/workflows/ship-kit-general.yml@refs/heads/feature", "general", "main"],
    [".github/workflows/ship-kit-general.yml@refs/heads/main2", "general", "main"],
    [".github/workflows/ship-kit-general.yml@refs/tags/main", "general", "main"],
    [".github/workflows/ship-kit-general.yml@main", "general", "main"],
    [".github/workflows/ship-kit-general.yml@", "general", "main"],
    [".github/workflows/ship-kit-general.yml ", "general", "main"],
    [".github/workflows/ship-kit-adversarial.yml", "general", "main"],
    ["x/.github/workflows/ship-kit-general.yml", "general", "main"],
    [".github/workflows/ship-kit-general.yaml", "general", "main"],
    [undefined, "general", "main"],
    [".github/workflows/ship-kit-general.yml", "", "main"],
    [".github/workflows/ship-kit-general.yml@refs/heads/", "general", ""],
    [".github/workflows/ship-kit-general.yml", "general", undefined],
    [".github/workflows/ship-kit-undefined.yml", undefined, "main"],
  ];
  for (const args of refuse) assert.equal(callerPathMatches(...args), false, JSON.stringify(args));
});

// makeTrustState: construction ----------------------------------------

test("makeTrustState refuses a bad repo, default branch, gh or download", () => {
  const w = world();
  const base = { gh: w.gh, repo: REPO, defaultBranch: DEFAULT, download: w.download };
  assert.throws(() => makeTrustState({ ...base, repo: "no-slash" }), TypeError);
  assert.throws(() => makeTrustState({ ...base, defaultBranch: "" }), TypeError);
  assert.throws(() => makeTrustState({ ...base, defaultBranch: 7 }), TypeError);
  assert.throws(() => makeTrustState({ ...base, gh: {} }), TypeError);
  assert.throws(() => makeTrustState({ ...base, gh: null }), TypeError);
  assert.throws(() => makeTrustState({ ...base, download: null }), TypeError);
});

// makeTrustState: the trust rule ---------------------------------------

test("a genuine state is trusted and its run and artifacts are read at encoded paths", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g);
  const result = trust(g.comment);
  assert.equal(result.trusted, true, result.reason);
  assert.equal(result.state.runId, 500);
  assert.equal(result.state.kind, "general");
  assert.deepEqual(w.calls.get, ["repos/Owner/Repo/actions/runs/500"]);
  assert.deepEqual(w.calls.listKey, [["repos/Owner/Repo/actions/runs/500/artifacts", "artifacts"]]);
  assert.deepEqual(w.calls.download, [[500, "ship-kit-state-1"]]);
});

test("a body with CRLF line endings compares its first line without the CR", () => {
  const g = genuine(101, 500);
  g.comment.body = `${g.line}\r\n\r\nsummary`;
  assert.equal(single(g).trust(g.comment).trusted, true);
});

test("a comment whose first line is no marker is untrusted before any API call", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g);
  for (const body of ["plain text", `summary\n${g.line}`, undefined, 42]) {
    const result = trust({ ...g.comment, body });
    assert.equal(result.trusted, false);
    assert.match(result.reason, /marker/);
  }
  assert.equal(w.calls.get.length, 0);
});

test("a forged marker from a bot comment with no matching run (404) is untrusted", () => {
  const g = genuine(101, 500);
  const w = world({ runs: {}, artifacts: { 500: g.artifacts }, files: g.files });
  const result = trustWith(w)(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /HTTP 404/);
  assert.equal(w.calls.listKey.length, 0);
});

test("an API 500 on the run lookup is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: { status: 500, json: null } }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /HTTP 500/);
});

test("a 2xx other than 200, or a 200 with a non-object body, is untrusted", () => {
  const g = genuine(101, 500);
  assert.equal(single(g, { run: { status: 204, json: null } }).trust(g.comment).trusted, false);
  assert.equal(single(g, { run: { status: 203, json: run(500) } }).trust(g.comment).trusted, false);
  assert.equal(single(g, { run: { status: 200, json: null } }).trust(g.comment).trusted, false);
  assert.equal(single(g, { run: { status: 200, json: [run(500)] } }).trust(g.comment).trusted, false);
});

test("a run lookup that throws is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: new Error("gh api: timed out after 60000 ms") }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /timed out/);
});

test("a run whose id differs from the marker's runId is untrusted", () => {
  const g = genuine(101, 500);
  assert.equal(single(g, { run: run(501) }).trust(g.comment).trusted, false);
});

test("an edited comment is untrusted", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g);
  const result = trust({ ...g.comment, updated_at: "2026-01-01T00:05:00Z" });
  assert.equal(result.trusted, false);
  assert.match(result.reason, /edited/);
  assert.equal(w.calls.get.length, 0);
});

test("a comment with missing timestamps is untrusted", () => {
  const g = genuine(101, 500);
  const { created_at, updated_at, ...rest } = g.comment;
  assert.equal(single(g).trust(rest).trusted, false);
});

test("a non-bot author is untrusted", () => {
  const g = genuine(101, 500);
  const { trust, w } = single(g);
  const result = trust({ ...g.comment, user: { login: "mallory", type: "User" } });
  assert.equal(result.trusted, false);
  assert.match(result.reason, /author/);
  assert.equal(w.calls.get.length, 0);
});

test("the bot's login with user type User is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g).trust({ ...g.comment, user: { login: STATE_AUTHOR, type: "User" } });
  assert.equal(result.trusted, false);
  assert.match(result.reason, /author/);
});

test("another bot, or no user at all, is untrusted", () => {
  const g = genuine(101, 500);
  const { trust } = single(g);
  assert.equal(trust({ ...g.comment, user: { login: "evil[bot]", type: "Bot" } }).trusted, false);
  assert.equal(trust({ ...g.comment, user: null }).trusted, false);
  assert.equal(trust({ ...g.comment, user: undefined }).trusted, false);
});

test("a comment with an invalid id is untrusted", () => {
  const g = genuine(101, 500);
  const { trust } = single(g);
  for (const id of [0, -1, 1.5, "101", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(trust({ ...g.comment, id }).trusted, false, String(id));
  }
});

test("a non-object comment is untrusted", () => {
  const g = genuine(101, 500);
  const { trust } = single(g);
  for (const c of [null, undefined, "x", [g.comment]]) assert.equal(trust(c).trusted, false);
});

test("event pull_request is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: run(500, "general", { event: "pull_request" }) }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /event/);
});

test("path .github/workflows/evil.yml is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: run(500, "general", { path: ".github/workflows/evil.yml" }) }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /path/);
});

test("path with @refs/heads/feature is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, {
    run: run(500, "general", { path: ".github/workflows/ship-kit-general.yml@refs/heads/feature" }),
  }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /path/);
});

test("path with @refs/heads/<default> is trusted", () => {
  const g = genuine(101, 500);
  const result = single(g, {
    run: run(500, "general", { path: ".github/workflows/ship-kit-general.yml@refs/heads/main" }),
  }).trust(g.comment);
  assert.equal(result.trusted, true, result.reason);
});

test("a run of the other kind's caller is untrusted", () => {
  const g = genuine(101, 500, "general");
  assert.equal(single(g, { run: run(500, "adversarial") }).trust(g.comment).trusted, false);
});

test("a run from another repository is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: run(500, "general", { repository: { full_name: "other/repo" } }) }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /repository/);
});

test("a run with no repository is untrusted", () => {
  const g = genuine(101, 500);
  assert.equal(single(g, { run: run(500, "general", { repository: null }) }).trust(g.comment).trusted, false);
  assert.equal(single(g, { run: run(500, "general", { repository: { full_name: 5 } }) }).trust(g.comment).trusted, false);
});

test("the repository comparison ignores case", () => {
  const g = genuine(101, 500);
  const result = single(g, { run: run(500, "general", { repository: { full_name: "OWNER/REPO" } }) }).trust(g.comment);
  assert.equal(result.trusted, true, result.reason);
});

test("no artifact is untrusted", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g, { artifacts: [] });
  const result = trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /artifact/);
  assert.equal(w.calls.download.length, 0);
});

test("an expired artifact is untrusted and never downloaded", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g, { artifacts: [artifact("ship-kit-state-1", true)] });
  const result = trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /artifact/);
  assert.equal(w.calls.download.length, 0);
});

test("an artifact without an explicit expired: false is treated as expired", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g, { artifacts: [{ id: 1, name: "ship-kit-state-1" }] });
  assert.equal(trust(g.comment).trusted, false);
  assert.equal(w.calls.download.length, 0);
});

test("only artifacts named like a state artifact are downloaded", () => {
  const g = genuine(101, 500);
  const files = { "500/ship-kit-state": payload(101, g.line), "500/state": payload(101, g.line) };
  const { w, trust } = single(g, {
    artifacts: [artifact("ship-kit-state"), artifact("state"), null, { name: 7, expired: false }],
    files,
  });
  assert.equal(trust(g.comment).trusted, false);
  assert.equal(w.calls.download.length, 0);
});

test("the artifact listing throwing (for example a truncated listing) is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { artifacts: new Error("listing truncated or inconsistent") }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /truncated/);
});

test("artifact ship-kit-state-2 (attempt 2) matching is trusted", () => {
  const g = genuine(101, 500);
  const result = single(g, {
    artifacts: [artifact("ship-kit-state-2")],
    files: { "500/ship-kit-state-2": payload(101, g.line) },
  }).trust(g.comment);
  assert.equal(result.trusted, true, result.reason);
});

test("two artifacts where only one matches is trusted", () => {
  const g = genuine(102, 500);
  const earlier = marker({ runId: 500, head: "b".repeat(40) });
  const result = single(g, {
    artifacts: [artifact("ship-kit-state-1"), artifact("ship-kit-state-2")],
    files: {
      "500/ship-kit-state-1": payload(101, earlier),
      "500/ship-kit-state-2": payload(102, g.line),
    },
  }).trust(g.comment);
  assert.equal(result.trusted, true, result.reason);
});

test("two artifacts where neither matches is untrusted", () => {
  const g = genuine(102, 500);
  const result = single(g, {
    artifacts: [artifact("ship-kit-state-1"), artifact("ship-kit-state-2")],
    files: {
      "500/ship-kit-state-1": payload(101, g.line),
      "500/ship-kit-state-2": payload(103, g.line),
    },
  }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /match/);
});

test("a real run id with a different payload in the artifact is untrusted", () => {
  const g = genuine(101, 500);
  const other = marker({ runId: 500, complete: false });
  const result = single(g, { files: { "500/ship-kit-state-1": payload(101, other) } }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /match/);
});

test("a different payload built with a trailing space is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { files: { "500/ship-kit-state-1": payload(101, `${g.line} `) } }).trust(g.comment);
  assert.equal(result.trusted, false);
});

test("state.json with an extra key is untrusted", () => {
  const g = genuine(101, 500);
  const text = JSON.stringify({ commentId: 101, marker: g.line, extra: true });
  assert.equal(single(g, { files: { "500/ship-kit-state-1": text } }).trust(g.comment).trusted, false);
});

test("state.json missing a key, not an object, or not JSON is untrusted", () => {
  const g = genuine(101, 500);
  for (const text of [JSON.stringify({ commentId: 101 }), JSON.stringify([101, g.line]), "null", "not json", ""]) {
    assert.equal(single(g, { files: { "500/ship-kit-state-1": text } }).trust(g.comment).trusted, false, text);
  }
});

test("an artifact whose commentId names another comment (same marker) is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { files: { "500/ship-kit-state-1": payload(999, g.line) } }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /match/);
});

test("a commentId given as a string is untrusted", () => {
  const g = genuine(101, 500);
  const text = JSON.stringify({ commentId: "101", marker: g.line });
  assert.equal(single(g, { files: { "500/ship-kit-state-1": text } }).trust(g.comment).trusted, false);
});

test("an oversized state.json is untrusted", () => {
  const g = genuine(101, 500);
  const big = JSON.stringify({ commentId: 101, marker: g.line }) + " ".repeat(MAX_STATE_BYTES);
  const result = single(g, { files: { "500/ship-kit-state-1": big } }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /exceeds/);
});

test("a download returning a non-string is untrusted", () => {
  const g = genuine(101, 500);
  assert.equal(single(g, { files: { "500/ship-kit-state-1": Buffer.from("{}") } }).trust(g.comment).trusted, false);
});

test("download timing out is untrusted", () => {
  const g = genuine(101, 500);
  const result = single(g, { files: { "500/ship-kit-state-1": new Error("gh run download: timed out after 60000 ms") } }).trust(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /timed out/);
});

test("a download failing on one artifact makes the comment untrusted even if a later one would match", () => {
  const g = genuine(102, 500);
  const result = single(g, {
    artifacts: [artifact("ship-kit-state-1"), artifact("ship-kit-state-2")],
    files: { "500/ship-kit-state-1": new Error("boom"), "500/ship-kit-state-2": payload(102, g.line) },
  }).trust(g.comment);
  assert.equal(result.trusted, false);
});

test("a throwing non-Error value is untrusted with a reason", () => {
  const g = genuine(101, 500);
  const w = world();
  w.gh.get = () => { throw "string thrown"; };
  const result = trustWith(w)(g.comment);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /string thrown/);
});

test("a caller-supplied cache reuses one run's lookups across comments", () => {
  const a = genuine(101, 500);
  const bLine = marker({ runId: 500, kind: "general", head: "c".repeat(40) });
  const b = comment(102, bLine);
  const w = world({
    runs: { 500: a.run },
    artifacts: { 500: [artifact("ship-kit-state-1"), artifact("ship-kit-state-2")] },
    files: { "500/ship-kit-state-1": payload(101, a.line), "500/ship-kit-state-2": payload(102, bLine) },
  });
  const trust = trustWith(w);
  const cache = new Map();
  assert.equal(trust(a.comment, cache).trusted, true);
  assert.equal(trust(b, cache).trusted, true);
  assert.equal(w.calls.get.length, 1);
  assert.equal(w.calls.listKey.length, 1);
  assert.equal(w.calls.download.length, 2);
  // a failure is cached too: the same run is never retried within the cache
  const failing = world({ runs: { 500: new Error("rate limited") } });
  const trust2 = trustWith(failing);
  const cache2 = new Map();
  assert.equal(trust2(a.comment, cache2).trusted, false);
  assert.equal(trust2(b, cache2).trusted, false);
  assert.equal(failing.calls.get.length, 1);
});

test("one cached run lookup still checks the caller path per kind", () => {
  const g = genuine(101, 500, "general");
  const forgedLine = marker({ runId: 500, kind: "adversarial" });
  const forged = comment(102, forgedLine);
  const w = world({
    runs: { 500: g.run },
    artifacts: { 500: g.artifacts },
    files: { "500/ship-kit-state-1": payload(102, forgedLine) },
  });
  const trust = trustWith(w);
  const cache = new Map();
  assert.equal(trust(g.comment, cache).trusted, false, "the artifact names comment 102");
  const result = trust(forged, cache);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /managed caller for adversarial/);
  assert.equal(w.calls.get.length, 1);
});

test("without a cache argument every call reads the API afresh", () => {
  const g = genuine(101, 500);
  const { w, trust } = single(g);
  trust(g.comment);
  trust(g.comment);
  assert.equal(w.calls.get.length, 2);
});

// collectTrustedStates --------------------------------------------------

function worldOf(gens, extra = {}) {
  const runs = {};
  const artifacts = {};
  const files = {};
  for (const g of gens) {
    runs[g.run.id] = g.run;
    artifacts[g.run.id] = g.artifacts;
    Object.assign(files, g.files);
  }
  return world({ runs: { ...runs, ...extra.runs }, artifacts: { ...artifacts, ...extra.artifacts }, files: { ...files, ...extra.files } });
}

test("collectTrustedStates round trip returns states ascending by comment id with commentId attached", () => {
  const gens = [genuine(300, 3, "general"), genuine(100, 1, "general"), genuine(200, 2, "adversarial")];
  const w = worldOf(gens);
  const noise = [
    comment(50, "just a comment", { user: { login: "alice", type: "User" } }),
    { ...gens[0].comment, id: 250, body: gens[0].comment.body },
  ];
  const states = collectTrustedStates([...gens.map((g) => g.comment), ...noise], {
    kinds: ["general", "adversarial"], trustState: trustWith(w),
  });
  assert.deepEqual(states.map((s) => s.commentId), [100, 200, 300]);
  assert.deepEqual(states.map((s) => s.runId), [1, 2, 3]);
  assert.deepEqual(states.map((s) => s.kind), ["general", "adversarial", "general"]);
  assert.equal(states[0].head, HEAD);
});

test("a design-doc marker of kind adversarial passes kinds [adversarial] and is excluded by kinds [general]", () => {
  const g = genuine(100, 1, "adversarial");
  assert.equal(g.comment.body.startsWith(g.line), true);
  const w1 = worldOf([g]);
  const kept = collectTrustedStates([g.comment], { kinds: ["adversarial"], trustState: trustWith(w1) });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].mode, "design-doc");
  assert.equal(kept[0].kind, "adversarial");
  const w2 = worldOf([g]);
  assert.deepEqual(collectTrustedStates([g.comment], { kinds: ["general"], trustState: trustWith(w2) }), []);
  assert.equal(w2.calls.get.length, 0);
});

test("35 markers of one kind cause at most 30 run lookups, keeping the newest", () => {
  const gens = Array.from({ length: 35 }, (_, i) => genuine(1000 + i, 1 + i));
  const w = worldOf(gens);
  const states = collectTrustedStates(gens.map((g) => g.comment).reverse(), {
    kinds: ["general"], trustState: trustWith(w),
  });
  assert.equal(w.calls.get.length, 30);
  assert.equal(states.length, 30);
  assert.equal(states[0].commentId, 1005);
  assert.equal(states[29].commentId, 1034);
});

test("the cap applies per kind", () => {
  const gens = [
    ...Array.from({ length: 3 }, (_, i) => genuine(100 + i, 10 + i, "general")),
    ...Array.from({ length: 3 }, (_, i) => genuine(200 + i, 20 + i, "adversarial")),
  ];
  const w = worldOf(gens);
  const states = collectTrustedStates(gens.map((g) => g.comment), {
    kinds: ["general", "adversarial"], trustState: trustWith(w), cap: 2,
  });
  assert.deepEqual(states.map((s) => s.commentId), [101, 102, 201, 202]);
  assert.equal(w.calls.get.length, 4);
});

test("marker-shaped comments by other authors or edited ones do not use up the cap", () => {
  const real = genuine(100, 1);
  const forged = Array.from({ length: 40 }, (_, i) => comment(500 + i, marker({ runId: 900 + i }), {
    user: { login: "mallory", type: "User" },
  }));
  const edited = Array.from({ length: 40 }, (_, i) => comment(600 + i, marker({ runId: 950 + i }), {
    updated_at: "2026-02-01T00:00:00Z",
  }));
  const badIds = [comment("x", marker({ runId: 990 })), comment(0, marker({ runId: 991 }))];
  const w = worldOf([real]);
  const states = collectTrustedStates([real.comment, ...forged, ...edited, ...badIds], {
    kinds: ["general"], trustState: trustWith(w),
  });
  assert.deepEqual(states.map((s) => s.commentId), [100]);
  assert.equal(w.calls.get.length, 1);
});

test("collectTrustedStates caches run lookups per run id within one call", () => {
  const a = genuine(101, 500);
  const bLine = marker({ runId: 500, head: "c".repeat(40) });
  const b = comment(102, bLine);
  const w = world({
    runs: { 500: a.run },
    artifacts: { 500: [artifact("ship-kit-state-1"), artifact("ship-kit-state-2")] },
    files: { "500/ship-kit-state-1": payload(101, a.line), "500/ship-kit-state-2": payload(102, bLine) },
  });
  const trustState = trustWith(w);
  const states = collectTrustedStates([a.comment, b], { kinds: ["general"], trustState });
  assert.deepEqual(states.map((s) => s.commentId), [101, 102]);
  assert.equal(w.calls.get.length, 1);
  assert.equal(w.calls.listKey.length, 1);
  collectTrustedStates([a.comment], { kinds: ["general"], trustState });
  assert.equal(w.calls.get.length, 2, "a second call starts a fresh cache");
});

test("collectTrustedStates drops untrusted states and never throws on a trustState that throws", () => {
  const g = genuine(100, 1);
  const states = collectTrustedStates([g.comment, null, "x"], {
    kinds: ["general"], trustState: () => { throw new Error("boom"); },
  });
  assert.deepEqual(states, []);
  const untrusted = collectTrustedStates([g.comment], {
    kinds: ["general"], trustState: () => ({ trusted: false, reason: "no" }),
  });
  assert.deepEqual(untrusted, []);
  const truthyOnly = collectTrustedStates([g.comment], {
    kinds: ["general"], trustState: () => ({ trusted: "yes", state: {} }),
  });
  assert.deepEqual(truthyOnly, [], "only trusted === true counts");
});

test("collectTrustedStates attaches the state trustState returned", () => {
  const g = genuine(100, 1);
  const states = collectTrustedStates([g.comment], {
    kinds: ["general"],
    trustState: () => ({ trusted: true, state: { kind: "general", runId: 1, commentId: 5 } }),
  });
  assert.deepEqual(states, [{ kind: "general", runId: 1, commentId: 100 }]);
});

test("collectTrustedStates refuses bad arguments", () => {
  const trustState = () => ({ trusted: false, reason: "x" });
  assert.throws(() => collectTrustedStates("x", { kinds: ["general"], trustState }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: [], trustState }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: "general", trustState }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: [""], trustState }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: ["general"], trustState: null }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: ["general"], trustState, cap: 0 }), TypeError);
  assert.throws(() => collectTrustedStates([], { kinds: ["general"], trustState, cap: 1.5 }), TypeError);
  assert.throws(() => collectTrustedStates([]), TypeError);
});

// makeDownload ------------------------------------------------------------

/**
 * A gh client whose run function plays `gh run download`: it writes
 * `files` (name -> content, or a function of the target dir) into the -D
 * directory, or throws `error`.
 */
function downloadGh({ files = {}, error, timeoutMs } = {}) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    if (error) throw error;
    const dir = args[args.indexOf("-D") + 1];
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === "function") content(dir);
      else writeFileSync(join(dir, name), content);
    }
    return "";
  };
  return { gh: makeGh({ run, ...(timeoutMs ? { timeoutMs } : {}) }), calls };
}

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), "trust-state-test-"));
}

test("makeDownload reads state.json through gh run download and cleans up", () => {
  const root = scratchRoot();
  const { gh, calls } = downloadGh({ files: { "state.json": '{"commentId":1,"marker":"m"}' } });
  const download = makeDownload({ gh, repo: REPO, tmpRoot: root });
  assert.equal(download(500, "ship-kit-state-2"), '{"commentId":1,"marker":"m"}');
  assert.equal(calls.length, 1);
  const { file, args, options } = calls[0];
  assert.equal(file, "gh");
  assert.deepEqual(args.slice(0, 7), ["run", "download", "500", "-R", "Owner/Repo", "-n", "ship-kit-state-2"]);
  assert.equal(args[7], "-D");
  assert.equal(options.timeout, 60000);
  assert.deepEqual(readdirSync(root), [], "the download directory is removed");
});

test("makeDownload refuses an oversized state.json", () => {
  const root = scratchRoot();
  const { gh } = downloadGh({ files: { "state.json": "x".repeat(MAX_STATE_BYTES + 1) } });
  const download = makeDownload({ gh, repo: REPO, tmpRoot: root });
  assert.throws(() => download(500, "ship-kit-state-1"), /exceeds/);
  assert.deepEqual(readdirSync(root), []);
});

test("makeDownload accepts a state.json of exactly the cap", () => {
  const { gh } = downloadGh({ files: { "state.json": "x".repeat(MAX_STATE_BYTES) } });
  assert.equal(makeDownload({ gh, repo: REPO, tmpRoot: scratchRoot() })(500, "ship-kit-state-1").length, MAX_STATE_BYTES);
});

test("makeDownload refuses a missing state.json, a directory or a symlink in its place", () => {
  const root = scratchRoot();
  const target = join(root, "outside.json");
  writeFileSync(target, "{}");
  const cases = [
    { "other.json": "{}" },
    { dir: (d) => mkdirSync(join(d, "state.json")) },
    { link: (d) => symlinkSync(target, join(d, "state.json")) },
  ];
  for (const files of cases) {
    const { gh } = downloadGh({ files });
    assert.throws(() => makeDownload({ gh, repo: REPO, tmpRoot: root })(500, "ship-kit-state-1"), Error);
  }
  assert.deepEqual(readdirSync(root), ["outside.json"]);
});

test("makeDownload refuses a state.json that is not UTF-8", () => {
  const { gh } = downloadGh({ files: { "state.json": Buffer.from([0x7b, 0xff, 0x7d]) } });
  assert.throws(() => makeDownload({ gh, repo: REPO, tmpRoot: scratchRoot() })(500, "ship-kit-state-1"), /UTF-8/);
});

test("makeDownload fails on a timeout or a gh failure and still cleans up", () => {
  const root = scratchRoot();
  const timeout = Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
  const t = downloadGh({ error: timeout });
  assert.throws(() => makeDownload({ gh: t.gh, repo: REPO, tmpRoot: root })(500, "ship-kit-state-1"), /timed out/);
  const expired = Object.assign(new Error("exit 1"), { status: 1, stdout: "", stderr: "no artifact matches any of the names" });
  const e = downloadGh({ error: expired });
  assert.throws(() => makeDownload({ gh: e.gh, repo: REPO, tmpRoot: root })(500, "ship-kit-state-1"), /exited 1/);
  assert.deepEqual(readdirSync(root), []);
});

test("makeDownload refuses a bad run id or artifact name before running gh", () => {
  const { gh, calls } = downloadGh();
  const download = makeDownload({ gh, repo: REPO, tmpRoot: scratchRoot() });
  for (const runId of [0, -1, 1.5, "500", undefined]) assert.throws(() => download(runId, "ship-kit-state-1"), TypeError);
  for (const name of ["", "-n", "--pattern=*", "a/b", "a b", "..", ".", undefined, "x".repeat(257)]) {
    assert.throws(() => download(500, name), TypeError, String(name));
  }
  assert.equal(calls.length, 0);
});

test("makeDownload refuses a bad gh, repo or tmpRoot", () => {
  const { gh } = downloadGh();
  assert.throws(() => makeDownload({ gh: {}, repo: REPO }), TypeError);
  assert.throws(() => makeDownload({ gh, repo: "bad" }), TypeError);
  assert.throws(() => makeDownload({ gh, repo: REPO, tmpRoot: "" }), TypeError);
});

test("makeDownload defaults tmpRoot to the OS temp directory", () => {
  const { gh, calls } = downloadGh({ files: { "state.json": "{}" } });
  assert.equal(makeDownload({ gh, repo: REPO })(500, "ship-kit-state-1"), "{}");
  const dir = calls[0].args[calls[0].args.indexOf("-D") + 1];
  assert.ok(dir.startsWith(tmpdir()), dir);
  assert.equal(existsSync(dir), false);
});

test("makeDownload wired into makeTrustState trusts a genuine state end to end", () => {
  const g = genuine(101, 500);
  const { gh: dgh } = downloadGh({ files: { "state.json": payload(101, g.line) } });
  const w = world({ runs: { 500: g.run }, artifacts: { 500: g.artifacts } });
  const trust = makeTrustState({
    gh: w.gh, repo: REPO, defaultBranch: DEFAULT,
    download: makeDownload({ gh: dgh, repo: REPO, tmpRoot: scratchRoot() }),
  });
  assert.equal(trust(g.comment).trusted, true);
});
