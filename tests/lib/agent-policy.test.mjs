import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { decide, isMain, main, readOriginDefaultBranchConfig } from "../../scripts/lib/agent-policy.mjs";
import { DEFAULT_REF, makeGit, strictConfig } from "../../scripts/lib/config.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/lib/agent-policy.mjs", import.meta.url));
const CONFIG_PATH = ".ship-kit/config.json";
const SHIP_KIT = { version: "0.2.0", sha: "0123456789abcdef0123456789abcdef01234567" };

const configText = (agents) =>
  `${JSON.stringify({ schemaVersion: 1, shipKit: SHIP_KIT, ...(agents === undefined ? {} : { agents }) }, null, 2)}\n`;
const GRANTED = configText({ commitAndPush: true, adminMerge: true });
const DENIED = configText({ commitAndPush: false, adminMerge: false });

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-agent-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fixture git: no user or system config, no signing, fixed identity.
const FIXTURE_GIT_ENV = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
function sh(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...FIXTURE_GIT_ENV },
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

/**
 * An origin whose default branch holds `origin` at the config path (no config
 * file at all when `origin` is undefined), and a clone whose current branch,
 * local copy of the default branch and working tree all say `local`.
 */
function scenario(t, { origin, local = GRANTED, branch = "main", dirty } = {}) {
  const originRepo = repoWith(t, origin === undefined ? { "README.md": "no config\n" } : { [CONFIG_PATH]: origin }, branch);
  const clone = join(tempDir(t), "clone");
  sh(dirname(clone), "clone", "-q", originRepo.dir, clone);
  sh(clone, "checkout", "-q", "-b", "feature");
  writeFile(clone, CONFIG_PATH, local);
  sh(clone, "add", CONFIG_PATH);
  sh(clone, "commit", "-q", "--allow-empty", "-m", "local branch commit");
  sh(clone, "branch", "-f", branch, "feature");
  if (dirty !== undefined) writeFile(clone, CONFIG_PATH, dirty);
  return { origin: originRepo, clone };
}

/** Runs main in this process against `clone` (or the given deps) and captures its streams. */
function run(args, clone, deps = { readDefaultBranchConfig: () => readOriginDefaultBranchConfig({ git: makeGit(clone) }) }) {
  const out = [];
  const err = [];
  const io = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } };
  const code = main(args, deps, io);
  return { code, out: out.join(""), err: err.join("") };
}

/** The one word main printed; asserts the whole contract of a normal answer. */
function word(clone, ...args) {
  const result = run(args, clone);
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.match(result.out, /^(proceed|ask|refuse)\n$/);
  return result.out.trim();
}

/** The two answers for one scenario: the commit-and-push question and the admin question. */
const answers = (clone) => ({ plain: word(clone), admin: word(clone, "--admin") });

// --- the settings, read from the origin's default branch -------------------

test("true proceeds", (t) => {
  const { clone } = scenario(t, { origin: GRANTED, local: DENIED });
  assert.deepEqual(answers(clone), { plain: "proceed", admin: "proceed" });
});

test("false asks", (t) => {
  const { clone } = scenario(t, { origin: DENIED });
  assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" });
});

test("absent config asks", (t) => {
  const { clone } = scenario(t, { origin: undefined });
  assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" });
});

test("a valid config that leaves the settings out takes the schema defaults", (t) => {
  for (const origin of [configText(undefined), configText({})]) {
    const { clone } = scenario(t, { origin, local: DENIED });
    assert.deepEqual(answers(clone), { plain: "proceed", admin: "refuse" }, origin);
  }
});

test("invalid config asks", (t) => {
  const invalid = {
    "not JSON": "{ commitAndPush: true",
    "empty file": "",
    "a JSON array": "[true]",
    "a string value for the setting": configText({ commitAndPush: "true", adminMerge: "true" }),
    "an unknown agents key beside a true one": configText({ commitAndPush: true, adminMerge: true, bogus: true }),
    "a schema version from a newer ship-kit": JSON.stringify({ schemaVersion: 2, shipKit: SHIP_KIT, agents: { commitAndPush: true, adminMerge: true } }),
    "a missing schemaVersion": JSON.stringify({ shipKit: SHIP_KIT, agents: { commitAndPush: true, adminMerge: true } }),
    "a second config-level violation beside true settings": JSON.stringify({ schemaVersion: 1, shipKit: SHIP_KIT, agents: { commitAndPush: true, adminMerge: true }, render: { seats: ["general", "general"] } }),
  };
  for (const [name, origin] of Object.entries(invalid)) {
    const { clone } = scenario(t, { origin });
    assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" }, name);
  }
});

test("a config path that is not a regular file asks", (t) => {
  const originRepo = repoWith(t, { "real.json": GRANTED });
  mkdirSync(join(originRepo.dir, ".ship-kit"));
  symlinkSync("../real.json", join(originRepo.dir, CONFIG_PATH));
  sh(originRepo.dir, "add", "-A");
  sh(originRepo.dir, "commit", "-q", "-m", "config is a symlink");
  const clone = join(tempDir(t), "clone");
  sh(dirname(clone), "clone", "-q", originRepo.dir, clone);
  assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" });
});

test("a branch-local edit to true is ignored when the origin default says false", (t) => {
  const committed = scenario(t, { origin: DENIED, local: GRANTED });
  assert.deepEqual(answers(committed.clone), { plain: "ask", admin: "refuse" });
  const uncommitted = scenario(t, { origin: DENIED, local: DENIED, dirty: GRANTED });
  assert.equal(readFileSync(join(uncommitted.clone, CONFIG_PATH), "utf8"), GRANTED);
  assert.deepEqual(answers(uncommitted.clone), { plain: "ask", admin: "refuse" });
});

test("a branch-local edit to false does not revoke what the origin default grants", (t) => {
  const { clone } = scenario(t, { origin: GRANTED, local: DENIED });
  assert.deepEqual(answers(clone), { plain: "proceed", admin: "proceed" });
});

test("a stale private ref that says true is replaced by the fetch, not trusted", (t) => {
  const { origin, clone } = scenario(t, { origin: DENIED, local: GRANTED });
  sh(clone, "update-ref", DEFAULT_REF, sh(clone, "rev-parse", "feature"));
  assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" });
  assert.equal(sh(clone, "rev-parse", DEFAULT_REF), origin.sha);
});

test("each answer reads the origin as it is now", (t) => {
  const { origin, clone } = scenario(t, { origin: DENIED });
  assert.equal(word(clone), "ask");
  writeFile(origin.dir, CONFIG_PATH, GRANTED);
  sh(origin.dir, "commit", "-q", "-am", "granted");
  assert.equal(word(clone), "proceed");
  writeFile(origin.dir, CONFIG_PATH, DENIED);
  sh(origin.dir, "commit", "-q", "-am", "revoked");
  assert.equal(word(clone), "ask");
});

test("failed ls-remote asks", (t) => {
  const { clone } = scenario(t, { origin: GRANTED });
  sh(clone, "update-ref", DEFAULT_REF, sh(clone, "rev-parse", "feature"));
  sh(clone, "remote", "set-url", "origin", join(tempDir(t), "no-such-repository"));
  assert.deepEqual(answers(clone), { plain: "ask", admin: "refuse" });
});

test("failed fetch asks", (t) => {
  const { clone } = scenario(t, { origin: GRANTED, local: GRANTED });
  sh(clone, "update-ref", DEFAULT_REF, sh(clone, "rev-parse", "feature"));
  const real = makeGit(clone);
  const git = (args) => (args[0] === "fetch" ? (() => { throw new Error("fetch refused"); })() : real(args));
  const deps = { readDefaultBranchConfig: () => readOriginDefaultBranchConfig({ git }) };
  assert.equal(run([], clone, deps).out, "ask\n");
  assert.equal(run(["--admin"], clone, deps).out, "refuse\n");
});

test("a default branch with a slash is fetched into refs/ship-kit/default", (t) => {
  const { origin, clone } = scenario(t, { origin: GRANTED, local: DENIED, branch: "release/1.x" });
  assert.deepEqual(answers(clone), { plain: "proceed", admin: "proceed" });
  assert.equal(sh(clone, "rev-parse", DEFAULT_REF), origin.sha);
});

test("no origin remote asks even when a directory named origin holds a config that says true", (t) => {
  const source = repoWith(t, { [CONFIG_PATH]: GRANTED });
  const repo = repoWith(t, { "README.md": "no remote\n" });
  sh(repo.dir, "clone", "-q", "--bare", source.dir, join(repo.dir, "origin"));
  assert.equal(sh(repo.dir, "remote"), "");
  assert.deepEqual(answers(repo.dir), { plain: "ask", admin: "refuse" });
});

test("a directory that is not a repository asks", (t) => {
  const dir = tempDir(t);
  const deps = { readDefaultBranchConfig: () => readOriginDefaultBranchConfig({ git: makeGit(dir) }) };
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
  assert.equal(run([], dir, deps).out, "ask\n");
  assert.equal(run(["--admin"], dir, deps).out, "refuse\n");
});

// --- --admin ----------------------------------------------------------------

test("--admin proceeds only on explicit true", (t) => {
  const grantedAdmin = scenario(t, { origin: configText({ commitAndPush: false, adminMerge: true }) });
  assert.deepEqual(answers(grantedAdmin.clone), { plain: "ask", admin: "proceed" });
  const defaulted = scenario(t, { origin: configText({ commitAndPush: true }) });
  assert.deepEqual(answers(defaulted.clone), { plain: "proceed", admin: "refuse" });
});

test("--admin refuses on false, absent, invalid, unreadable and a branch-local true", (t) => {
  const cases = {
    false: scenario(t, { origin: configText({ commitAndPush: true, adminMerge: false }), local: GRANTED }),
    absent: scenario(t, { origin: undefined, local: GRANTED }),
    invalid: scenario(t, { origin: "{ not json", local: GRANTED }),
    "branch-local true": scenario(t, { origin: DENIED, local: GRANTED, dirty: GRANTED }),
  };
  const unreadable = scenario(t, { origin: GRANTED });
  sh(unreadable.clone, "remote", "set-url", "origin", join(tempDir(t), "no-such-repository"));
  cases.unreadable = unreadable;
  for (const [name, { clone }] of Object.entries(cases)) {
    assert.equal(word(clone, "--admin"), "refuse", name);
  }
});

test("--admin reads adminMerge, not commitAndPush", (t) => {
  const { clone } = scenario(t, { origin: configText({ commitAndPush: true, adminMerge: false }) });
  assert.equal(word(clone, "--admin"), "refuse");
  assert.equal(word(clone), "proceed");
});

test("without --admin the answer reads commitAndPush, not adminMerge", (t) => {
  const { clone } = scenario(t, { origin: configText({ commitAndPush: false, adminMerge: true }) });
  assert.equal(word(clone), "ask");
  assert.equal(word(clone, "--admin"), "proceed");
});

test("--admin given twice is still the admin question", (t) => {
  const { clone } = scenario(t, { origin: configText({ commitAndPush: true, adminMerge: false }) });
  assert.equal(word(clone, "--admin", "--admin"), "refuse");
});

// --- decide ----------------------------------------------------------------

const grantedResult = (agents) => ({ ok: true, config: { agents } });

test("decide proceeds only on an explicit true from an ok result", () => {
  assert.equal(decide(grantedResult({ commitAndPush: true }), {}), "proceed");
  assert.equal(decide(grantedResult({ commitAndPush: true })), "proceed");
  assert.equal(decide(grantedResult({ adminMerge: true }), { admin: true }), "proceed");
});

test("decide asks, or refuses under --admin, for anything but an explicit true", () => {
  const values = ["true", "yes", 1, [true], {}, null, undefined, false, 0, ""];
  for (const value of values) {
    assert.equal(decide(grantedResult({ commitAndPush: value, adminMerge: value }), {}), "ask", JSON.stringify(value));
    assert.equal(decide(grantedResult({ commitAndPush: value, adminMerge: value }), { admin: true }), "refuse", JSON.stringify(value));
  }
  const results = [
    undefined, null, "proceed", 1, true, [],
    {},
    { ok: false },
    { ok: false, reason: "absent", config: { agents: { commitAndPush: true, adminMerge: true } } },
    { ok: "yes", config: { agents: { commitAndPush: true, adminMerge: true } } },
    { ok: 1, config: { agents: { commitAndPush: true, adminMerge: true } } },
    { ok: true },
    { ok: true, config: null },
    { ok: true, config: {} },
    { ok: true, config: { agents: null } },
    { ok: true, config: { agents: "commitAndPush" } },
    { ok: true, config: { agent: { commitAndPush: true, adminMerge: true } } },
  ];
  for (const result of results) {
    assert.equal(decide(result, {}), "ask", JSON.stringify(result));
    assert.equal(decide(result, { admin: true }), "refuse", JSON.stringify(result));
  }
});

test("decide treats a result that throws when read as unreadable", () => {
  const throwing = { get ok() { throw new Error("boom"); } };
  const throwingConfig = { ok: true, get config() { throw new Error("boom"); } };
  for (const result of [throwing, throwingConfig]) {
    assert.equal(decide(result, {}), "ask");
    assert.equal(decide(result, { admin: true }), "refuse");
  }
});

test("decide takes any truthy admin option as the admin question", () => {
  const onlyCommit = grantedResult({ commitAndPush: true, adminMerge: false });
  for (const admin of [true, "false", "no", 1, {}]) {
    assert.equal(decide(onlyCommit, { admin }), "refuse", JSON.stringify(admin));
  }
  for (const options of [undefined, null, {}, { admin: false }, { admin: 0 }, { admin: "" }, { admin: undefined }]) {
    assert.equal(decide(onlyCommit, options), "proceed", JSON.stringify(options));
  }
});

test("strict defaults never grant either setting", () => {
  const strict = { ok: true, config: strictConfig() };
  assert.equal(decide(strict, {}), "ask");
  assert.equal(decide(strict, { admin: true }), "refuse");
});

// --- main ------------------------------------------------------------------

test("main prints exactly one word, nothing else, and exits 0", (t) => {
  const { clone } = scenario(t, { origin: GRANTED });
  for (const [args, expected] of [[[], "proceed\n"], [["--admin"], "proceed\n"]]) {
    assert.deepEqual(run(args, clone), { code: 0, out: expected, err: "" });
  }
});

test("a reader that throws or answers with garbage asks", () => {
  const cases = {
    throws: () => { throw new Error("no git"); },
    "throws a non-Error": () => { throw "no git"; },
    undefined: () => undefined,
    null: () => null,
    "a string": () => "proceed",
    "a promise": () => Promise.resolve(grantedResult({ commitAndPush: true, adminMerge: true })),
  };
  for (const [name, readDefaultBranchConfig] of Object.entries(cases)) {
    assert.deepEqual(run([], undefined, { readDefaultBranchConfig }), { code: 0, out: "ask\n", err: "" }, name);
    assert.deepEqual(run(["--admin"], undefined, { readDefaultBranchConfig }), { code: 0, out: "refuse\n", err: "" }, name);
  }
});

test("an unknown argument exits 2", () => {
  const deps = { readDefaultBranchConfig: () => assert.fail("read the config for a bad command line") };
  for (const argv of [["--adm"], ["-admin"], ["--admin=true"], ["admin"], ["--help"], [""], ["--admin", "--other"], ["--other", "--admin"], ["--admin", "extra"]]) {
    const result = run(argv, undefined, deps);
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.equal(result.out, "", JSON.stringify(argv));
    assert.match(result.err, /^unknown argument .*\nusage: agent-policy\.mjs \[--admin\]\n$/s, JSON.stringify(argv));
  }
});

test("an unknown argument is reported with control characters escaped", () => {
  const result = run(["\u001b[31mred\nproceed"], undefined, { readDefaultBranchConfig: () => assert.fail("read") });
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.err, /\u001b/);
  assert.equal(result.err.split("\n").length, 3);
});

test("false under CI still asks: the script prints ask whatever CI says", (t) => {
  const denied = scenario(t, { origin: DENIED, local: GRANTED });
  const granted = scenario(t, { origin: GRANTED, local: DENIED });
  const saved = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of ["CI", "GITHUB_ACTIONS"]) {
    for (const value of [undefined, "", "true", "false", "0", "1"]) {
      for (const other of Object.keys(saved)) delete process.env[other];
      if (value !== undefined) process.env[name] = value;
      const label = `${name}=${JSON.stringify(value)}`;
      assert.deepEqual(answers(denied.clone), { plain: "ask", admin: "refuse" }, label);
      assert.deepEqual(answers(granted.clone), { plain: "proceed", admin: "proceed" }, label);
    }
  }
});

// --- isMain ------------------------------------------------------------------

test("isMain compares real paths and is false for anything it cannot resolve", (t) => {
  const url = pathToFileURL(SCRIPT).href;
  const dir = tempDir(t);
  const link = join(dir, "linked.mjs");
  symlinkSync(SCRIPT, link);
  assert.equal(isMain(SCRIPT, url), true);
  assert.equal(isMain(link, url), true);
  assert.equal(isMain(fileURLToPath(import.meta.url), url), false);
  assert.equal(isMain(join(dir, "missing.mjs"), url), false);
  assert.equal(isMain(undefined, url), false);
  assert.equal(isMain(SCRIPT, "not a url"), false);
});

// --- the script as a command -------------------------------------------------

const childEnv = (extra = {}) => ({ ...isolatedEnv(), ...FIXTURE_GIT_ENV, ...extra });
const command = (cwd, args, { script = SCRIPT, env = childEnv() } = {}) =>
  spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });

test("the script is an executable node entry point", () => {
  assert.equal(readFileSync(SCRIPT, "utf8").split("\n")[0], "#!/usr/bin/env node");
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0);
});

test("main is covered in-process and once as a child with isolatedEnv()", (t) => {
  const granted = scenario(t, { origin: GRANTED, local: DENIED, branch: "release/1.x" });
  const denied = scenario(t, { origin: DENIED, local: GRANTED });
  const cases = [
    [granted.clone, [], "proceed\n"],
    [granted.clone, ["--admin"], "proceed\n"],
    [denied.clone, [], "ask\n"],
    [denied.clone, ["--admin"], "refuse\n"],
  ];
  for (const [cwd, args, expected] of cases) {
    const result = command(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
  assert.equal(sh(granted.clone, "rev-parse", DEFAULT_REF), granted.origin.sha);
});

test("the command finds the repository from a subdirectory", (t) => {
  const { clone } = scenario(t, { origin: GRANTED, local: DENIED });
  mkdirSync(join(clone, "deep/er"), { recursive: true });
  const result = command(join(clone, "deep/er"), []);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "proceed\n", ""]);
});

test("the command answers when started through a symlink", (t) => {
  const { clone } = scenario(t, { origin: GRANTED, local: DENIED });
  const link = join(tempDir(t), "agent-policy-link.mjs");
  symlinkSync(SCRIPT, link);
  const result = command(clone, ["--admin"], { script: link });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "proceed\n", ""]);
});

test("the command gives the same word whatever CI and GITHUB_ACTIONS say", (t) => {
  const denied = scenario(t, { origin: DENIED, local: GRANTED });
  for (const env of [childEnv({ CI: "true", GITHUB_ACTIONS: "true" }), childEnv({ CI: "false", GITHUB_ACTIONS: "" }), childEnv()]) {
    const result = command(denied.clone, [], { env });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "ask\n", ""]);
  }
});

test("the command outside a repository asks and exits 0", (t) => {
  const dir = tempDir(t);
  const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(dir) });
  const plain = command(dir, [], { env });
  assert.deepEqual([plain.status, plain.stdout], [0, "ask\n"]);
  const admin = command(dir, ["--admin"], { env });
  assert.deepEqual([admin.status, admin.stdout], [0, "refuse\n"]);
});

test("the command exits 2 on an unknown argument and prints no word", (t) => {
  const { clone } = scenario(t, { origin: GRANTED });
  const result = command(clone, ["--admn"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown argument "--admn"/);
});

test("importing the module runs nothing", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(pathToFileURL(SCRIPT).href)};`], {
    encoding: "utf8",
    env: childEnv(),
  });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
});
