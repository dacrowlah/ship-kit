import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BumpVersionError,
  PLUGIN_JSON_PATH,
  VERSION_PATTERN,
  bumpVersion,
  defaultListTracked,
  defaultRandom,
  main,
  parseArgs,
} from "./bump-version.mjs";
import { isolatedEnv } from "../assert-test-globs.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./bump-version.mjs", import.meta.url));

// --- Fixture helpers ------------------------------------------------------

function writeFixture(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Lists every file under root as repo-relative posix paths, without needing a real git repo. */
function listAll(root) {
  const result = spawnSync("find", [".", "-type", "f"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ""));
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "bump-version-"));
  return root;
}

function pluginJson(version) {
  return `${JSON.stringify({ name: "fixture-plugin", version }, null, 2)}\n`;
}

function snapshot(root, files) {
  const out = new Map();
  for (const f of files) {
    out.set(f, readFileSync(join(root, f)));
  }
  return out;
}

function assertSnapshotUnchanged(before, after) {
  assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
  for (const [path, buf] of before) {
    assert.ok(Buffer.compare(buf, after.get(path)) === 0, `${path} changed but should not have`);
  }
}

const MARKER_LINE = /^skill_marker: ([^\r\n@]+)@([^\r\n:]+):([0-9a-f]{16})\r?$/m;

function extractMarker(content) {
  const match = MARKER_LINE.exec(content);
  assert.ok(match, "expected a skill_marker line");
  return { name: match[1], version: match[2], token: match[3] };
}

// --- VERSION_PATTERN -------------------------------------------------------

test("VERSION_PATTERN accepts plain x.y.z and rejects common malformed shapes", () => {
  assert.equal(VERSION_PATTERN.test("0.2.0"), true);
  assert.equal(VERSION_PATTERN.test("12.34.56"), true);
  assert.equal(VERSION_PATTERN.test("0.2"), false);
  assert.equal(VERSION_PATTERN.test("v0.2.0"), false);
  assert.equal(VERSION_PATTERN.test("0.2.0-rc.1"), false);
});

// --- bumpVersion: happy path ------------------------------------------------

test("bumps plugin.json and every marked SKILL.md, leaving the unmarked one untouched", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(
      root,
      "skills/foo/SKILL.md",
      [
        "---",
        "name: foo",
        "---",
        "",
        "Body text.",
        "",
        "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa",
        "",
      ].join("\n"),
    );
    writeFixture(
      root,
      "skills/bar/SKILL.md",
      [
        "---",
        "name: bar",
        "---",
        "",
        "skill_marker: bar@0.1.0:bbbbbbbbbbbbbbbb",
        "",
        "More body.",
        "",
      ].join("\n"),
    );
    const bazContent = ["---", "name: baz", "---", "", "No marker here.", ""].join("\n");
    writeFixture(root, "skills/baz/SKILL.md", bazContent);

    const listTracked = () => listAll(root);
    const { changed } = bumpVersion({ root, version: "0.2.0", listTracked });

    assert.deepEqual(
      [...changed].sort(),
      [PLUGIN_JSON_PATH, "skills/bar/SKILL.md", "skills/foo/SKILL.md"].sort(),
    );

    const plugin = JSON.parse(readFileSync(join(root, PLUGIN_JSON_PATH), "utf8"));
    assert.equal(plugin.version, "0.2.0");
    assert.equal(readFileSync(join(root, PLUGIN_JSON_PATH), "utf8"), pluginJson("0.2.0"));

    const foo = extractMarker(readFileSync(join(root, "skills/foo/SKILL.md"), "utf8"));
    const bar = extractMarker(readFileSync(join(root, "skills/bar/SKILL.md"), "utf8"));
    assert.equal(foo.name, "foo");
    assert.equal(foo.version, "0.2.0");
    assert.notEqual(foo.token, "aaaaaaaaaaaaaaaa");
    assert.equal(bar.name, "bar");
    assert.equal(bar.version, "0.2.0");
    assert.notEqual(bar.token, "bbbbbbbbbbbbbbbb");
    assert.notEqual(foo.token, bar.token);

    assert.equal(readFileSync(join(root, "skills/baz/SKILL.md"), "utf8"), bazContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- bumpVersion: version validation ---------------------------------------

for (const bad of ["0.2", "v0.2.0", "0.2.0-rc.1"]) {
  test(`bumpVersion refuses the malformed version ${JSON.stringify(bad)}`, () => {
    const root = makeRoot();
    try {
      writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
      assert.throws(
        () => bumpVersion({ root, version: bad, listTracked: () => listAll(root) }),
        BumpVersionError,
      );
      assert.equal(readFileSync(join(root, PLUGIN_JSON_PATH), "utf8"), pluginJson("0.1.0"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// --- bumpVersion: token uniqueness ------------------------------------------

test("a random value already present in a tracked file is retried", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    // The existing token appears in an unrelated tracked file's text.
    writeFixture(root, "README.md", "See cccccccccccccccc for details.\n");
    writeFixture(
      root,
      "skills/foo/SKILL.md",
      "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n",
    );

    const calls = [];
    const random = () => {
      const value = calls.length === 0 ? "cccccccccccccccc" : "dddddddddddddddd";
      calls.push(value);
      return value;
    };

    const { changed } = bumpVersion({
      root,
      version: "0.2.0",
      random,
      listTracked: () => listAll(root),
    });

    assert.equal(calls.length, 2, "the colliding token must be regenerated");
    assert.ok(changed.includes("skills/foo/SKILL.md"));
    const foo = extractMarker(readFileSync(join(root, "skills/foo/SKILL.md"), "utf8"));
    assert.equal(foo.token, "dddddddddddddddd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two skills in the same run never share a token, even when random tries to repeat one", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/foo/SKILL.md", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n");
    writeFixture(root, "skills/bar/SKILL.md", "skill_marker: bar@0.1.0:bbbbbbbbbbbbbbbb\n");

    const sequence = ["1111111111111111", "1111111111111111", "2222222222222222"];
    let i = 0;
    const random = () => sequence[Math.min(i++, sequence.length - 1)];

    bumpVersion({ root, version: "0.2.0", random, listTracked: () => listAll(root) });

    const foo = extractMarker(readFileSync(join(root, "skills/foo/SKILL.md"), "utf8"));
    const bar = extractMarker(readFileSync(join(root, "skills/bar/SKILL.md"), "utf8"));
    assert.notEqual(foo.token, bar.token);
    assert.equal(new Set([foo.token, bar.token]).size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gives up after 100 attempts and writes nothing", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/foo/SKILL.md", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n");
    const before = snapshot(root, [PLUGIN_JSON_PATH, "skills/foo/SKILL.md"]);

    const random = () => "1111111111111111"; // always collides with itself as "already generated" is moot on attempt 1, but never escapes once it exists in tracked text
    writeFixture(root, "NOTES.md", "token 1111111111111111 already used.\n");

    assert.throws(
      () => bumpVersion({ root, version: "0.2.0", random, listTracked: () => listAll(root) }),
      BumpVersionError,
    );
    const after = snapshot(root, [PLUGIN_JSON_PATH, "skills/foo/SKILL.md"]);
    assertSnapshotUnchanged(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- bumpVersion: malformed / mismatched / duplicate markers ---------------

test("a malformed skill_marker line fails the whole run and writes nothing", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    // A valid marker that would otherwise succeed, alphabetically before the bad one.
    writeFixture(root, "skills/aaa-ok/SKILL.md", "skill_marker: aaa-ok@0.1.0:aaaaaaaaaaaaaaaa\n");
    writeFixture(root, "skills/zzz-bad/SKILL.md", "skill_marker: zzz-bad@0.1.0:not-hex-at-all\n");

    const files = [PLUGIN_JSON_PATH, "skills/aaa-ok/SKILL.md", "skills/zzz-bad/SKILL.md"];
    const before = snapshot(root, files);

    assert.throws(
      () => bumpVersion({ root, version: "0.2.0", listTracked: () => listAll(root) }),
      BumpVersionError,
    );

    const after = snapshot(root, files);
    assertSnapshotUnchanged(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a skill_marker naming another skill fails the whole run and writes nothing", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/aaa-ok/SKILL.md", "skill_marker: aaa-ok@0.1.0:aaaaaaaaaaaaaaaa\n");
    writeFixture(
      root,
      "skills/zzz-mismatch/SKILL.md",
      "skill_marker: some-other-skill@0.1.0:bbbbbbbbbbbbbbbb\n",
    );

    const files = [PLUGIN_JSON_PATH, "skills/aaa-ok/SKILL.md", "skills/zzz-mismatch/SKILL.md"];
    const before = snapshot(root, files);

    assert.throws(
      () => bumpVersion({ root, version: "0.2.0", listTracked: () => listAll(root) }),
      BumpVersionError,
    );

    const after = snapshot(root, files);
    assertSnapshotUnchanged(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SKILL.md with a duplicated skill_marker line fails the whole run and writes nothing", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/aaa-ok/SKILL.md", "skill_marker: aaa-ok@0.1.0:aaaaaaaaaaaaaaaa\n");
    writeFixture(
      root,
      "skills/zzz-dup/SKILL.md",
      [
        "skill_marker: zzz-dup@0.1.0:aaaaaaaaaaaaaaaa",
        "skill_marker: zzz-dup@0.1.0:bbbbbbbbbbbbbbbb",
        "",
      ].join("\n"),
    );

    const files = [PLUGIN_JSON_PATH, "skills/aaa-ok/SKILL.md", "skills/zzz-dup/SKILL.md"];
    const before = snapshot(root, files);

    assert.throws(
      () => bumpVersion({ root, version: "0.2.0", listTracked: () => listAll(root) }),
      BumpVersionError,
    );

    const after = snapshot(root, files);
    assertSnapshotUnchanged(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- bumpVersion: line endings ----------------------------------------------

test("a CRLF SKILL.md keeps CRLF line endings after its marker is rewritten", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    const crlf = ["---", "name: foo", "---", "", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa", "", "Body.", ""].join(
      "\r\n",
    );
    writeFixture(root, "skills/foo/SKILL.md", crlf);

    bumpVersion({ root, version: "0.2.0", listTracked: () => listAll(root) });

    const after = readFileSync(join(root, "skills/foo/SKILL.md"), "utf8");
    assert.equal(after.includes("\r\n"), true);
    // No bare LF was introduced: every \n in the result is still preceded by \r.
    assert.equal(/(?<!\r)\n/.test(after), false);
    const marker = extractMarker(after);
    assert.equal(marker.version, "0.2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- parseArgs ---------------------------------------------------------------

test("parseArgs reads the version and defaults root to cwd", () => {
  const { version, root } = parseArgs(["0.2.0"]);
  assert.equal(version, "0.2.0");
  assert.equal(root, process.cwd());
});

test("parseArgs reads --root", () => {
  const { version, root } = parseArgs(["0.2.0", "--root", "/tmp/somewhere"]);
  assert.equal(version, "0.2.0");
  assert.equal(root, "/tmp/somewhere");
});

test("parseArgs throws with no arguments", () => {
  assert.throws(() => parseArgs([]), BumpVersionError);
});

test("parseArgs throws on an unknown flag", () => {
  assert.throws(() => parseArgs(["0.2.0", "--bogus"]), BumpVersionError);
});

test("parseArgs throws when --root has no value", () => {
  assert.throws(() => parseArgs(["0.2.0", "--root"]), BumpVersionError);
});

// --- main (in-process, for coverage) ----------------------------------------

test("main() succeeds and prints each changed path", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/foo/SKILL.md", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n");

    // main()'s default listTracked shells out to git; give it a real repo.
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);

    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      const code = main(["node", SCRIPT_PATH, "0.2.0", "--root", root]);
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.includes(PLUGIN_JSON_PATH));
    assert.ok(logs.includes("skills/foo/SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main() returns 1 and prints the message for a BumpVersionError", () => {
  const errs = [];
  const origErr = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    const code = main(["node", SCRIPT_PATH]);
    assert.equal(code, 1);
  } finally {
    console.error = origErr;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /usage:/);
});

test("main() returns 1 and prints a stack for an unexpected error", () => {
  const root = makeRoot();
  try {
    // No plugin.json at all: readFileSync throws a plain Node error, not BumpVersionError.
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);

    const errs = [];
    const origErr = console.error;
    console.error = (msg) => errs.push(msg);
    try {
      const code = main(["node", SCRIPT_PATH, "0.2.0", "--root", root]);
      assert.equal(code, 1);
    } finally {
      console.error = origErr;
    }
    assert.equal(errs.length, 1);
    assert.match(errs[0], /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- defaults ----------------------------------------------------------------

test("defaultRandom returns 16 lowercase hex characters", () => {
  const token = defaultRandom();
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.notEqual(defaultRandom(), defaultRandom());
});

test("defaultListTracked lists files git tracks in the given root", () => {
  const root = makeRoot();
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    writeFixture(root, "a.txt", "hello\n");
    writeFixture(root, "dir/b.txt", "world\n");
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);

    const tracked = defaultListTracked(root).sort();
    assert.deepEqual(tracked, ["a.txt", "dir/b.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultListTracked throws when the directory is not a git repository", () => {
  const root = makeRoot();
  try {
    assert.throws(() => defaultListTracked(root), BumpVersionError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultListTracked throws when git itself fails to run", () => {
  assert.throws(() => defaultListTracked("/no/such/directory/at/all"), BumpVersionError);
});

test("a tracked path listed by listTracked but missing on disk is treated as empty text, not a crash", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/foo/SKILL.md", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n");

    const listTracked = () => [...listAll(root), "skills/foo/DOES-NOT-EXIST.md"];
    const { changed } = bumpVersion({ root, version: "0.2.0", listTracked });
    assert.ok(changed.includes("skills/foo/SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- script run as a child process (proves the CLI entry point works too) --

test("running the script as a child process exits 0 and bumps the fixture", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    writeFixture(root, "skills/foo/SKILL.md", "skill_marker: foo@0.1.0:aaaaaaaaaaaaaaaa\n");
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);

    const result = spawnSync(process.execPath, [SCRIPT_PATH, "0.2.0", "--root", root], {
      encoding: "utf8",
      env: isolatedEnv(),
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skills\/foo\/SKILL\.md/);

    const plugin = JSON.parse(readFileSync(join(root, PLUGIN_JSON_PATH), "utf8"));
    assert.equal(plugin.version, "0.2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running the script as a child process exits 1 on a bad version", () => {
  const root = makeRoot();
  try {
    writeFixture(root, PLUGIN_JSON_PATH, pluginJson("0.1.0"));
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);

    const result = spawnSync(process.execPath, [SCRIPT_PATH, "0.2", "--root", root], {
      encoding: "utf8",
      env: isolatedEnv(),
      timeout: 60000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
