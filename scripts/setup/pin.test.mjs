import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { devNull } from "node:os";
import { COMPARED_ROOTS, MAX_FILES, PinError, gitEnv, resolvePin, runGit } from "./pin.mjs";

// Fixture git runs ignore the machine's global and system config (signing,
// hooks, default branch), so the fixture remote is the same everywhere.
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};
const fx = (cwd, ...args) => execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" }).trim();

const FILES = {
  "templates/callers/review.yml": "on: pull_request_target\n",
  "templates/blocks/gate-step.sh": "echo gate\n",
  "schemas/config.schema.json": "{}\n",
  "scripts/setup/migrations/index.mjs": "export const MIGRATIONS = [];\n",
  "README.md": "outside the compared roots\n",
};

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "pin-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A remote holding one commit of `files`, tagged with each of `tags`. */
function makeRemote(dir, files, tags) {
  const remote = join(dir, "remote");
  mkdirSync(remote);
  fx(remote, "init", "--quiet", "--initial-branch=main");
  writeTree(remote, files);
  fx(remote, "add", "--all");
  fx(remote, "commit", "--quiet", "--no-gpg-sign", "-m", "release");
  const commit = fx(remote, "rev-parse", "HEAD");
  for (const { name, annotated } of tags) {
    if (annotated) fx(remote, "tag", "--no-sign", "-a", "-m", name, name);
    else fx(remote, "tag", name);
  }
  // A later commit on the branch, so the pin must fetch the tagged commit
  // rather than whatever the branch tip holds.
  writeFileSync(join(remote, "templates-later.txt"), "later\n");
  fx(remote, "add", "--all");
  fx(remote, "commit", "--quiet", "--no-gpg-sign", "-m", "later");
  return { remote, commit };
}

function makePlugin(dir, version, files) {
  const root = join(dir, "plugin");
  writeTree(root, { ".claude-plugin/plugin.json": JSON.stringify({ name: "ship-kit", version }), ...files });
  return root;
}

/** Records the temporary repository resolvePin works in. */
function recordingGit() {
  const cwds = new Set();
  const git = (args, options) => {
    assert.equal(options.gitDir, options.cwd, `git ${args[0]} must name the temporary repository`);
    cwds.add(options.cwd);
    return runGit(args, options);
  };
  return { git, cwds };
}

function assertPinError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PinError, `expected PinError, got ${error?.name}: ${error?.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test("the compared roots are templates, schemas and migrations", () => {
  assert.deepEqual(COMPARED_ROOTS, ["templates", "schemas", "scripts/setup/migrations"]);
});

for (const annotated of [true, false]) {
  test(`tag present and matching (${annotated ? "annotated" : "lightweight"}) pins its commit`, (t) => {
    const dir = scratch(t);
    const { remote, commit } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated }]);
    const pluginRoot = makePlugin(dir, "0.2.0", FILES);
    assert.deepEqual(resolvePin({ pluginRoot, remote }), { tag: "ship-kit--v0.2.0", sha: commit, version: "0.2.0" });
    if (annotated) assert.notEqual(fx(remote, "rev-parse", "ship-kit--v0.2.0"), commit);
  });
}

test("files outside the compared roots and executable bits are not compared", (t) => {
  const dir = scratch(t);
  const { remote, commit } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", { ...FILES, "README.md": "edited\n", "scripts/other.mjs": "x\n" });
  chmodSync(join(pluginRoot, "templates/blocks/gate-step.sh"), 0o755);
  assert.equal(resolvePin({ pluginRoot, remote }).sha, commit);
});

test("tag missing", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.1.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^tag ship-kit--v0\.2\.0 not found on /);
});

test("tag present whose tree lacks templates/ (the 0.1.0 shape) is refused naming templates/...", (t) => {
  const dir = scratch(t);
  const withoutTemplates = Object.fromEntries(Object.entries(FILES).filter(([path]) => !path.startsWith("templates/")));
  const { remote } = makeRemote(dir, withoutTemplates, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/blocks\/gate-step\.sh differs between the running plugin and ship-kit--v0\.2\.0 \([0-9a-f]{40}\)$/);
});

test("a differing template", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: false }]);
  const pluginRoot = makePlugin(dir, "0.2.0", { ...FILES, "templates/callers/review.yml": "on: push\n" });
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/callers\/review\.yml differs/);
});

test("a differing migration and schema are named in sorted order", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: false }]);
  const pluginRoot = makePlugin(dir, "0.2.0", {
    ...FILES,
    "scripts/setup/migrations/index.mjs": "changed\n",
    "schemas/config.schema.json": "changed\n",
  });
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^schemas\/config\.schema\.json differs/);
});

test("a file only in the plugin", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", { ...FILES, "templates/files/extra.txt": "extra\n" });
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/files\/extra\.txt differs/);
});

test("a file only in the tag", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, { ...FILES, "templates/files/extra.txt": "extra\n" }, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/files\/extra\.txt differs/);
});

test("a migrations sibling directory with a shared prefix is not compared", (t) => {
  const dir = scratch(t);
  const { remote, commit } = makeRemote(dir, { ...FILES, "scripts/setup/migrations-old/a.mjs": "old\n" }, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assert.equal(resolvePin({ pluginRoot, remote }).sha, commit);
});

test("a symlink under templates/", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  rmSync(join(pluginRoot, "templates/callers/review.yml"));
  // The link points at an identical file, so only its being a link differs.
  writeFileSync(join(dir, "review.yml"), FILES["templates/callers/review.yml"]);
  symlinkSync(join(dir, "review.yml"), join(pluginRoot, "templates/callers/review.yml"));
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/callers\/review\.yml differs/);
});

test("a symlinked templates directory is refused naming it", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", Object.fromEntries(Object.entries(FILES).filter(([p]) => !p.startsWith("templates/"))));
  writeTree(join(dir, "elsewhere"), { "callers/review.yml": FILES["templates/callers/review.yml"], "blocks/gate-step.sh": FILES["templates/blocks/gate-step.sh"] });
  symlinkSync(join(dir, "elsewhere"), join(pluginRoot, "templates"));
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates differs/);
});

test("a symlinked or plain-file scripts/ component is refused naming it", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const linked = makePlugin(join(dir, "a"), "0.2.0", Object.fromEntries(Object.entries(FILES).filter(([p]) => !p.startsWith("scripts/"))));
  writeTree(join(dir, "real"), { "setup/migrations/index.mjs": FILES["scripts/setup/migrations/index.mjs"] });
  symlinkSync(join(dir, "real"), join(linked, "scripts"));
  assertPinError(() => resolvePin({ pluginRoot: linked, remote }), /^scripts differs/);
  const plain = makePlugin(join(dir, "b"), "0.2.0", Object.fromEntries(Object.entries(FILES).filter(([p]) => !p.startsWith("scripts/"))));
  writeTree(plain, { "scripts/setup": "not a directory\n" });
  assertPinError(() => resolvePin({ pluginRoot: plain, remote }), /^scripts\/setup differs/);
});

test("a symlink in the tag's tree is refused", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, []);
  fx(remote, "checkout", "--quiet", "HEAD~1");
  symlinkSync("gate-step.sh", join(remote, "templates/blocks/link.sh"));
  fx(remote, "add", "--all");
  fx(remote, "commit", "--quiet", "--no-gpg-sign", "-m", "link");
  fx(remote, "tag", "ship-kit--v0.2.0");
  const pluginRoot = makePlugin(dir, "0.2.0", { ...FILES, "templates/blocks/link.sh": "gate-step.sh" });
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/blocks\/link\.sh differs/);
});

test("a missing compared root on both sides is not a difference", (t) => {
  const dir = scratch(t);
  const files = Object.fromEntries(Object.entries(FILES).filter(([p]) => !p.startsWith("scripts/")));
  const { remote, commit } = makeRemote(dir, files, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", files);
  assert.equal(resolvePin({ pluginRoot, remote }).sha, commit);
});

test("--tag rc accepted", (t) => {
  const dir = scratch(t);
  const { remote, commit } = makeRemote(dir, FILES, [
    { name: "ship-kit--v0.2.0-rc.1", annotated: true },
    { name: "ship-kit--v0.2.0-rc.12", annotated: false },
  ]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assert.deepEqual(resolvePin({ pluginRoot, remote, tag: "ship-kit--v0.2.0-rc.1" }), { tag: "ship-kit--v0.2.0-rc.1", sha: commit, version: "0.2.0" });
  assert.equal(resolvePin({ pluginRoot, remote, tag: "ship-kit--v0.2.0-rc.12" }).tag, "ship-kit--v0.2.0-rc.12");
  // Without --tag the final release tag is required, and it does not exist.
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^tag ship-kit--v0\.2\.0 not found/);
});

test("--tag for another version refused", (t) => {
  const dir = scratch(t);
  // Every refused tag exists and carries matching files, so only the name
  // check can refuse it.
  const refused = [
    "ship-kit--v0.3.0", "ship-kit--v0.3.0-rc.1", "ship-kit--v0.2.1", "ship-kit--v0.2.0-rc.0",
    "ship-kit--v0.2.0-evil", "ship-kit--v0.2.0-rc.1-evil", "ship-kit--v0.2.00",
  ];
  const { remote } = makeRemote(dir, FILES, refused.map((name) => ({ name, annotated: false })));
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  for (const tag of [...refused, "", "refs/tags/ship-kit--v0.2.0", 7]) {
    assertPinError(() => resolvePin({ pluginRoot, remote, tag }), /^--tag .* is neither ship-kit--v0\.2\.0 nor ship-kit--v0\.2\.0-rc\.<n>$/);
  }
});

test("--tag equal to the release tag is accepted", (t) => {
  const dir = scratch(t);
  const { remote, commit } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  assert.equal(resolvePin({ pluginRoot, remote, tag: "ship-kit--v0.2.0" }).sha, commit);
});

for (const [name, manifest] of [
  ["two components", JSON.stringify({ version: "0.2" })],
  ["leading v", JSON.stringify({ version: "v0.2.0" })],
  ["prerelease suffix", JSON.stringify({ version: "0.2.0-rc.1" })],
  ["leading zero", JSON.stringify({ version: "0.02.0" })],
  ["number", JSON.stringify({ version: 2 })],
  ["missing", JSON.stringify({ name: "ship-kit" })],
  ["null manifest", "null"],
]) {
  test(`a malformed plugin.json version: ${name}`, (t) => {
    const dir = scratch(t);
    writeTree(join(dir, "plugin"), { ".claude-plugin/plugin.json": manifest });
    assertPinError(() => resolvePin({ pluginRoot: join(dir, "plugin"), remote: dir }), /^plugin\.json version .* is not MAJOR\.MINOR\.PATCH$/);
  });
}

test("an unreadable or non-JSON plugin.json", (t) => {
  const dir = scratch(t);
  assertPinError(() => resolvePin({ pluginRoot: join(dir, "absent"), remote: dir }), /^cannot read the plugin version from /);
  writeTree(join(dir, "plugin"), { ".claude-plugin/plugin.json": "{not json" });
  assertPinError(() => resolvePin({ pluginRoot: join(dir, "plugin"), remote: dir }), /^cannot read the plugin version from /);
});

test("ls-remote failure", (t) => {
  const dir = scratch(t);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  const { git, cwds } = recordingGit();
  assertPinError(() => resolvePin({ pluginRoot, remote: join(dir, "no-such-remote"), git }), /^git ls-remote failed \(ship-kit pin resolution fetches without credentials, so the remote must be publicly readable\): git ls-remote exited/);
  assert.equal(cwds.size, 1);
  for (const cwd of cwds) assert.equal(existsSync(cwd), false);
});

test("an unusable remote is refused before any git call", (t) => {
  const dir = scratch(t);
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  const git = () => assert.fail("git must not run");
  for (const remote of ["--upload-pack=touch x", "-x", "", 5]) {
    assertPinError(() => resolvePin({ pluginRoot, remote, git }), /^unusable remote /);
  }
});

test("the temporary directory is gone after success and after failure", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  const good = makePlugin(join(dir, "good"), "0.2.0", FILES);
  const bad = makePlugin(join(dir, "bad"), "0.2.0", { ...FILES, "schemas/config.schema.json": "[]\n" });
  for (const [pluginRoot, fails] of [[good, false], [bad, true]]) {
    const { git, cwds } = recordingGit();
    if (fails) assert.throws(() => resolvePin({ pluginRoot, remote, git }), PinError);
    else resolvePin({ pluginRoot, remote, git });
    assert.equal(cwds.size, 1);
    const [work] = cwds;
    assert.match(work, /ship-kit-pin-/);
    assert.equal(existsSync(work), false);
  }
});

/**
 * A git that answers one subcommand with `answer` and runs the rest for real.
 * @param {string} subcommand
 * @param {(args: string[], options: { cwd: string }) => Buffer | string} answer
 */
function gitAnswering(subcommand, answer) {
  return (args, options) => (args[0] === subcommand ? answer(args, options) : runGit(args, options));
}

function forgedCase(t) {
  const dir = scratch(t);
  const { remote, commit } = makeRemote(dir, FILES, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  return { remote, commit, pluginRoot: makePlugin(dir, "0.2.0", FILES) };
}

test("unparseable ls-remote output is refused", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  assertPinError(
    () => resolvePin({ pluginRoot, remote, git: gitAnswering("ls-remote", () => "garbage\n") }),
    /^cannot read git ls-remote output: malformed ls-remote line/,
  );
});

test("ls-remote output that is not UTF-8 is refused", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  assertPinError(
    () => resolvePin({ pluginRoot, remote, git: gitAnswering("ls-remote", () => Buffer.from([0xff, 0xfe])) }),
    /^git ls-remote output is not valid UTF-8$/,
  );
});

test("a listed commit that the fetched objects do not peel to is refused", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  assertPinError(
    () => resolvePin({ pluginRoot, remote, git: gitAnswering("rev-parse", () => `${"0".repeat(40)}\n`) }),
    /^tag ship-kit--v0\.2\.0 does not peel to the commit [0-9a-f]{40}$/,
  );
});

test("a listed SHA the remote does not have fails the fetch", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  const forged = `${"1".repeat(40)}\trefs/tags/ship-kit--v0.2.0\n`;
  assertPinError(() => resolvePin({ pluginRoot, remote, git: gitAnswering("ls-remote", () => forged) }), /^git fetch failed \(ship-kit pin resolution fetches without credentials, so the remote must be publicly readable\): /);
});

test("hash-object output missing an id is refused", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  assertPinError(
    () => resolvePin({ pluginRoot, remote, git: gitAnswering("hash-object", () => "") }),
    /^git hash-object gave no object id for /,
  );
});

test("ls-tree entries outside the compared roots are not compared", (t) => {
  const { remote, commit, pluginRoot } = forgedCase(t);
  const outside = ["templates-later.txt", "schemasx/y"].map((path) => `100644 blob ${"a".repeat(40)}\t${path}\0`).join("");
  const extra = (args, options) => `${runGit(args, options)}${outside}`;
  assert.equal(resolvePin({ pluginRoot, remote, git: gitAnswering("ls-tree", extra) }).sha, commit);
});

test("an unreadable ls-tree entry is refused", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  assertPinError(
    () => resolvePin({ pluginRoot, remote, git: gitAnswering("ls-tree", () => "100644 blob short\ttemplates/x\0") }),
    /^unreadable git ls-tree entry: /,
  );
});

test("a non-PinError failure inside the comparison becomes a PinError", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  const locked = join(pluginRoot, "templates/blocks");
  chmodSync(locked, 0o000);
  try {
    assertPinError(() => resolvePin({ pluginRoot, remote }), /^cannot resolve the pin: EACCES/);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("more files than the walk allows is refused, on either side", (t) => {
  assert.equal(MAX_FILES, 10_000);
  const { remote, pluginRoot } = forgedCase(t);
  // FILES holds four compared files on each side.
  assert.equal(resolvePin({ pluginRoot, remote, maxFiles: 4 }).tag, "ship-kit--v0.2.0");
  assertPinError(() => resolvePin({ pluginRoot, remote, maxFiles: 3 }), /^more than 3 files under templates, schemas, scripts\/setup\/migrations$/);
  const many = () => Array.from({ length: 5 }, (_, i) => `100644 blob ${"a".repeat(40)}\ttemplates/x${i}\0`).join("");
  assertPinError(
    () => resolvePin({ pluginRoot, remote, maxFiles: 4, git: gitAnswering("ls-tree", many) }),
    /^more than 4 files under /,
  );
});

test("runGit throws on a non-zero exit and on a spawn error", (t) => {
  const dir = scratch(t);
  assert.throws(() => runGit(["not-a-git-command"], { cwd: dir }), /^Error: git not-a-git-command exited 1: /);
  assert.throws(() => runGit(["--version"], { cwd: join(dir, "missing") }), /ENOENT/);
  assert.match(String(runGit(["--version"], { cwd: dir })), /^git version /);
});

/** Runs fn with process.env changed as given (undefined deletes), then restores it. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** Everything about a repository that a pin must never change. */
function repoState(gitDir) {
  return {
    refs: fx(gitDir, "for-each-ref", "--format=%(objectname) %(refname)"),
    objects: fx(gitDir, "count-objects", "-v"),
    commits: fx(gitDir, "rev-list", "--all", "--count"),
    shallow: existsSync(join(gitDir, "shallow")),
    fetchHead: existsSync(join(gitDir, "FETCH_HEAD")),
  };
}

/** A full clone of the fixture remote standing in for the caller's own repository. */
function callerRepo(dir, remote) {
  const clone = join(dir, "caller");
  fx(dir, "clone", "--quiet", remote, clone);
  return clone;
}

test("an inherited GIT_DIR naming a repository with a replace ref does not change the result", (t) => {
  const { remote, commit, pluginRoot } = forgedCase(t);
  const dir = dirname(remote);
  const caller = callerRepo(dir, remote);
  writeFileSync(join(caller, "templates/callers/review.yml"), "on: push\n");
  fx(caller, "commit", "--quiet", "--no-gpg-sign", "-am", "evil");
  fx(caller, "replace", commit, fx(caller, "rev-parse", "HEAD"));
  writeFileSync(join(pluginRoot, "templates/callers/review.yml"), "on: push\n");
  const gitDir = join(caller, ".git");
  const before = repoState(gitDir);
  withEnv({ GIT_DIR: gitDir }, () => {
    assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/callers\/review\.yml differs/);
  });
  assert.deepEqual(repoState(gitDir), before);
});

test("the caller's repository is unchanged by a pin run under an inherited GIT_DIR", (t) => {
  const { remote, commit, pluginRoot } = forgedCase(t);
  const caller = callerRepo(dirname(remote), remote);
  const gitDir = join(caller, ".git");
  const before = repoState(gitDir);
  assert.equal(before.shallow, false);
  for (const vars of [
    { GIT_DIR: gitDir },
    { GIT_DIR: gitDir, GIT_WORK_TREE: caller, GIT_INDEX_FILE: join(gitDir, "index"), GIT_OBJECT_DIRECTORY: join(gitDir, "objects") },
  ]) {
    withEnv(vars, () => {
      assert.equal(resolvePin({ pluginRoot, remote }).sha, commit);
    });
    assert.deepEqual(repoState(gitDir), before);
  }
});

/** A second remote whose tag carries a differing template, and a plugin matching it. */
function decoyCase(t) {
  const { remote, pluginRoot } = forgedCase(t);
  const decoyDir = join(dirname(remote), "decoy");
  mkdirSync(decoyDir);
  const decoy = makeRemote(decoyDir, { ...FILES, "templates/callers/review.yml": "on: push\n" }, [{ name: "ship-kit--v0.2.0", annotated: true }]);
  writeFileSync(join(pluginRoot, "templates/callers/review.yml"), "on: push\n");
  assert.equal(resolvePin({ pluginRoot, remote: decoy.remote }).sha, decoy.commit);
  return { remote, pluginRoot, decoy: decoy.remote };
}

test("inherited GIT_CONFIG_* variables cannot redirect the remote", (t) => {
  const { remote, pluginRoot, decoy } = decoyCase(t);
  withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${decoy}.insteadOf`, GIT_CONFIG_VALUE_0: remote }, () => {
    assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/callers\/review\.yml differs/);
  });
});

test("the user's global git config cannot redirect the remote", (t) => {
  const { remote, pluginRoot, decoy } = decoyCase(t);
  const home = join(dirname(remote), "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[url "${decoy}"]\n\tinsteadOf = ${remote}\n`);
  withEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: undefined }, () => {
    assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/callers\/review\.yml differs/);
  });
});

test("a symlink on both sides at the same path is refused", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, []);
  fx(remote, "checkout", "--quiet", "HEAD~1");
  symlinkSync("gate-step.sh", join(remote, "templates/blocks/link.sh"));
  fx(remote, "add", "--all");
  fx(remote, "commit", "--quiet", "--no-gpg-sign", "-m", "link");
  fx(remote, "tag", "ship-kit--v0.2.0");
  const pluginRoot = makePlugin(dir, "0.2.0", FILES);
  symlinkSync("gate-step.sh", join(pluginRoot, "templates/blocks/link.sh"));
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/blocks\/link\.sh differs/);
});

test("a gitlink in the tag's tree is refused even when its id equals the plugin file's blob", (t) => {
  const dir = scratch(t);
  const { remote } = makeRemote(dir, FILES, []);
  fx(remote, "checkout", "--quiet", "HEAD~1");
  writeFileSync(join(dir, "sub"), "x\n");
  const blob = fx(remote, "hash-object", "--no-filters", join(dir, "sub"));
  fx(remote, "update-index", "--add", "--cacheinfo", `160000,${blob},templates/sub`);
  fx(remote, "commit", "--quiet", "--no-gpg-sign", "-m", "gitlink");
  fx(remote, "tag", "ship-kit--v0.2.0");
  const pluginRoot = makePlugin(dir, "0.2.0", { ...FILES, "templates/sub": "x\n" });
  assertPinError(() => resolvePin({ pluginRoot, remote }), /^templates\/sub differs/);
});

test("gitEnv drops every inherited GIT_* variable and isolates config", () => {
  const inherited = {
    PATH: "/bin", HOME: "/home/x", https_proxy: "http://proxy.example:3128",
    GIT_DIR: "/caller/.git", GIT_WORK_TREE: "/caller", GIT_INDEX_FILE: "/i", GIT_OBJECT_DIRECTORY: "/o",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a", GIT_COMMON_DIR: "/c", GIT_NAMESPACE: "n", GIT_CEILING_DIRECTORIES: "/",
    GIT_REPLACE_REF_BASE: "refs/r/", GIT_SHALLOW_FILE: "/s", GIT_CONFIG_PARAMETERS: "'a.b'='c'",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "k", GIT_CONFIG_VALUE_0: "v", GIT_CONFIG_GLOBAL: "/g", GIT_CONFIG_SYSTEM: "/s",
    GIT_SSH_COMMAND: "evil", GIT_ASKPASS: "evil", GIT_EXEC_PATH: "/evil", git_dir: "/lower",
  };
  const expected = {
    PATH: "/bin", HOME: "/home/x", https_proxy: "http://proxy.example:3128",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0",
  };
  assert.deepEqual(gitEnv(undefined, inherited), expected);
  assert.deepEqual(gitEnv("/tmp/work", inherited), { ...expected, GIT_DIR: "/tmp/work" });
  assert.equal(gitEnv(undefined).GIT_DIR, undefined);
});

test("a remote that needs credentials is refused with a message saying why, carrying git's stderr", (t) => {
  const { remote, pluginRoot } = forgedCase(t);
  const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
  const denied = () => { throw new Error(`git exited 128: ${stderr}`); };
  for (const subcommand of ["ls-remote", "fetch"]) {
    assertPinError(
      () => resolvePin({ pluginRoot, remote, git: gitAnswering(subcommand, denied) }),
      new RegExp(`^git ${subcommand} failed \\(ship-kit pin resolution fetches without credentials, so the remote must be publicly readable\\): git exited 128: fatal: could not read Username for 'https://github\\.com': terminal prompts disabled$`),
    );
  }
  // Local commands are not about the remote, so they carry no such note.
  assertPinError(() => resolvePin({ pluginRoot, remote, git: gitAnswering("rev-parse", denied) }), /^git rev-parse failed: git exited 128: /);
});
