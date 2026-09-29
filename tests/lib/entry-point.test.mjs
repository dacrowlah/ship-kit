import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { isMain } from "../../scripts/lib/entry-point.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every module under scripts/ (tests aside) whose code, not its comments, reads the script path it was started with. */
function commandModules() {
  const code = (path) => readFileSync(join(ROOT, path), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
  return globSync("scripts/**/*.{mjs,js,cjs}", { cwd: ROOT })
    .filter((path) => !/\.test\.[cm]?js$/.test(path))
    .filter((path) => code(path).some((line) => line.includes("process.argv[1]")))
    .sort();
}

test("isMain is true through a symlinked file or directory, and for a path holding a space, a percent sign or a hash", (t) => {
  const dir = tempDir(t);
  const real = join(dir, "real dir %41 #x", "script.mjs");
  mkdirSync(dirname(real));
  writeFileSync(real, "");
  symlinkSync(real, join(dir, "file-link.mjs"));
  symlinkSync(dirname(real), join(dir, "dir-link"));
  const url = pathToFileURL(real).href;
  for (const argv1 of [real, join(dir, "file-link.mjs"), join(dir, "dir-link", "script.mjs")]) {
    assert.equal(isMain(argv1, url), true, argv1);
  }
  assert.equal(isMain(real, pathToFileURL(join(dir, "file-link.mjs")).href), true);
});

test("isMain is false for another file, a missing path, no path, or a module URL that is not a file", (t) => {
  const dir = tempDir(t);
  const [a, b] = [join(dir, "a.mjs"), join(dir, "b.mjs")];
  writeFileSync(a, "");
  writeFileSync(b, "");
  const url = pathToFileURL(a).href;
  assert.equal(isMain(b, url), false);
  assert.equal(isMain(join(dir, "missing.mjs"), url), false);
  assert.equal(isMain(undefined, url), false);
  assert.equal(isMain("", url), false);
  assert.equal(isMain(a, pathToFileURL(join(dir, "missing.mjs")).href), false);
  assert.equal(isMain(a, "data:text/javascript,0"), false);
});

test("every command under scripts/ decides it was started with isMain, never a URL string comparison", () => {
  const modules = commandModules();
  for (const known of ["scripts/assert-test-globs.mjs", "scripts/check-template-secrets.mjs", "scripts/mining/collect.mjs",
    "scripts/release/bump-version.mjs", "scripts/review/extract-tree.mjs"]) {
    assert.ok(modules.includes(known), `${known} is not found as a command`);
  }
  for (const path of modules) {
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.match(source, /^if \(isMain\(process\.argv\[1\], import\.meta\.url\)\) \{$/m, path);
    assert.doesNotMatch(source, /import\.meta\.url\s*===|===\s*import\.meta\.url/, path);
  }
});

test("every command under scripts/ runs when started through a symlink", (t) => {
  const links = tempDir(t);
  const cwd = tempDir(t);
  for (const path of commandModules()) {
    const link = join(links, path.replaceAll("/", "-"));
    symlinkSync(join(ROOT, path), link);
    const result = spawnSync(process.execPath, [link], { cwd, env: isolatedEnv(), encoding: "utf8" });
    assert.equal(result.error, undefined, path);
    assert.notEqual(`${result.stdout}${result.stderr}`, "", `${path} printed nothing through a symlink`);
  }
});
