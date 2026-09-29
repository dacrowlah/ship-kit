import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../assert-test-globs.mjs";
import {
  GIT_TIMEOUT_MS, LimitError, MAX_BYTES, MAX_ENTRIES, extractEntries, gitRunner, main, parseArgs, parseLsTree,
  refusalReason, scopeLines, targetPath,
} from "./extract-tree.mjs";

const SCRIPT = fileURLToPath(new URL("./extract-tree.mjs", import.meta.url));
const SHA = "a".repeat(40);
const SUB_SHA = "b".repeat(40);
const isWindows = process.platform === "win32";

const tmp = () => mkdtempSync(join(tmpdir(), "extract-tree-"));
const blob = (path, content = path, mode = "100644") => ({ mode, type: "blob", sha: SHA, path, content });
const fakeRead = (entries) => {
  const bySha = new Map();
  const calls = [];
  const readBlob = (sha, max) => {
    calls.push({ sha, max });
    return Buffer.from(bySha.get(sha) ?? "");
  };
  entries.forEach((entry, i) => {
    const sha = i.toString(16).padStart(40, "0");
    bySha.set(sha, entry.content ?? entry.path);
    entry.sha = entry.type === "commit" ? entry.sha : sha;
  });
  return { readBlob, calls };
};
const silentIo = () => {
  const out = [];
  const err = [];
  return { io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } }, out, err };
};

// Extracts synthetic entries into a fresh directory.
function extract(entries, opts = {}) {
  const out = join(tmp(), "pr");
  mkdirSync(out);
  const { readBlob } = fakeRead(entries);
  return { out, result: extractEntries(entries, { readBlob, out, ...opts }) };
}

const reasonFor = (result, path) => result.refused.find((r) => r.path === path)?.reason;

// ---------------------------------------------------------------- the rules

for (const path of ["../x", "a/../b", "a/.."]) {
  test(`${path} is refused`, () => {
    const { out, result } = extract([blob(path)]);
    assert.equal(reasonFor(result, path), "a component is empty, . or ..");
    assert.deepEqual(result.written, []);
    assert.deepEqual(readdirSync(out), []);
    assert.equal(existsSync(join(out, "..", "x")), false);
    assert.equal(existsSync(join(out, "..", "b")), false);
  });
}

test("the /abs case: an absolute path is refused", () => {
  const { result } = extract([blob("/abs")]);
  assert.equal(reasonFor(result, "/abs"), "absolute path");
  assert.deepEqual(result.written, []);
});

for (const path of ["a//b", "./a", "a/./b", "a/", "a/b/"]) {
  test(`${JSON.stringify(path)} is refused for an empty or dot component`, () => {
    const { result } = extract([blob(path)]);
    assert.equal(reasonFor(result, path), "a component is empty, . or ..");
  });
}

test("the empty path is refused", () => {
  const { result } = extract([blob("")]);
  assert.deepEqual(result.refused, [{ path: "", reason: "empty path" }]);
});

test(".git/config is refused", () => {
  const { result } = extract([blob(".git/config")]);
  assert.equal(reasonFor(result, ".git/config"), "a component is .git");
});

test("sub/.GIT/hooks/pre-commit is refused", () => {
  const { out, result } = extract([blob("sub/.GIT/hooks/pre-commit")]);
  assert.equal(reasonFor(result, "sub/.GIT/hooks/pre-commit"), "a component is .git");
  assert.deepEqual(readdirSync(out), []);
});

for (const path of ["a/.git", ".Git", "x/GIT~1/config", "x/git~1"]) {
  test(`${path} is refused as a .git component or its short name`, () => {
    const { result } = extract([blob(path)]);
    assert.equal(reasonFor(result, path), "a component is .git");
  });
}

for (const path of [".git./config", ".git /config", "a/b.", "a/b ", ".claude./x", ".ignore."]) {
  test(`${JSON.stringify(path)} is refused for a component ending in a dot or space`, () => {
    const { result } = extract([blob(path)]);
    assert.equal(reasonFor(result, path), "a component ends in a dot or space");
  });
}

test("a backslash, which is a separator on Windows, is refused", () => {
  const { result } = extract([blob("a\\..\\..\\x")]);
  assert.equal(reasonFor(result, "a\\..\\..\\x"), "a backslash");
});

test("a path whose bytes are not UTF-8 is refused", () => {
  const raw = Buffer.concat([Buffer.from(`100644 blob ${SHA}\tbad`), Buffer.from([0xff, 0xfe]), Buffer.from([0])]);
  const entries = parseLsTree(raw);
  assert.equal(entries[0].path, "bad\ufffd\ufffd");
  const { result } = extract(entries);
  assert.equal(reasonFor(result, entries[0].path), "not valid UTF-8");
});

test("a path with a newline is written and scope JSON-escapes it", () => {
  const path = "dir/two\nlines.md";
  const { out, result } = extract([blob(path, "body")]);
  assert.deepEqual(result.written, [path]);
  assert.equal(readFileSync(join(out, "dir", "two\nlines.md"), "utf8"), "body");
  const lines = scopeLines(result).split("\n");
  assert.deepEqual(lines, [JSON.stringify({ type: "written", path }), ""]);
  assert.ok(lines[0].includes("\\n"));
});

test("scope lists renames, then refusals, then written paths, one JSON record per line", () => {
  const { result } = extract([blob("../x"), blob(".ignore"), blob("ok")]);
  assert.equal(scopeLines(result), [
    { type: "renamed", from: ".ignore", to: ".ignore.ship-kit-renamed" },
    { type: "refused", path: "../x", reason: "a component is empty, . or .." },
    { type: "written", path: ".ignore.ship-kit-renamed" },
    { type: "written", path: "ok" },
  ].map((r) => `${JSON.stringify(r)}\n`).join(""));
  assert.equal(scopeLines({ written: [], refused: [], renamed: [] }), "");
});

test(".claude/skills/x/SKILL.md is renamed", () => {
  const { out, result } = extract([blob(".claude/skills/x/SKILL.md", "skill")]);
  assert.deepEqual(result.renamed, [
    { from: ".claude/skills/x/SKILL.md", to: ".claude.ship-kit-renamed/skills/x/SKILL.md" },
  ]);
  assert.deepEqual(result.written, [".claude.ship-kit-renamed/skills/x/SKILL.md"]);
  assert.equal(existsSync(join(out, ".claude")), false);
  assert.equal(readFileSync(join(out, ".claude.ship-kit-renamed", "skills", "x", "SKILL.md"), "utf8"), "skill");
});

test("every .claude component is renamed, compared case-insensitively", () => {
  assert.equal(targetPath("a/.claude/b/.claude/c"), "a/.claude.ship-kit-renamed/b/.claude.ship-kit-renamed/c");
  assert.equal(targetPath(".Claude/x"), ".Claude.ship-kit-renamed/x");
  assert.equal(targetPath("x.claude/y"), "x.claude/y");
});

test(".ignore and .rgignore basenames are renamed; x.ignore and a .ignore directory are not", () => {
  assert.equal(targetPath(".ignore"), ".ignore.ship-kit-renamed");
  assert.equal(targetPath("a/.rgignore"), "a/.rgignore.ship-kit-renamed");
  assert.equal(targetPath("a/.IGNORE"), "a/.IGNORE.ship-kit-renamed");
  assert.equal(targetPath("x.ignore"), "x.ignore");
  assert.equal(targetPath(".ignore/x"), ".ignore/x");
  const { result } = extract([blob("x.ignore")]);
  assert.deepEqual(result.renamed, []);
  assert.deepEqual(result.written, ["x.ignore"]);
});

test("a .claude rename colliding with an existing .claude.ship-kit-renamed is refused", () => {
  const entries = [blob(".claude/settings.json", "planted"), blob(".claude.ship-kit-renamed/settings.json", "real")];
  const { out, result } = extract(entries);
  assert.deepEqual(result.refused, [
    { path: ".claude/settings.json", reason: "renamed target exists in the tree: .claude.ship-kit-renamed/settings.json" },
  ]);
  assert.deepEqual(result.renamed, []);
  assert.deepEqual(result.written, [".claude.ship-kit-renamed/settings.json"]);
  assert.equal(readFileSync(join(out, ".claude.ship-kit-renamed", "settings.json"), "utf8"), "real");
});

test("a rename colliding case-insensitively with a tree path is refused", () => {
  const { result } = extract([blob(".IGNORE"), blob(".ignore.SHIP-KIT-RENAMED")]);
  assert.equal(reasonFor(result, ".IGNORE"), "renamed target exists in the tree: .IGNORE.ship-kit-renamed");
});

test("the collision case: a second entry at an existing path is refused and never overwrites", () => {
  const { out, result } = extract([blob("same", "first"), blob("same", "second")]);
  assert.deepEqual(result.written, ["same"]);
  assert.deepEqual(result.refused, [{ path: "same", reason: "collides with an existing path" }]);
  assert.equal(readFileSync(join(out, "same"), "utf8"), "first");
});

test("the collision case: a file already in the output is never overwritten", () => {
  const out = join(tmp(), "pr");
  mkdirSync(out);
  writeFileSync(join(out, "keep"), "original");
  const entries = [blob("keep", "replacement")];
  const { readBlob } = fakeRead(entries);
  const result = extractEntries(entries, { readBlob, out });
  assert.deepEqual(result.refused, [{ path: "keep", reason: "collides with an existing path" }]);
  assert.equal(readFileSync(join(out, "keep"), "utf8"), "original");
});

test("a file under a path that is already a file is refused", () => {
  const { result } = extract([blob("f", "file"), blob("f/g", "nested")]);
  assert.deepEqual(result.written, ["f"]);
  assert.deepEqual(result.refused, [{ path: "f/g", reason: "collides with an existing path" }]);
});

test("a file at a path that is already a directory is refused", () => {
  const { result } = extract([blob("d/e", "nested"), blob("d", "file")]);
  assert.deepEqual(result.refused, [{ path: "d", reason: "collides with an existing path" }]);
});

test("case-folded names that collide on disk are refused, never overwritten", () => {
  const { out, result } = extract([blob("Readme", "upper"), blob("README", "lower")]);
  const caseInsensitive = existsSync(join(out, "README")) && readdirSync(out).length === 1;
  if (caseInsensitive) {
    assert.deepEqual(result.refused, [{ path: "README", reason: "collides with an existing path" }]);
    assert.equal(readFileSync(join(out, "Readme"), "utf8"), "upper");
  } else {
    assert.deepEqual(result.written, ["Readme", "README"]);
  }
});

test("a symlink entry is written as its text, a submodule as its commit", () => {
  const entries = [
    blob("link", "../../etc/passwd", "120000"),
    { mode: "160000", type: "commit", sha: SUB_SHA, path: "sub" },
  ];
  const { out, result } = extract(entries);
  assert.deepEqual(result.written, ["link", "sub"]);
  assert.equal(lstatSync(join(out, "link")).isFile(), true);
  assert.equal(readFileSync(join(out, "link"), "utf8"), "symlink to ../../etc/passwd");
  assert.equal(readFileSync(join(out, "sub"), "utf8"), `submodule at ${SUB_SHA}`);
});

test("an executable blob is written 0644", { skip: isWindows }, () => {
  const { out } = extract([blob("run.sh", "#!/bin/sh\n", "100755")]);
  assert.equal(statSync(join(out, "run.sh")).mode & 0o777, 0o644);
});

test("an unsupported mode or a mode with the wrong type is refused", () => {
  const entries = [
    { mode: "040000", type: "tree", sha: SHA, path: "t" },
    { mode: "100644", type: "commit", sha: SHA, path: "c" },
    { mode: "160000", type: "blob", sha: SHA, path: "s" },
    { mode: "100664", type: "blob", sha: SHA, path: "old" },
  ];
  const { result } = extract(entries);
  assert.deepEqual(result.refused.map((r) => r.reason), Array(4).fill("unsupported entry"));
  assert.deepEqual(result.written, []);
});

// ---------------------------------------------------------------- limits

test("more entries than the limit throws before anything is written", () => {
  const entries = [blob("a"), blob("b"), blob("c")];
  const out = join(tmp(), "pr");
  mkdirSync(out);
  const { readBlob, calls } = fakeRead(entries);
  assert.throws(() => extractEntries(entries, { readBlob, out, maxEntries: 2 }), LimitError);
  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(out), []);
  assert.equal(MAX_ENTRIES, 100000);
});

test("blob bytes over the limit throw; each read is bounded by the remaining budget", () => {
  const entries = [blob("a", "12345"), blob("b", "678"), blob("c", "9")];
  const out = join(tmp(), "pr");
  mkdirSync(out);
  const { readBlob, calls } = fakeRead(entries);
  assert.throws(() => extractEntries(entries, { readBlob, out, maxBytes: 8 }), LimitError);
  assert.deepEqual(calls.map((c) => c.max), [8, 3, 0]);
  assert.equal(MAX_BYTES, 512 * 1024 * 1024);
});

test("a symlink target counts toward the byte limit", () => {
  const { result } = extract([blob("l", "abc", "120000")], { maxBytes: 3 });
  assert.deepEqual(result.written, ["l"]);
  assert.throws(() => extract([blob("l", "abcd", "120000")], { maxBytes: 3 }), LimitError);
});

// ---------------------------------------------------------------- parsing

test("parseLsTree reads NUL-terminated records, tabs and newlines in paths included", () => {
  const raw = Buffer.from(
    `100644 blob ${SHA}\ta\tb\x00120000 blob ${SHA}\tl\n2\x00160000 commit ${SUB_SHA}\tsub\x00`,
  );
  assert.deepEqual(parseLsTree(raw), [
    { mode: "100644", type: "blob", sha: SHA, path: "a\tb" },
    { mode: "120000", type: "blob", sha: SHA, path: "l\n2" },
    { mode: "160000", type: "commit", sha: SUB_SHA, path: "sub" },
  ]);
  assert.deepEqual(parseLsTree(Buffer.alloc(0)), []);
});

for (const [name, raw] of [
  ["a record with no tab", `100644 blob ${SHA} a\x00`],
  ["a short sha", `100644 blob abc\ta\x00`],
  ["an upper-case sha", `100644 blob ${"A".repeat(40)}\ta\x00`],
  ["a missing final NUL", `100644 blob ${SHA}\ta`],
  ["a bad mode", `10064 blob ${SHA}\ta\x00`],
  ["an extra field", `100644 blob x ${SHA}\ta\x00`],
]) {
  test(`parseLsTree throws on ${name}`, () => {
    assert.throws(() => parseLsTree(Buffer.from(raw)), /unparseable ls-tree/);
  });
}

test("refusalReason accepts ordinary paths", () => {
  for (const path of ["a", "a/b.c", ".gitmodules", ".github/workflows/x.yml", "a b/c", ".gitignore"]) {
    assert.equal(refusalReason(path), null, path);
  }
});

// ---------------------------------------------------------------- arguments

test("parseArgs requires a 40-hex commit, --out and --scope", () => {
  const ok = parseArgs(["--commit", SHA, "--out", "o", "--scope", "s"]);
  assert.deepEqual(ok, { commit: SHA, out: "o", scope: "s" });
  for (const argv of [
    [],
    ["--commit", SHA, "--out", "o"],
    ["--commit", SHA.slice(1), "--out", "o", "--scope", "s"],
    ["--commit", `${SHA}0`, "--out", "o", "--scope", "s"],
    ["--commit", "g".repeat(40), "--out", "o", "--scope", "s"],
    ["--commit", "HEAD", "--out", "o", "--scope", "s"],
    ["--commit", SHA, "--out", "o", "--scope"],
    ["--commit", SHA, "--out", "o", "--scope", "s", "--extra", "x"],
    ["--commit", SHA, "--out", "", "--scope", "s"],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, JSON.stringify(argv));
  }
});

// ---------------------------------------------------------------- real repository

const gitEnv = { ...isolatedEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args, input) =>
  execFileSync("git", args, { cwd, env: gitEnv, input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

// A repository with every entry kind the extractor handles.
function fixtureRepo() {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  const put = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  put("README.md", "line one\nline two\n");
  put("bin/run.sh", "#!/bin/sh\necho hi\n");
  if (!isWindows) chmodSync(join(repo, "bin/run.sh"), 0o755);
  put(".ignore", "*.md\n");
  put("a/.rgignore", "*\n");
  put("a/kept.txt", "kept\n");
  put("x.ignore", "not an ignore file\n");
  put(".claude/skills/x/SKILL.md", "---\nname: x\n---\nplanted\n");
  put("pkg/.claude/settings.json", "{}\n");
  put(".gitmodules", '[submodule "sub"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n');
  put(".gitattributes", "*.txt text eol=crlf\n*.bin filter=evil\n");
  put("crlf.txt", "lf only\n");
  put("data.bin", "raw\n");
  git(repo, ["add", "."]);
  const linkSha = git(repo, ["hash-object", "-w", "--stdin"], "README.md");
  git(repo, ["update-index", "--add", "--cacheinfo", `120000,${linkSha},link`]);
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${SUB_SHA},sub`]);
  if (!isWindows) git(repo, ["update-index", "--chmod=+x", "bin/run.sh"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-q", "--no-verify", "-m", "fixture"]);
  return { repo, commit: git(repo, ["rev-parse", "HEAD"]) };
}

const FIXTURE = fixtureRepo();

function runMain(extraDeps = {}, { out, scope } = {}) {
  const dir = tmp();
  const outDir = out ?? join(dir, "pr");
  const scopeFile = scope ?? join(dir, "scope.txt");
  const { io, out: stdout, err } = silentIo();
  const code = main(
    ["--commit", FIXTURE.commit, "--out", outDir, "--scope", scopeFile],
    { git: gitRunner(FIXTURE.repo), ...extraDeps },
    io,
  );
  return { code, out: outDir, scope: scopeFile, stdout: stdout.join(""), stderr: err.join("") };
}

test("the fixture repository is extracted exactly as the rules say", () => {
  const { code, out, scope, stdout } = runMain();
  assert.equal(code, 0, stdout);
  const read = (p) => readFileSync(join(out, p), "utf8");
  assert.equal(read("README.md"), "line one\nline two\n");
  assert.equal(read("bin/run.sh"), "#!/bin/sh\necho hi\n");
  assert.equal(read(".ignore.ship-kit-renamed"), "*.md\n");
  assert.equal(read("a/.rgignore.ship-kit-renamed"), "*\n");
  assert.equal(read("a/kept.txt"), "kept\n");
  assert.equal(read("x.ignore"), "not an ignore file\n");
  assert.equal(read(".claude.ship-kit-renamed/skills/x/SKILL.md"), "---\nname: x\n---\nplanted\n");
  assert.equal(read("pkg/.claude.ship-kit-renamed/settings.json"), "{}\n");
  assert.match(read(".gitmodules"), /submodule "sub"/);
  assert.equal(read("sub"), `submodule at ${SUB_SHA}`);
  assert.equal(read("crlf.txt"), "lf only\n", "no eol attribute applied");
  assert.equal(read("data.bin"), "raw\n", "no filter applied");
  assert.equal(existsSync(join(out, ".ignore")), false);
  assert.equal(existsSync(join(out, "a", ".rgignore")), false);
  assert.equal(existsSync(join(out, ".claude")), false);
  assert.equal(existsSync(join(out, "pkg", ".claude")), false);
  assert.equal(existsSync(join(out, ".git")), false);

  const records = readFileSync(scope, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.filter((r) => r.type === "renamed"), [
    { type: "renamed", from: ".claude/skills/x/SKILL.md", to: ".claude.ship-kit-renamed/skills/x/SKILL.md" },
    { type: "renamed", from: ".ignore", to: ".ignore.ship-kit-renamed" },
    { type: "renamed", from: "a/.rgignore", to: "a/.rgignore.ship-kit-renamed" },
    { type: "renamed", from: "pkg/.claude/settings.json", to: "pkg/.claude.ship-kit-renamed/settings.json" },
  ]);
  assert.deepEqual(records.filter((r) => r.type === "refused"), []);
  assert.equal(records.filter((r) => r.type === "written").length, 14);
  assert.match(stdout, /14 written, 4 renamed, 0 refused/);
});

test("the fixture's symlink is written as its symlink to <target> text", () => {
  const { out } = runMain();
  assert.equal(lstatSync(join(out, "link")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(out, "link"), "utf8"), "symlink to README.md");
});

test("the fixture's executable is written 0644 and nothing under the output is a symlink or executable", { skip: isWindows }, () => {
  const { out } = runMain();
  assert.equal(statSync(join(out, "bin/run.sh")).mode & 0o777, 0o644);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    assert.equal(d.isSymbolicLink(), false, p);
    if (d.isDirectory()) return walk(p);
    assert.equal(statSync(p).mode & 0o111, 0, p);
    return [p];
  });
  assert.equal(walk(out).length, 14);
});

test("an absent --out is created", () => {
  const out = join(tmp(), "deep", "pr");
  assert.equal(runMain({}, { out }).code, 0);
  assert.equal(statSync(out).isDirectory(), true);
});

test("an existing empty --out is accepted", () => {
  const out = tmp();
  assert.equal(runMain({}, { out }).code, 0);
});

test("a non-empty --out is refused with exit 2 and left untouched", () => {
  const out = tmp();
  writeFileSync(join(out, "x"), "x");
  const { code, stderr } = runMain({}, { out });
  assert.equal(code, 2);
  assert.match(stderr, /not empty/);
  assert.deepEqual(readdirSync(out), ["x"]);
});

test("an --out that is a symlink to an empty directory is refused with exit 2", { skip: isWindows }, () => {
  const target = tmp();
  const out = join(tmp(), "link");
  symlinkSync(target, out);
  const { code, stderr } = runMain({}, { out });
  assert.equal(code, 2);
  assert.match(stderr, /symlink/);
  assert.deepEqual(readdirSync(target), []);
});

test("an --out that is a file is refused with exit 2", () => {
  const out = join(tmp(), "file");
  writeFileSync(out, "");
  assert.equal(runMain({}, { out }).code, 2);
});

test("a --scope inside --out is refused with exit 2", () => {
  const out = join(tmp(), "pr");
  const { code, stderr } = runMain({}, { out, scope: join(out, "scope.txt") });
  assert.equal(code, 2);
  assert.match(stderr, /--scope must not be inside --out/);
});

test("a 40-hex name that is a tree, not a commit, exits 1", () => {
  const tree = git(FIXTURE.repo, ["rev-parse", "HEAD^{tree}"]);
  const dir = tmp();
  const { io, err } = silentIo();
  const code = main(["--commit", tree, "--out", join(dir, "pr"), "--scope", join(dir, "scope.txt")],
    { git: gitRunner(FIXTURE.repo) }, io);
  assert.equal(code, 1);
  assert.match(err.join(""), /failed \(exit 128\)/);
  assert.equal(existsSync(join(dir, "scope.txt")), false);
});

test("a commit that is not 40 hex exits 2", () => {
  const { io, err } = silentIo();
  assert.equal(main(["--commit", "HEAD", "--out", join(tmp(), "o"), "--scope", join(tmp(), "s")], {}, io), 2);
  assert.match(err.join(""), /40 lower-case hex/);
});

test("a git that exits 128 exits 1 and writes no scope", () => {
  const dir = tmp();
  const scope = join(dir, "scope.txt");
  const { io, err } = silentIo();
  const code = main(
    ["--commit", "c".repeat(40), "--out", join(dir, "pr"), "--scope", scope],
    { git: gitRunner(FIXTURE.repo) },
    io,
  );
  assert.equal(code, 1);
  assert.match(err.join(""), /git ls-tree .* failed \(exit 128\)/);
  assert.equal(existsSync(scope), false);
});

test("100,001 entries exceed the injected limit and exit 1", () => {
  const records = Buffer.from(Array.from({ length: 100001 }, (_, i) => `100644 blob ${SHA}\tf${i}\x00`).join(""));
  const fakeGit = (args) => {
    if (args[0] === "ls-tree") return records;
    throw new Error("a blob was read before the entry limit was checked");
  };
  const { code, stderr, scope } = runMain({ git: fakeGit, limits: { maxEntries: 100000 } });
  assert.equal(code, 1);
  assert.match(stderr, /100001 tree entries exceed the limit of 100000/);
  assert.equal(existsSync(scope), false);
});

test("blob bytes over the injected limit exit 1", () => {
  const { code, stderr } = runMain({ limits: { maxBytes: 10 } });
  assert.equal(code, 1);
  assert.match(stderr, /exceed the limit of 10 bytes/);
});

test("gitRunner bounds every call with the timeout and maps a buffer overflow to a limit", () => {
  assert.equal(GIT_TIMEOUT_MS, 120000);
  const run = gitRunner(FIXTURE.repo);
  const readme = git(FIXTURE.repo, ["rev-parse", "HEAD:README.md"]);
  assert.equal(run(["cat-file", "blob", readme], 100).toString(), "line one\nline two\n");
  assert.throws(() => run(["cat-file", "blob", readme], 5), LimitError);
  assert.throws(() => run(["cat-file", "blob", readme], 0), LimitError);
  assert.throws(() => run(["no-such-command"], 100), /git no-such-command failed/);
});

test("the timeout kills a hung git and is reported as a failure", () => {
  const run = gitRunner(FIXTURE.repo, { timeout: 50, command: process.execPath });
  assert.throws(() => run(["-e", "setTimeout(() => {}, 5000)"], 100), /failed \(timed out\)/);
});

test("the script runs as a command with exit codes 0 and 2", () => {
  const dir = tmp();
  const ok = spawnSync(process.execPath,
    [SCRIPT, "--commit", FIXTURE.commit, "--out", join(dir, "pr"), "--scope", join(dir, "scope.txt")],
    { cwd: FIXTURE.repo, env: isolatedEnv(), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(join(dir, "pr", "link"), "utf8"), "symlink to README.md");
  const bad = spawnSync(process.execPath, [SCRIPT, "--commit", "x"], { cwd: FIXTURE.repo, env: isolatedEnv(), encoding: "utf8" });
  assert.equal(bad.status, 2);
});
