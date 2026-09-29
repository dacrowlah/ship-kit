import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_REF, MAX_CONFIG_BYTES, SCHEMA_VERSION, SEATS, loadConfig, makeGit, readConfigAt,
  readDefaultBranchConfig, seatModel, semanticErrors, strictConfig,
} from "../../scripts/lib/config.mjs";

const SHIP_KIT = { version: "0.2.0", sha: "0123456789abcdef0123456789abcdef01234567" };
// The pressure-test model: the one line of the pin file, without its newline.
const PIN = readFileSync(new URL("../skills/pinned-model.txt", import.meta.url), "utf8").replace(/\n$/, "");
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
  assert.equal(config.review.model, PIN);
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

test("strictConfig carries the pinned review.model, and every seat resolves to it", () => {
  const strict = strictConfig();
  assert.equal(strict.review.model, PIN);
  for (const seat of SEATS) assert.equal(seatModel(strict, seat), PIN, seat);
  strict.review.model = "changed";
  assert.equal(strictConfig().review.model, PIN);
});

// --- review.model and seatModel ------------------------------------------

test("review.model accepts a model id and the id the seat key accepts", () => {
  for (const model of ["claude-opus-4-1[1m]", "a", "a".repeat(100), "claude-opus-5-5", "x.y_z-1"]) {
    const result = load(minimal({ review: { model } }));
    assert.equal(result.ok, true, `${model}: ${result.reason}`);
    assert.equal(result.config.review.model, model);
  }
});

test("review.model of a space, an empty string and 101 characters is rejected", () => {
  for (const model of ["a b", "", "a".repeat(101)]) {
    const result = load(minimal({ review: { model } }));
    assert.equal(result.ok, false, `${JSON.stringify(model)} was accepted`);
    assert.match(result.reason, /\/review\/model must match pattern/);
  }
});

test("review.model rejects null, non-strings, a trailing newline, non-ASCII and shell metacharacters", () => {
  for (const model of [null, 42, true, ["claude-opus-5-5"], {}, "claude-opus-5-5\n", "\nclaude", "claude\u00e9", "a;b", "$(x)", "a`b`", "a'b", 'a"b', "a/b", "a=b", "a\tb", "a\u0000b"]) {
    const result = load(minimal({ review: { model } }));
    assert.equal(result.ok, false, `${JSON.stringify(model)} was accepted`);
    assert.match(result.reason, /\/review\/model /);
  }
});

test("a seat's model keeps its type: null or a model id, never an empty string", () => {
  for (const model of [null, "claude-opus-4-1[1m]"]) {
    assert.equal(load(minimal({ review: { seats: { general: { model } } } })).ok, true, String(model));
  }
  for (const model of ["", "a b", "a".repeat(101), 7]) {
    assert.equal(load(minimal({ review: { seats: { general: { model } } } })).ok, false, JSON.stringify(model));
  }
});

test("seatModel returns the seat's own model when set", () => {
  const { config } = load(minimal({ review: { model: "review-wide", seats: { general: { model: "general-own" }, adversarial: { model: "adversarial-own" } } } }));
  assert.equal(seatModel(config, "general"), "general-own");
  assert.equal(seatModel(config, "adversarial"), "adversarial-own");
});

test("seatModel returns review.model when the seat's own model is null", () => {
  const { config } = load(minimal({ review: { model: "review-wide", seats: { general: { model: "general-own" } } } }));
  assert.equal(config.review.seats.security.model, null);
  assert.equal(seatModel(config, "security"), "review-wide");
  assert.equal(seatModel(config, "test-integrity"), "review-wide");
  assert.equal(seatModel(config, "adversarial"), "review-wide");
});

test("seatModel returns review.model when the seat is absent from review.seats", () => {
  const { config } = load(minimal({ review: { model: "review-wide" } }));
  delete config.review.seats.security;
  assert.equal(seatModel(config, "security"), "review-wide");
  assert.equal(seatModel(config, "not-a-seat"), "review-wide");
  assert.equal(seatModel(config, "constructor"), "review-wide");
  assert.equal(seatModel(config, "__proto__"), "review-wide");
  assert.equal(seatModel(config, undefined), "review-wide");
});

test("seatModel on an otherwise empty config is the pin for every seat", () => {
  const { config } = load(minimal());
  for (const seat of SEATS) assert.equal(seatModel(config, seat), PIN, seat);
});

test("seatModel never returns null or an empty string for a loaded or strict config", () => {
  const configs = [
    load(minimal()).config,
    load(minimal({ review: { seats: { general: { model: null }, adversarial: { model: "own" } } } })).config,
    strictConfig(),
  ];
  for (const config of configs) {
    for (const seat of [...SEATS, "other"]) {
      const model = seatModel(config, seat);
      assert.equal(typeof model, "string", seat);
      assert.match(model, /^[A-Za-z0-9._\[\]-]{1,100}$/, seat);
    }
  }
});

test("seatModel refuses a config that did not come from the loader", () => {
  const { config } = load(minimal());
  const withSeat = (model) => ({ review: { model: PIN, seats: { general: { model } } } });
  const cases = [
    ["a seat model that is an empty string", withSeat("")],
    ["a seat model with a space", withSeat("a b")],
    ["a seat model of 101 characters", withSeat("a".repeat(101))],
    ["a seat model that is not a string", withSeat(7)],
    ["a missing review.model", { review: { seats: {} } }],
    ["a null review.model", { review: { model: null, seats: {} } }],
    ["an empty review.model", { review: { model: "", seats: {} } }],
    ["a review.model with a newline", { review: { model: "a\nb", seats: {} } }],
    ["a config without review", {}],
    ["null", null],
  ];
  for (const [label, bad] of cases) assert.throws(() => seatModel(bad, "general"), (err) => err instanceof Error, label);
  assert.equal(seatModel(config, "general"), PIN);
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

/** An origin whose default branch is release/1.x (commitAndPush false), and a clone on a local branch that says true. */
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

test("readDefaultBranchConfig reads origin's default branch, not the local branch or working tree", (t) => {
  const { origin, clone } = fixtureClone(t);
  const result = readDefaultBranchConfig({ git: makeGit(clone) });
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
  const result = readDefaultBranchConfig({ git: makeGit(clone) });
  assert.equal(result.config.agents.commitAndPush, true);
  assert.equal(result.sha, sh(origin.dir, "rev-parse", "HEAD"));
});

test("readDefaultBranchConfig uses the working directory's repository by default", (t) => {
  const { clone } = fixtureClone(t);
  const cwd = process.cwd();
  process.chdir(clone);
  t.after(() => process.chdir(cwd));
  assert.equal(readDefaultBranchConfig().config.agents.commitAndPush, false);
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
  const result = readDefaultBranchConfig({ git: makeGit(clone) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sha, origin.sha);
  assert.equal(result.config.agents.commitAndPush, false);
});

test("readDefaultBranchConfig passes the path through", (t) => {
  const { clone } = fixtureClone(t);
  assert.equal(readDefaultBranchConfig({ git: makeGit(clone), path: "other.json" }).reason, `other.json is absent at ${DEFAULT_REF}`);
});

test("readDefaultBranchConfig: ls-remote failure is not ok", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  const git = (args) => (args[0] === "ls-remote" ? (() => { throw new Error("network down"); })() : real(args));
  const result = readDefaultBranchConfig({ git });
  assert.equal(result.ok, false);
  assert.match(result.reason, /network down/);
  assert.equal(Object.hasOwn(result, "branch"), false);
});

test("readDefaultBranchConfig: an origin with no default branch is not ok", () => {
  for (const out of ["", "abc\tHEAD\n", "ref: refs/tags/x\tHEAD\n", "ref: refs/heads/a\tHEAD\nref: refs/heads/b\tHEAD\n"]) {
    const result = readDefaultBranchConfig({ git: () => out });
    assert.match(result.reason, /does not name its default branch/, JSON.stringify(out));
  }
});

test("readDefaultBranchConfig: fetch failure is not ok", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  const git = (args) => (args[0] === "fetch" ? (() => { throw new Error("fetch refused"); })() : real(args));
  const result = readDefaultBranchConfig({ git });
  assert.equal(result.ok, false);
  assert.equal(result.branch, "release/1.x");
  assert.match(result.reason, /fetch refused/);
});

test("readDefaultBranchConfig: an invalid branch name is not ok and is never fetched", (t) => {
  const { clone } = fixtureClone(t);
  const real = makeGit(clone);
  for (const name of ["-x", "a..b", "a b", "@{-1}", "x.lock"]) {
    const git = (args) => {
      if (args[0] === "ls-remote") return `ref: refs/heads/${name}\tHEAD\n`;
      if (args[0] === "fetch") assert.fail(`fetched ${name}`);
      return real(args);
    };
    const result = readDefaultBranchConfig({ git });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /is not a valid branch name/, name);
  }
});

test("readDefaultBranchConfig: check-ref-format rewriting the name is refused", () => {
  const git = (args) => {
    if (args[0] === "ls-remote") return "ref: refs/heads/main\tHEAD\n";
    if (args[0] === "check-ref-format") return "other\n";
    return assert.fail(`unexpected git ${args[0]}`);
  };
  assert.match(readDefaultBranchConfig({ git }).reason, /is not a valid branch name/);
});

test("readDefaultBranchConfig: a leading dash is refused even when check-ref-format accepts it", () => {
  const git = (args) => {
    if (args[0] === "ls-remote") return "ref: refs/heads/-x\tHEAD\n";
    if (args[0] === "check-ref-format") return `${args.at(-1)}\n`;
    return assert.fail(`unexpected git ${args[0]}`);
  };
  assert.match(readDefaultBranchConfig({ git }).reason, /"-x" is not a valid branch name/);
});
