import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { CallError } from "../../scripts/lib/gh.mjs";
import {
  DEFAULT_REF, MAX_CONFIG_BYTES, SCHEMA_VERSION, SEATS, checkRemoteUrl, loadConfig, makeGit, readConfigAt,
  readDefaultBranchConfig, readOriginRepository, semanticErrors, strictConfig,
} from "../../scripts/lib/config.mjs";

const SHIP_KIT = { version: "0.2.0", sha: "0123456789abcdef0123456789abcdef01234567" };
const minimal = (extra = {}) => ({ schemaVersion: 1, shipKit: SHIP_KIT, ...extra });
const load = (value, options) => loadConfig(JSON.stringify(value), options);
const fakeMigration = { from: 0, to: 1, migrate: ({ schemaVersion, oldShipKit, ...rest }) => ({ ...rest, schemaVersion: 1, shipKit: oldShipKit }) };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fixture git: no user or system config, no signing, fixed identity.
function sh(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFile(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repoWith(t, files, branch = "main") {
  const dir = tempDir(t);
  sh(dir, "init", "-q", "-b", branch);
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "fixture");
  return { dir, sha: sh(dir, "rev-parse", "HEAD") };
}

const configText = (agents) => `${JSON.stringify(minimal({ agents }), null, 2)}\n`;

// --- loadConfig ------------------------------------------------------------

test("defaults fill an otherwise empty config", () => {
  const result = load(minimal());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.migratedFrom, null);
  const { config } = result;
  assert.deepEqual(config.shipKit, SHIP_KIT);
  assert.deepEqual(config.render.auth, { kind: "oauth", secret: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.deepEqual(config.render.runners, { plan: ["ubuntu-latest"], seat: ["ubuntu-latest"], aggregate: ["ubuntu-latest"], gate: ["ubuntu-latest"] });
  assert.equal(config.render.bootWorkflow, null);
  assert.deepEqual(config.render.seats, ["general", "adversarial"]);
  assert.equal(config.render.checks.general, "ship-kit general review");
  assert.equal(config.render.checks["change-class"], "ship-kit change class");
  assert.equal(config.render.coverageWorkflow, null);
  assert.equal(config.render.changeClassCheck, false);
  assert.deepEqual(config.review.specDirs, []);
  assert.deepEqual(config.review.planDirs, []);
  assert.deepEqual(config.review.seats, {
    general: { mode: "required", model: null },
    adversarial: { mode: "shadow", model: null },
    security: { mode: "shadow", model: null },
    "test-integrity": { mode: "shadow", model: null },
  });
  assert.equal(config.review.maxSeats, 12);
  assert.equal(config.review.targetLines, 1500);
  assert.equal(config.review.maxTurns, 120);
  assert.deepEqual(config.review.huntLists, { code: ".ship-kit/hunt-lists/code.md", design: ".ship-kit/hunt-lists/design.md" });
  assert.deepEqual(config.review.override, { label: "ship-kit-override", minPermission: "write" });
  assert.deepEqual(config.review.promotion, { cleanRuns: 5, falsePositiveLabel: "ship-kit-false-positive", confirmedLabel: "ship-kit-confirmed" });
  assert.deepEqual(config.coverage, { mode: "shadow", include: ["src/**"], exclude: [], threshold: null, baseline: null });
  assert.deepEqual(config.preflight, { steps: [], prerequisites: {}, prePushTier: "full" });
  assert.deepEqual(config.classify, { trivial: ["**/*.md", "docs/**"], hub: [], hubRequires: ["spec", "plan"] });
  assert.deepEqual(config.agents, { commitAndPush: true, adminMerge: false });
  assert.deepEqual(config.ship, { maxIterations: 5 });
  assert.deepEqual(config.ciWatch, { maxIterations: 3, pollSeconds: 30 });
  assert.deepEqual(config.merge, { method: "squash", humanOnlyPaths: [] });
});

test("schemaVersion and shipKit are required", () => {
  assert.match(load({ schemaVersion: 1 }).reason, /\/shipKit is required/);
  assert.match(load({ shipKit: SHIP_KIT }).reason, /\/schemaVersion is required/);
  assert.match(load(minimal({ shipKit: { version: "0.2.0" } })).reason, /\/shipKit\/sha is required/);
});

test("a spec directory without the trailing slash is rejected", () => {
  const result = load(minimal({ review: { specDirs: ["docs/design"] } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /\/review\/specDirs\/0 must match pattern/);
});

test("directory patterns reject traversal, absolute and dot components", () => {
  for (const dir of ["../x/", "/abs/", "./x/", "a/../b/", "a//", "", "a/./b/", "docs\\x/"]) {
    const result = load(minimal({ review: { planDirs: [dir] } }));
    assert.equal(result.ok, false, `${JSON.stringify(dir)} was accepted`);
    assert.match(result.reason, /\/review\/planDirs\/0 must match pattern/);
  }
  for (const dir of [".ship-kit/x/", "docs/design/", "a/b-c_d.e/"]) {
    assert.equal(load(minimal({ review: { planDirs: [dir] } })).ok, true, dir);
  }
});

test("file patterns reject traversal and trailing slashes", () => {
  for (const file of ["a/..", "..", "../a", "a/", "/a", "a/./b"]) {
    const result = load(minimal({ review: { huntLists: { code: file } } }));
    assert.equal(result.ok, false, `${JSON.stringify(file)} was accepted`);
    assert.match(result.reason, /\/review\/huntLists\/code must match pattern/);
  }
  assert.equal(load(minimal({ render: { coverageWorkflow: ".github/workflows/test.yml" } })).ok, true);
  assert.equal(load(minimal({ render: { coverageWorkflow: "../test.yml" } })).ok, false);
});

test("check names reject a colon and a hash", () => {
  for (const name of ["x: y", "a#b", " lead", "a".repeat(101)]) {
    const result = load(minimal({ render: { checks: { general: name } } }));
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /\/render\/checks\/general must match pattern/);
  }
  assert.equal(load(minimal({ render: { checks: { general: "Review (general) v1.0" } } })).ok, true);
});

test("other value patterns and enums", () => {
  const rejected = [
    { render: { auth: { secret: "GITHUB_TOKEN" } } },
    { render: { auth: { secret: "lower" } } },
    { render: { auth: { kind: "password" } } },
    { render: { runners: { seat: [] } } },
    { render: { runners: { seat: ["-x"] } } },
    { render: { bootWorkflow: ".github/workflows/boot.yml" } },
    { render: { seats: [] } },
    { render: { seats: ["general", "other"] } },
    { review: { seats: { other: { mode: "shadow" } } } },
    { review: { seats: { general: { mode: "off" } } } },
    { review: { seats: { general: { model: "a b" } } } },
    { review: { maxSeats: 0 } },
    { review: { targetLines: 99 } },
    { review: { maxTurns: 501 } },
    { review: { override: { minPermission: "triage" } } },
    { review: { override: { label: "-x" } } },
    { review: { promotion: { confirmedLabel: "a:b" } } },
    { coverage: { threshold: 101 } },
    { coverage: { baseline: { prs: [1], percentile: 100, computed: "2026-01-01" } } },
    { coverage: { baseline: { prs: [1], percentile: 50 } } },
    { coverage: { include: ["/abs/**"] } },
    { preflight: { steps: [{ name: "Lint", tier: "fast", run: ["x"] }] } },
    { preflight: { steps: [{ name: "lint", tier: "fast", run: [] }] } },
    { preflight: { prerequisites: { "Bad Name": ["x"] } } },
    { classify: { hubRequires: ["spec", "code"] } },
    { merge: { method: "fast-forward" } },
    { ciWatch: { pollSeconds: 5 } },
    { ship: { maxIterations: 21 } },
    { unknown: true },
    { render: { extra: 1 } },
  ];
  for (const extra of rejected) assert.equal(load(minimal(extra)).ok, false, JSON.stringify(extra));
  const accepted = minimal({
    render: { bootWorkflow: "./.github/workflows/boot.yaml", auth: { kind: "api-key", secret: "ANTHROPIC_API_KEY" } },
    review: { seats: { general: { model: "claude-opus-4-1[1m]" } } },
    coverage: { threshold: 80.5, baseline: { prs: [1, 2], percentile: 20, computed: "2026-09-28" } },
    preflight: { steps: [{ name: "lint", tier: "fast", run: ["npm", "run", "lint"] }], prerequisites: { docker: ["docker", "info"] } },
  });
  const result = load(accepted);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.config.preflight.steps[0].requires, []);
});

test("duplicate check names are rejected", () => {
  const result = load(minimal({ render: { checks: { adversarial: "ship-kit general review" } } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /render\.checks\.adversarial repeats the check name of render\.checks\.general/);
});

test("a seat listed twice in render.seats is rejected", () => {
  assert.match(load(minimal({ render: { seats: ["general", "general"] } })).reason, /more than once/);
});

test("semanticErrors reports a review seat outside SEATS", () => {
  const { config } = load(minimal());
  assert.deepEqual(semanticErrors(config), []);
  config.review.seats.other = { mode: "shadow", model: null };
  assert.deepEqual(semanticErrors(config), ["review.seats.other is not a ship-kit seat"]);
  assert.deepEqual([...SEATS], ["general", "adversarial", "security", "test-integrity"]);
});

test("one leading BOM is accepted, a second is not", () => {
  const text = JSON.stringify(minimal());
  assert.equal(loadConfig(`\uFEFF${text}`).ok, true);
  assert.equal(loadConfig(`\uFEFF\uFEFF${text}`).ok, false);
});

test("non-object JSON, invalid JSON and non-string input are rejected", () => {
  assert.match(loadConfig("[]").reason, /must be a JSON object/);
  assert.match(loadConfig("null").reason, /must be a JSON object/);
  assert.match(loadConfig("{").reason, /not valid JSON/);
  assert.match(loadConfig(Buffer.from("{}")).reason, /must be a string/);
});

test("an N+1 config is rejected as written by a newer ship-kit", () => {
  const result = load(minimal({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /written by a newer ship-kit/);
});

test("a non-integer schemaVersion is rejected by the schema", () => {
  assert.match(load(minimal({ schemaVersion: "1" })).reason, /\/schemaVersion does not match const/);
  assert.match(load(minimal({ schemaVersion: 0.5 })).reason, /\/schemaVersion does not match const/);
});

test("an N-1 config is read through the injected migration", () => {
  const old = { schemaVersion: 0, oldShipKit: SHIP_KIT, agents: { commitAndPush: false } };
  const result = load(old, { migrations: [fakeMigration] });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.migratedFrom, 0);
  assert.deepEqual(result.config.shipKit, SHIP_KIT);
  assert.equal(result.config.agents.commitAndPush, false);
  assert.equal(result.config.review.maxSeats, 12);
});

test("an N-1 config with the shipped empty chain is not ok", () => {
  assert.match(load({ schemaVersion: 0 }).reason, /no migration from schemaVersion 0/);
});

test("a gap in the chain refuses the config", () => {
  const gapped = [fakeMigration, { from: 2, to: 3, migrate: (c) => c }];
  assert.match(load({ schemaVersion: 0 }, { migrations: gapped }).reason, /invalid migration chain: .*gap/);
});

test("a migration that mutates its input, throws or yields the wrong version is refused", () => {
  const mutating = { from: 0, to: 1, migrate: (c) => { c.schemaVersion = 1; return c; } };
  assert.match(load({ schemaVersion: 0 }, { migrations: [mutating] }).reason, /migration from schemaVersion 0 failed/);
  const wrong = { from: 0, to: 1, migrate: (c) => ({ ...c }) };
  assert.match(load({ schemaVersion: 0 }, { migrations: [wrong] }).reason, /did not produce schemaVersion 1/);
  const notObject = { from: 0, to: 1, migrate: () => [] };
  assert.match(load({ schemaVersion: 0 }, { migrations: [notObject] }).reason, /did not produce schemaVersion 1/);
});

test("a migration that throws a non-Error value is refused, not rethrown", () => {
  for (const [thrown, kind] of [[null, "null"], ["text", "string"], [undefined, "undefined"]]) {
    const throwing = { from: 0, to: 1, migrate: () => { throw thrown; } };
    const result = load({ schemaVersion: 0 }, { migrations: [throwing] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, `migration from schemaVersion 0 failed: threw a non-Error value (${kind})`);
  }
});

test("the loaded config never aliases the parsed input", () => {
  const first = load(minimal()).config;
  first.review.specDirs.push("x/");
  assert.deepEqual(load(minimal()).config.review.specDirs, []);
});

test("strictConfig: every seat required, no design-doc dirs, admin approvals, agents ask", () => {
  const strict = strictConfig();
  assert.equal(Object.hasOwn(strict, "shipKit"), false);
  assert.deepEqual(strict.review.specDirs, []);
  assert.deepEqual(strict.review.planDirs, []);
  for (const seat of SEATS) assert.equal(strict.review.seats[seat].mode, "required", seat);
  assert.equal(strict.review.override.minPermission, "admin");
  assert.equal(strict.agents.commitAndPush, false);
  assert.equal(strict.agents.adminMerge, false);
  strict.review.seats.general.mode = "shadow";
  assert.equal(strictConfig().review.seats.general.mode, "required");
});

// --- readConfigAt ------------------------------------------------------------

test("readConfigAt reads a committed config by SHA", (t) => {
  const { dir, sha } = repoWith(t, { ".ship-kit/config.json": configText({ commitAndPush: false }) });
  const result = readConfigAt(sha, ".ship-kit/config.json", { git: makeGit(dir) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sha, sha);
  assert.equal(result.config.agents.commitAndPush, false);
});

test("readConfigAt on a symlink path returns not ok", (t) => {
  const dir = tempDir(t);
  sh(dir, "init", "-q", "-b", "main");
  writeFile(dir, "real.json", configText({ commitAndPush: false }));
  mkdirSync(join(dir, ".ship-kit"));
  symlinkSync("../real.json", join(dir, ".ship-kit/config.json"));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "symlink");
  const result = readConfigAt(sh(dir, "rev-parse", "HEAD"), ".ship-kit/config.json", { git: makeGit(dir) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is not a regular file \(mode 120000\)/);
});

test("readConfigAt refuses a directory, an absent file, an oversized file and invalid UTF-8", (t) => {
  const { dir, sha } = repoWith(t, {
    "a/b.json": "{}",
    "big.json": `${" ".repeat(MAX_CONFIG_BYTES)}{}`,
    "latin1.json": Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x7d]),
  });
  const git = makeGit(dir);
  assert.match(readConfigAt(sha, "a", { git }).reason, /is not a regular file \(mode 040000\)/);
  assert.equal(readConfigAt(sha, ".ship-kit/config.json", { git }).reason, `.ship-kit/config.json is absent at ${sha}`);
  assert.match(readConfigAt(sha, "big.json", { git }).reason, /is larger than/);
  assert.match(readConfigAt(sha, "latin1.json", { git }).reason, /could not read latin1.json/);
  assert.match(readConfigAt(sha, "a/b.json", { git }).reason, /a\/b.json at [0-9a-f]{40}: \/schemaVersion is required/);
});

test("readConfigAt validates its ref and path before running git", () => {
  const git = () => assert.fail("git must not run");
  for (const ref of ["HEAD", "main", "refs/heads/main", "0123456789ABCDEF0123456789abcdef01234567", "-x", 7]) {
    assert.match(readConfigAt(ref, ".ship-kit/config.json", { git }).reason, /ref must be a full commit SHA/);
  }
  for (const path of ["../x.json", "/abs.json", "a/../b.json", ".ship-kit/", ":(glob)*", 3]) {
    assert.match(readConfigAt(SHIP_KIT.sha, path, { git }).reason, /is not a relative file path/);
  }
});

test("readConfigAt refuses a missing commit and unexpected git output", (t) => {
  const { dir } = repoWith(t, { "x.txt": "x" });
  assert.match(readConfigAt(SHIP_KIT.sha, "c.json", { git: makeGit(dir) }).reason, /could not read c.json at/);
  const oid = "a".repeat(40);
  const fake = (answers) => (args) => ({ "show-ref": `${oid}\n`, ...answers })[args[0]] ?? assert.fail(`unexpected git ${args[0]}`);
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "show-ref": "nope\n" }) }).reason, /could not resolve/);
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": "nope\n" }) }).reason, /could not resolve/);
  const twoEntries = `100644 blob ${oid}      2\tc.json\x00100644 blob ${oid}      2\tc.json\x00`;
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": `${oid}\n`, "ls-tree": twoEntries }) }).reason, /unexpected tree listing/);
  const otherPath = `100644 blob ${oid}      2\td.json\x00`;
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": `${oid}\n`, "ls-tree": otherPath }) }).reason, /unexpected tree listing/);
  const garbled = "garbage\x00";
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": `${oid}\n`, "ls-tree": garbled }) }).reason, /unexpected tree listing/);
  const submodule = `160000 commit ${oid}       -\tc.json\x00`;
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": `${oid}\n`, "ls-tree": submodule }) }).reason, /not a regular file \(mode 160000\)/);
  const blob = `100644 blob ${oid}      2\tc.json\x00`;
  assert.match(readConfigAt(DEFAULT_REF, "c.json", { git: fake({ "rev-parse": `${oid}\n`, "ls-tree": blob, "cat-file": "tree\n" }) }).reason, /is not a blob/);
});

test("readConfigAt accepts one leading BOM in the file and refuses two", (t) => {
  const body = configText({ commitAndPush: false });
  const { dir, sha } = repoWith(t, { "one.json": `\uFEFF${body}`, "two.json": `\uFEFF\uFEFF${body}` });
  const git = makeGit(dir);
  assert.equal(readConfigAt(sha, "one.json", { git }).ok, true);
  const two = readConfigAt(sha, "two.json", { git });
  assert.equal(two.ok, false);
  assert.match(two.reason, /two.json at [0-9a-f]{40}: not valid JSON/);
});

test("readConfigAt ignores replace refs", (t) => {
  const { dir, sha } = repoWith(t, { "c.json": configText({ commitAndPush: false }) });
  const trusted = sh(dir, "rev-parse", `${sha}:c.json`);
  writeFile(dir, "evil.json", configText({ commitAndPush: true }));
  const evil = sh(dir, "hash-object", "-w", "evil.json");
  sh(dir, "replace", trusted, evil);
  assert.match(sh(dir, "cat-file", "blob", trusted), /"commitAndPush": true/);
  const result = readConfigAt(sha, "c.json", { git: makeGit(dir) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.config.agents.commitAndPush, false);
});

test("readConfigAt resolves refs/ship-kit/default exactly, never a branch or tag of that name", (t) => {
  const { dir, sha } = repoWith(t, { "c.json": configText({ commitAndPush: true }) });
  const git = makeGit(dir);
  for (const decoy of ["refs/heads/refs/ship-kit/default", "refs/tags/refs/ship-kit/default"]) {
    sh(dir, "update-ref", decoy, sha);
    const result = readConfigAt(DEFAULT_REF, "c.json", { git });
    assert.equal(result.ok, false, decoy);
    assert.match(result.reason, /could not read c.json at refs\/ship-kit\/default/, decoy);
    sh(dir, "update-ref", "-d", decoy);
  }
  sh(dir, "update-ref", DEFAULT_REF, sha);
  assert.equal(readConfigAt(DEFAULT_REF, "c.json", { git }).config.agents.commitAndPush, true);
});

// --- readDefaultBranchConfig -------------------------------------------------

/**
 * An origin whose default branch is release/1.x (commitAndPush false), and a
 * clone on a local branch that says true. The clone's origin is an absolute
 * local path, so every read of it passes `allowLocalRemote: true`.
 */
function fixtureClone(t) {
  const origin = repoWith(t, { ".ship-kit/config.json": configText({ commitAndPush: false }) }, "release/1.x");
  const clone = join(tempDir(t), "clone");
  sh(dirname(clone), "clone", "-q", origin.dir, clone);
  sh(clone, "checkout", "-q", "-b", "feature");
  writeFile(clone, ".ship-kit/config.json", configText({ commitAndPush: true }));
  sh(clone, "commit", "-q", "-am", "local says true");
  sh(clone, "branch", "-f", "release/1.x", "feature");
  return { origin, clone };
}

const NETWORK_URL = "https://example.invalid/owner/repo.git";
const TOP = "/checkout";

/** A fake git inside an ordinary checkout at TOP whose `origin` is `url`; `rest` answers every other call. */
function networkOrigin(rest, url = NETWORK_URL) {
  const answers = {
    "rev-parse --is-bare-repository": "false",
    "rev-parse --show-toplevel": TOP,
    "rev-parse --absolute-git-dir": `${TOP}/.git`,
    [`-C ${TOP} rev-parse --absolute-git-dir`]: `${TOP}/.git`,
    "config --get remote.origin.url": url,
    "remote get-url -- origin": url,
    [`ls-remote --get-url -- ${url}`]: url,
  };
  return (args) => {
    const key = args.join(" ");
    return Object.hasOwn(answers, key) ? `${answers[key]}\n` : rest(args);
  };
}

test("readDefaultBranchConfig reads origin's default branch, not the local branch or working tree", (t) => {
  const { origin, clone } = fixtureClone(t);
  const result = readDefaultBranchConfig({ git: makeGit(clone), allowLocalRemote: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.branch, "release/1.x");
  assert.equal(result.sha, origin.sha);
  assert.equal(result.config.agents.commitAndPush, false);
  assert.equal(sh(clone, "rev-parse", DEFAULT_REF), origin.sha);
});

test("readDefaultBranchConfig follows a new commit on origin's default branch", (t) => {
  const { origin, clone } = fixtureClone(t);
  writeFile(origin.dir, ".ship-kit/config.json", configText({ commitAndPush: true }));
  sh(origin.dir, "commit", "-q", "-am", "now true");
  const result = readDefaultBranchConfig({ git: makeGit(clone), allowLocalRemote: true });
  assert.equal(result.config.agents.commitAndPush, true);
  assert.equal(result.sha, sh(origin.dir, "rev-parse", "HEAD"));
});

test("readDefaultBranchConfig uses the working directory's repository by default", (t) => {
  const { clone } = fixtureClone(t);
  const cwd = process.cwd();
  process.chdir(clone);
  t.after(() => process.chdir(cwd));
  assert.equal(readDefaultBranchConfig({ allowLocalRemote: true }).config.agents.commitAndPush, false);
});

test("readDefaultBranchConfig runs no hooks, so a branch's hook cannot move the ref it reads", (t) => {
  const { origin, clone } = fixtureClone(t);
  const hook = [
    "#!/bin/sh",
    '[ "$1" = committed ] || exit 0',
    '[ -n "$MOVED" ] && exit 0',
    "grep -q refs/ship-kit/default || exit 0",
    "MOVED=1 git update-ref refs/ship-kit/default refs/heads/feature",
    "",
  ].join("\n");
  writeFile(clone, ".githooks/reference-transaction", hook);
  chmodSync(join(clone, ".githooks/reference-transaction"), 0o755);
  sh(clone, "config", "core.hooksPath", ".githooks");
  const result = readDefaultBranchConfig({ git: makeGit(clone), allowLocalRemote: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sha, origin.sha);
  assert.equal(result.config.agents.commitAndPush, false);
});

test("readDefaultBranchConfig passes the path through", (t) => {
  const { clone } = fixtureClone(t);
  assert.equal(readDefaultBranchConfig({ git: makeGit(clone), path: "other.json", allowLocalRemote: true }).reason, `other.json is absent at ${DEFAULT_REF}`);
});

test("readDefaultBranchConfig: ls-remote failure is not ok", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  const git = (args) => (args[1] === "--symref" ? (() => { throw new Error("network down"); })() : real(args));
  const result = readDefaultBranchConfig({ git, allowLocalRemote: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /network down/);
  assert.equal(Object.hasOwn(result, "branch"), false);
});

test("readDefaultBranchConfig: an origin with no default branch is not ok", () => {
  for (const out of ["", "abc\tHEAD\n", "ref: refs/tags/x\tHEAD\n", "ref: refs/heads/a\tHEAD\nref: refs/heads/b\tHEAD\n"]) {
    const result = readDefaultBranchConfig({ git: networkOrigin(() => out) });
    assert.match(result.reason, /does not name its default branch/, JSON.stringify(out));
  }
});

test("readDefaultBranchConfig: fetch failure is not ok", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  const git = (args) => (args[0] === "fetch" ? (() => { throw new Error("fetch refused"); })() : real(args));
  const result = readDefaultBranchConfig({ git, allowLocalRemote: true });
  assert.equal(result.ok, false);
  assert.equal(result.branch, "release/1.x");
  assert.match(result.reason, /fetch refused/);
});

test("readDefaultBranchConfig: an invalid branch name is not ok and is never fetched", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  for (const name of ["-x", "a..b", "a b", "@{-1}", "x.lock"]) {
    const git = (args) => {
      if (args[1] === "--symref") return `ref: refs/heads/${name}\tHEAD\n`;
      if (args[0] === "fetch") assert.fail(`fetched ${name}`);
      return real(args);
    };
    const result = readDefaultBranchConfig({ git, allowLocalRemote: true });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /is not a valid branch name/, name);
  }
});

test("readDefaultBranchConfig: check-ref-format rewriting the name is refused", () => {
  const git = networkOrigin((args) => {
    if (args[1] === "--symref") return "ref: refs/heads/main\tHEAD\n";
    if (args[0] === "check-ref-format") return "other\n";
    return assert.fail(`unexpected git ${args[0]}`);
  });
  assert.match(readDefaultBranchConfig({ git }).reason, /is not a valid branch name/);
});

test("readDefaultBranchConfig: a leading dash is refused even when check-ref-format accepts it", () => {
  const git = networkOrigin((args) => {
    if (args[1] === "--symref") return "ref: refs/heads/-x\tHEAD\n";
    if (args[0] === "check-ref-format") return `${args.at(-1)}\n`;
    return assert.fail(`unexpected git ${args[0]}`);
  });
  assert.match(readDefaultBranchConfig({ git }).reason, /"-x" is not a valid branch name/);
});

// --- origin must be a configured network remote ------------------------------

const LOCAL_PATH = { ok: false, reason: "origin's URL is a local path" };
const NO_URL = { ok: false, reason: "no remote named origin is configured with a url" };
const hasDefaultRef = (dir) => spawnSync("git", ["show-ref", "--verify", "--quiet", DEFAULT_REF], { cwd: dir }).status === 0;

/** A repository whose main branch's config sets commitAndPush to `value`. */
function configRepo(t, value) {
  return repoWith(t, { ".ship-kit/config.json": configText({ commitAndPush: value }) }, "main");
}

/**
 * A fresh checkout, with no `origin` remote, of a branch that says true in
 * its own config and commits at `name` a bare clone of a repository whose
 * config says true: the shape of a branch that tries to stand in for the
 * remote. `plantedConfig` is written into the bare clone's own config before
 * the commit.
 */
function branchCarryingRemote(t, name = "origin", plantedConfig = {}) {
  const planted = configRepo(t, true);
  const author = repoWith(t, { "README.md": "x\n" });
  sh(author.dir, "checkout", "-q", "-b", "feature");
  writeFile(author.dir, ".ship-kit/config.json", configText({ commitAndPush: true }));
  sh(author.dir, "clone", "-q", "--bare", planted.dir, name);
  // git commits no empty directory, so the ref is written loose to keep refs/ in the tree.
  writeFile(join(author.dir, name), "refs/heads/main", `${planted.sha}\n`);
  for (const [key, value] of Object.entries(plantedConfig)) sh(author.dir, "--git-dir", name, "config", key, value);
  sh(author.dir, "add", "-A");
  sh(author.dir, "commit", "-q", "-m", "carry a remote");
  const dir = join(tempDir(t), "checkout");
  sh(dirname(dir), "clone", "-q", "--branch", "feature", author.dir, dir);
  sh(dir, "remote", "remove", "origin");
  mkdirSync(join(dir, "sub"));
  return { dir, planted };
}

test("no origin remote: a directory named origin committed on a branch is not read as the remote", (t) => {
  const { dir, planted } = branchCarryingRemote(t);
  assert.equal(sh(dir, "remote"), "");
  assert.match(sh(join(dir, "sub"), "ls-remote", "--symref", "origin", "HEAD"), new RegExp(`^${planted.sha}\tHEAD$`, "m"));
  for (const cwd of [dir, join(dir, "sub")]) {
    for (const allowLocalRemote of [false, true]) {
      assert.deepEqual(readDefaultBranchConfig({ git: makeGit(cwd), allowLocalRemote }), NO_URL, `${cwd} ${allowLocalRemote}`);
    }
  }
  assert.equal(hasDefaultRef(dir), false);
});

test("no origin remote and no directory of that name is not ok", (t) => {
  const { dir } = repoWith(t, { "README.md": "x\n" });
  assert.deepEqual(readDefaultBranchConfig({ git: makeGit(dir), allowLocalRemote: true }), NO_URL);
});

test("an origin URL that is a relative path is refused even with allowLocalRemote: git resolves it inside the working tree", (t) => {
  const { dir, planted } = branchCarryingRemote(t, "upstream.git");
  sh(dir, "remote", "add", "origin", "upstream.git");
  assert.match(sh(join(dir, "sub"), "ls-remote", "--symref", "origin", "HEAD"), new RegExp(`^${planted.sha}\tHEAD$`, "m"));
  for (const cwd of [dir, join(dir, "sub")]) {
    for (const allowLocalRemote of [false, true]) {
      assert.deepEqual(readDefaultBranchConfig({ git: makeGit(cwd), allowLocalRemote }), LOCAL_PATH, `${cwd} ${allowLocalRemote}`);
    }
  }
  assert.equal(hasDefaultRef(dir), false);
});

test("a remote.origin section without a usable url is refused: git would read the name origin as the committed directory", (t) => {
  const { dir, planted } = branchCarryingRemote(t);
  const setups = {
    "pushurl only": [["remote.origin.pushurl", "https://example.invalid/push.git"], NO_URL, true],
    "fetch only": [["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], NO_URL, true],
    "empty url": [["remote.origin.url", ""], NO_URL, true],
    "branch remote only": [["branch.feature.remote", "origin"], NO_URL, false],
    "url is the checkout": [["remote.origin.url", "."], LOCAL_PATH, false],
    "url is the directory origin": [["remote.origin.url", "origin"], LOCAL_PATH, false],
  };
  for (const [what, [[key, value], refusal, namesOrigin]] of Object.entries(setups)) {
    sh(dir, "config", key, value);
    if (namesOrigin) {
      assert.equal(sh(dir, "remote", "get-url", "--", "origin"), "origin", what);
      assert.match(sh(dir, "ls-remote", "--symref", "origin", "HEAD"), new RegExp(`^${planted.sha}\tHEAD$`, "m"), what);
    }
    for (const allowLocalRemote of [false, true]) {
      assert.deepEqual(readDefaultBranchConfig({ git: makeGit(dir), allowLocalRemote }), refusal, `${what} ${allowLocalRemote}`);
    }
    sh(dir, "config", "--unset-all", key);
  }
  assert.equal(hasDefaultRef(dir), false);
});

test("an absolute local path is read only when allowLocalRemote is exactly true", (t) => {
  const { origin, clone } = fixtureClone(t);
  const git = makeGit(clone);
  for (const allowLocalRemote of [undefined, false, 1, "true", {}]) {
    assert.deepEqual(readDefaultBranchConfig({ git, allowLocalRemote }), LOCAL_PATH, String(allowLocalRemote));
  }
  assert.equal(hasDefaultRef(clone), false);
  const result = readDefaultBranchConfig({ git, allowLocalRemote: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sha, origin.sha);
});

test("a file URL is refused even with allowLocalRemote", (t) => {
  const { origin, clone } = fixtureClone(t);
  sh(clone, "remote", "set-url", "origin", pathToFileURL(origin.dir).href);
  assert.deepEqual(
    readDefaultBranchConfig({ git: makeGit(clone), allowLocalRemote: true }),
    { ok: false, reason: "origin's URL uses the file scheme, not a network one" },
  );
});

test("with origin configured, a directory named origin in the working tree is not read", (t) => {
  const { origin, clone } = fixtureClone(t);
  const planted = configRepo(t, true);
  sh(clone, "clone", "-q", "--bare", planted.dir, "origin");
  writeFile(join(clone, "origin"), "refs/heads/release/1.x", `${planted.sha}\n`);
  sh(clone, "add", "-A");
  sh(clone, "commit", "-q", "-m", "carry a remote");
  mkdirSync(join(clone, "sub"));
  assert.match(sh(clone, "ls-remote", "--", "./origin", "refs/heads/release/1.x"), new RegExp(`^${planted.sha}\t`));
  for (const cwd of [clone, join(clone, "sub")]) {
    const result = readDefaultBranchConfig({ git: makeGit(cwd), allowLocalRemote: true });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.sha, origin.sha);
    assert.equal(result.config.agents.commitAndPush, false);
  }
});

test("a working directory inside a bare repository committed on a branch is refused, not adopted as the repository", (t) => {
  // The planted repository's own config names its origin. In use that would
  // be a network URL its author controls; here it is a local repository read
  // under allowLocalRemote, since the tests have no network.
  const target = configRepo(t, true);
  const { dir } = branchCarryingRemote(t, "vendor.git", { "remote.origin.url": target.dir });
  const inside = join(dir, "vendor.git");
  assert.equal(sh(inside, "remote", "get-url", "--", "origin"), target.dir);
  for (const cwd of [inside, join(inside, "refs")]) {
    const result = readDefaultBranchConfig({ git: makeGit(cwd), allowLocalRemote: true });
    assert.equal(result.ok, false, cwd);
    assert.match(result.reason, /^could not identify the working directory's repository: .*cannot use bare repository/s, cwd);
  }
  assert.equal(hasDefaultRef(inside), false);
});

test("an origin URL that insteadOf rewrites to a local path, at once or on a second pass, is refused", (t) => {
  const { clone } = fixtureClone(t);
  const planted = configRepo(t, true);
  const git = makeGit(clone);
  sh(clone, "remote", "set-url", "origin", "https://example.invalid/once.git");
  sh(clone, "config", `url.${planted.dir}.insteadOf`, "https://example.invalid/once.git");
  assert.equal(sh(clone, "remote", "get-url", "--", "origin"), planted.dir);
  assert.deepEqual(readDefaultBranchConfig({ git }), LOCAL_PATH);

  sh(clone, "remote", "set-url", "origin", "https://example.invalid/twice.git");
  sh(clone, "config", "url.ssh://example.invalid/b.git.insteadOf", "https://example.invalid/twice.git");
  sh(clone, "config", "--replace-all", `url.${planted.dir}.insteadOf`, "ssh://example.invalid/b.git");
  assert.equal(sh(clone, "remote", "get-url", "--", "origin"), "ssh://example.invalid/b.git");
  assert.equal(sh(clone, "ls-remote", "--get-url", "--", "ssh://example.invalid/b.git"), planted.dir);
  assert.deepEqual(
    readDefaultBranchConfig({ git, allowLocalRemote: true }),
    { ok: false, reason: "origin's URL is rewritten again by a url.<base>.insteadOf setting" },
  );
  assert.equal(hasDefaultRef(clone), false);
});

test("ls-remote and fetch are given origin's checked URL after --, never the name origin", (t) => {
  const { origin, clone } = fixtureClone(t);
  const real = makeGit(clone);
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return real(args);
  };
  assert.equal(readDefaultBranchConfig({ git, allowLocalRemote: true }).sha, origin.sha);
  const url = sh(clone, "remote", "get-url", "--", "origin");
  const top = sh(clone, "rev-parse", "--show-toplevel");
  assert.deepEqual(calls.slice(0, 8), [
    ["rev-parse", "--is-bare-repository"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--absolute-git-dir"],
    ["-C", top, "rev-parse", "--absolute-git-dir"],
    ["config", "--get", "remote.origin.url"],
    ["remote", "get-url", "--", "origin"],
    ["ls-remote", "--get-url", "--", url],
    ["ls-remote", "--symref", "--", url, "HEAD"],
  ]);
  assert.deepEqual(calls.find((args) => args[0] === "fetch"), ["fetch", "--no-tags", "--quiet", "--", url, `+refs/heads/release/1.x:${DEFAULT_REF}`]);
  assert.equal(calls.filter((args) => args.includes("origin")).length, 1);
});

test("makeGit refuses to discover a bare repository", (t) => {
  const { dir } = branchCarryingRemote(t, "vendor.git");
  assert.throws(() => makeGit(join(dir, "vendor.git"))(["rev-parse", "--git-dir"]), /cannot use bare repository/);
  assert.match(String(makeGit(join(dir, "sub"))(["rev-parse", "--show-toplevel"])), /checkout/);
});

test("checkRemoteUrl accepts a network URL, and a local path only when absolute and allowLocalRemote is true", () => {
  const network = [
    "https://example.invalid/o/r.git", "http://example.invalid/o/r.git", "ssh://git@example.invalid/o/r.git",
    "git://example.invalid/o/r.git", "git+ssh://example.invalid/o/r.git", "ssh+git://example.invalid/o/r.git",
    "git@example.invalid:o/r.git", "example.invalid:o/my r.git", "git@example.invalid:/srv/r.git", "ab:r.git",
  ];
  for (const url of network) {
    assert.deepEqual(checkRemoteUrl(url), { ok: true }, url);
    assert.deepEqual(checkRemoteUrl(url, { allowLocalRemote: true }), { ok: true }, url);
  }
  const refused = {
    "": "is missing",
    origin: "is a local path",
    "upstream.git": "is a local path",
    "./upstream.git": "is a local path",
    "../upstream.git": "is a local path",
    "sub/dir:r.git": "is a local path",
    "sub\\dir:r.git": "is a local path",
    "C:r.git": "is a local path",
    "C:/r.git": "is a local path",
    ":r.git": "is a local path",
    "file:///srv/r.git": "uses the file scheme, not a network one",
    "ftp://example.invalid/r.git": "uses the ftp scheme, not a network one",
    "HTTPS://example.invalid/r.git": "uses the HTTPS scheme, not a network one",
    "ext::sh -c true": "names a remote helper",
    "fd::7": "names a remote helper",
    "example.invalid::r.git": "names a remote helper",
    "-oProxyCommand=x:r.git": "starts with a dash",
    "-/r.git": "starts with a dash",
    "https://example.invalid/r.git\nfile:///srv/r.git": "holds a control character",
    "git@example.invalid:r.git\t": "holds a control character",
    "https://example.invalid/r\u0000.git": "holds a control character",
    "https://example.invalid/r\u007f.git": "holds a control character",
  };
  for (const [url, why] of Object.entries(refused)) {
    for (const options of [undefined, { allowLocalRemote: true }]) {
      assert.deepEqual(checkRemoteUrl(url, options), { ok: false, reason: `origin's URL ${why}` }, JSON.stringify(url));
    }
  }
  for (const url of ["/srv/r.git", "/srv/a:b.git", "//srv/r.git"]) {
    assert.deepEqual(checkRemoteUrl(url), LOCAL_PATH, url);
    assert.deepEqual(checkRemoteUrl(url, { allowLocalRemote: false }), LOCAL_PATH, url);
    assert.deepEqual(checkRemoteUrl(url, { allowLocalRemote: true }), { ok: true }, url);
  }
  for (const url of [undefined, null, 7, ["https://example.invalid/r.git"]]) {
    assert.deepEqual(checkRemoteUrl(url), { ok: false, reason: "origin's URL is missing" }, String(url));
  }
});

// --- readOriginRepository ------------------------------------------------------

const VIEW = ["repo", "view", "--json", "nameWithOwner"];

/** A fake gh whose `gh repo view` answers `answer` (a string, or a function that throws); records each call. */
function fakeGh(answer) {
  const calls = [];
  return {
    calls,
    cli(args) {
      calls.push(args);
      assert.deepEqual(args, VIEW);
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

const viewOf = (nameWithOwner) => JSON.stringify({ nameWithOwner });

/** A repository with `origin` at `url` (no other remote). */
function repoWithOrigin(t, url) {
  const { dir } = repoWith(t, { "README.md": "x\n" });
  sh(dir, "remote", "add", "origin", url);
  return dir;
}

test("readOriginRepository confirms an https origin against gh repo view, ignoring case, and answers gh's spelling", (t) => {
  for (const url of [
    "https://github.com/Octo-Org/Repo.git",
    "https://github.com/octo-org/repo",
    "https://github.com/octo-org/repo/",
    "https://x-access-token@github.com/octo-org/repo.git",
  ]) {
    const gh = fakeGh(viewOf("octo-org/repo"));
    const result = readOriginRepository({ git: makeGit(repoWithOrigin(t, url)), gh });
    assert.deepEqual(result, { ok: true, owner: "octo-org", name: "repo", slug: "octo-org/repo" }, url);
    assert.equal(gh.calls.length, 1, url);
  }
  const gh = fakeGh(viewOf("Octo-Org/Repo"));
  assert.equal(readOriginRepository({ git: makeGit(repoWithOrigin(t, "https://github.com/octo-org/repo.git")), gh }).slug, "Octo-Org/Repo");
});

test("readOriginRepository reads the ssh forms of origin, including a host alias and a port", (t) => {
  for (const url of [
    "git@github.com:octo-org/repo.git",
    "github.com:octo-org/repo",
    "github-work:octo-org/repo.git",
    "ssh://git@github.com/octo-org/repo.git",
    "ssh://git@ssh.github.com:443/octo-org/repo/",
  ]) {
    const result = readOriginRepository({ git: makeGit(repoWithOrigin(t, url)), gh: fakeGh(viewOf("octo-org/repo")) });
    assert.deepEqual(result, { ok: true, owner: "octo-org", name: "repo", slug: "octo-org/repo" }, url);
  }
});

test("readOriginRepository refuses when gh repo view names another repository", (t) => {
  const git = makeGit(repoWithOrigin(t, "https://github.com/octo-org/repo.git"));
  for (const other of ["octo-org/repo2", "other-org/repo", "octo-org/rep"]) {
    assert.deepEqual(readOriginRepository({ git, gh: fakeGh(viewOf(other)) }), {
      ok: false,
      reason: `gh repo view names ${other} but origin names octo-org/repo; refusing to mix two repositories`,
    });
  }
});

test("readOriginRepository with a second remote: refused when gh resolves to it, confirmed when gh resolves to origin", (t) => {
  const dir = repoWithOrigin(t, "git@github.com:octo-org/repo.git");
  sh(dir, "remote", "add", "upstream", "https://github.com/upstream-org/repo.git");
  const git = makeGit(dir);
  assert.deepEqual(readOriginRepository({ git, gh: fakeGh(viewOf("upstream-org/repo")) }), {
    ok: false,
    reason: "gh repo view names upstream-org/repo but origin names octo-org/repo; refusing to mix two repositories",
  });
  assert.equal(readOriginRepository({ git, gh: fakeGh(viewOf("octo-org/repo")) }).ok, true);
});

test("readOriginRepository refuses a missing or local origin without asking gh", (t) => {
  const gh = fakeGh(viewOf("octo-org/repo"));
  const { dir } = repoWith(t, { "README.md": "x\n" });
  assert.deepEqual(readOriginRepository({ git: makeGit(dir), gh }), NO_URL);
  sh(dir, "remote", "add", "origin", dir);
  assert.deepEqual(readOriginRepository({ git: makeGit(dir), gh }), LOCAL_PATH);
  sh(dir, "remote", "set-url", "origin", "octo-org/repo");
  assert.deepEqual(readOriginRepository({ git: makeGit(dir), gh }), LOCAL_PATH);
  assert.deepEqual(gh.calls, []);
});

test("readOriginRepository refuses an origin URL that does not name one GitHub repository, without asking gh", (t) => {
  const gh = fakeGh(viewOf("octo-org/repo"));
  const dir = repoWithOrigin(t, NETWORK_URL);
  for (const url of [
    "http://github.com/octo-org/repo.git",
    "git://github.com/octo-org/repo.git",
    "ssh+git://github.com/octo-org/repo.git",
    "https://github.com/octo-org",
    "https://github.com/octo-org/repo/tree",
    "https://github.com/octo-org/../repo",
    "https://github.com/../repo",
    "https://github.com/octo-org/..",
    "https://github.com/octo-org/repo.git?x=1",
    "https://github.com/octo-org/re%2Fpo",
    "https://github.com/-octo/repo",
    "git@github.com:/octo-org/repo.git",
    "git@github.com:octo-org/repo/x.git",
    "ssh://github.com/octo-org",
    "https://github.com//repo",
  ]) {
    sh(dir, "remote", "set-url", "origin", url);
    assert.deepEqual(readOriginRepository({ git: makeGit(dir), gh }), {
      ok: false,
      reason: "origin's URL does not name a GitHub repository as https://host/owner/name, ssh://host/owner/name or host:owner/name",
    }, url);
  }
  assert.deepEqual(gh.calls, []);
});

test("readOriginRepository refuses when gh repo view fails or answers garbage", (t) => {
  const git = makeGit(repoWithOrigin(t, "https://github.com/octo-org/repo.git"));
  const answers = {
    "gh repo view: exited 1: not a git repository": () => { throw new CallError("gh repo view: exited 1: not a git repository"); },
    "not JSON": "not JSON",
    null: "null",
    "no field": "{}",
    "not a slug": viewOf("octo-org"),
    "a number": viewOf(7),
  };
  for (const [what, answer] of Object.entries(answers)) {
    const result = readOriginRepository({ git, gh: fakeGh(answer) });
    assert.equal(result.ok, false, what);
    assert.match(result.reason, /^could not read gh repo view: /, what);
  }
  assert.match(readOriginRepository({ git, gh: fakeGh(answers[Object.keys(answers)[0]]) }).reason, /exited 1: not a git repository$/);
});

test("readOriginRepository refuses when git fails after naming origin", () => {
  const named = networkOrigin(() => assert.fail("unexpected git call"), "https://github.com/octo-org/repo.git");
  const git = (args) => (args[0] === "ls-remote" ? (() => { throw new Error("git broke"); })() : named(args));
  assert.deepEqual(readOriginRepository({ git, gh: fakeGh(viewOf("octo-org/repo")) }), {
    ok: false,
    reason: "could not read origin's URL: git broke",
  });
});

test("readOriginRepository uses the working directory's repository and a real gh by default", (t) => {
  const { dir } = repoWith(t, { "README.md": "x\n" });
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(cwd));
  assert.deepEqual(readOriginRepository(), NO_URL);
});

// --- the working directory must be inside an ordinary checkout -----------------

/** A git runner like makeGit without safe.bareRepository, as git before 2.38 behaves. */
function gitWithoutBareGuard(cwd) {
  return (args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${devNull}`, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}: ${String(result.stderr).trim()}`);
    return result.stdout;
  };
}

/**
 * A clone of an origin that says false, on a branch that commits under pkg/ a
 * directory laid out as a git directory whose config points origin at `url`
 * (default: pkg/src.git, a committed bare clone of a repository that says
 * true), either bare or naming the checkout as its work tree.
 */
function branchCarryingGitDir(t, { bare, url }) {
  const { origin, clone } = fixtureClone(t);
  const planted = configRepo(t, true);
  sh(clone, "clone", "-q", "--bare", planted.dir, "pkg/src.git");
  writeFile(join(clone, "pkg/src.git"), "refs/heads/main", `${planted.sha}\n`);
  writeFile(clone, "pkg/HEAD", "ref: refs/heads/main\n");
  writeFile(clone, "pkg/objects/info/.keep", "");
  writeFile(clone, "pkg/refs/heads/.keep", "");
  const core = bare ? "\tbare = true\n" : "\tbare = false\n\tworktree = ..\n";
  writeFile(clone, "pkg/config", `[core]\n\trepositoryformatversion = 0\n${core}[remote "origin"]\n\turl = ${url ?? "./src.git"}\n`);
  sh(clone, "add", "-A");
  sh(clone, "commit", "-q", "-m", "carry a git directory");
  return { origin, clone, planted };
}

test("a git directory committed under pkg/ is not taken as the repository when the working directory is inside it", (t) => {
  const { origin, clone, planted } = branchCarryingGitDir(t, { bare: true });
  assert.match(sh(join(clone, "pkg"), "ls-remote", "--symref", "origin", "HEAD"), new RegExp(`^${planted.sha}\tHEAD$`, "m"));
  for (const cwd of [join(clone, "pkg"), join(clone, "pkg/refs/heads")]) {
    const result = readDefaultBranchConfig({ git: makeGit(cwd) });
    assert.equal(result.ok, false, cwd);
    assert.match(result.reason, /^could not identify the working directory's repository: .*cannot use bare repository/s, cwd);
  }
  assert.equal(readDefaultBranchConfig({ git: makeGit(clone), allowLocalRemote: true }).sha, origin.sha);
});

test("on a git that adopts a bare repository it finds, a bare layout is refused as not a checkout", (t) => {
  const { clone } = branchCarryingGitDir(t, { bare: true, url: configRepo(t, true).dir });
  assert.equal(sh(join(clone, "pkg"), "rev-parse", "--is-bare-repository"), "true");
  for (const cwd of [join(clone, "pkg"), join(clone, "pkg/refs/heads")]) {
    assert.deepEqual(
      readDefaultBranchConfig({ git: gitWithoutBareGuard(cwd), allowLocalRemote: true }),
      { ok: false, reason: "the working directory is inside a bare repository, not a checkout" },
      cwd,
    );
  }
});

test("on a git that adopts a git directory it finds, one naming the checkout as its work tree is refused", (t) => {
  const target = configRepo(t, true);
  const { clone, origin } = branchCarryingGitDir(t, { bare: false, url: target.dir });
  const inside = join(clone, "pkg");
  assert.equal(sh(inside, "rev-parse", "--is-bare-repository"), "false");
  assert.equal(sh(inside, "remote", "get-url", "--", "origin"), target.dir);
  assert.deepEqual(
    readDefaultBranchConfig({ git: gitWithoutBareGuard(inside), allowLocalRemote: true }),
    { ok: false, reason: "the working directory's git directory is not the one its checkout's top level uses" },
  );
  const worktree = join(tempDir(t), "worktree");
  sh(clone, "worktree", "add", "-q", worktree, "-b", "other");
  assert.equal(readDefaultBranchConfig({ git: gitWithoutBareGuard(worktree), allowLocalRemote: true }).sha, origin.sha);
});

test("the repository checks refuse answers they cannot confirm", () => {
  const cases = {
    "is-bare says true": [{ "rev-parse --is-bare-repository": "true" }, "the working directory is inside a bare repository, not a checkout"],
    "is-bare says garbage": [{ "rev-parse --is-bare-repository": "maybe" }, "the working directory is inside a bare repository, not a checkout"],
    // An empty -C leaves git where it is, so it is answered as the same git directory: only the empty check refuses.
    "empty top level": [{ "rev-parse --show-toplevel": "", "-C  rev-parse --absolute-git-dir": `${TOP}/.git` },
      "the working directory's git directory is not the one its checkout's top level uses"],
    "other git dir from the top": [{ [`-C ${TOP} rev-parse --absolute-git-dir`]: "/elsewhere/.git" },
      "the working directory's git directory is not the one its checkout's top level uses"],
  };
  for (const [what, [overrides, reason]] of Object.entries(cases)) {
    const base = networkOrigin(() => assert.fail(`${what}: unexpected git call`));
    const git = (args) => {
      const key = args.join(" ");
      return Object.hasOwn(overrides, key) ? `${overrides[key]}\n` : base(args);
    };
    assert.deepEqual(readDefaultBranchConfig({ git }), { ok: false, reason }, what);
    assert.deepEqual(readOriginRepository({ git, gh: fakeGh(viewOf("owner/repo")) }), { ok: false, reason }, what);
  }
  const broken = (args) => (args[0] === "rev-parse" ? (() => { throw new Error("git broke"); })() : assert.fail());
  assert.deepEqual(readDefaultBranchConfig({ git: broken }), {
    ok: false,
    reason: "could not identify the working directory's repository: git broke",
  });
});

test("started as its own process with every default, the reader refuses a committed origin directory and a committed git directory", (t) => {
  const script = [
    `import { readDefaultBranchConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../scripts/lib/config.mjs")).href)};`,
    "process.stdout.write(JSON.stringify(readDefaultBranchConfig()));",
  ].join("\n");
  const run = (cwd) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env: isolatedEnv(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const { dir } = branchCarryingRemote(t);
  assert.deepEqual(run(dir), NO_URL);
  assert.deepEqual(run(join(dir, "sub")), NO_URL);
  const { clone } = branchCarryingGitDir(t, { bare: true });
  const inside = run(join(clone, "pkg"));
  assert.equal(inside.ok, false);
  assert.match(inside.reason, /^could not identify the working directory's repository: .*cannot use bare repository/s);
  assert.deepEqual(run(clone), LOCAL_PATH);
});
