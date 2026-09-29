import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SEAT_SKILLS } from "../../scripts/review/review-mode.mjs";
import { listSkills } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const LOOSE = /^skill_marker:/;
const STRICT = /^skill_marker: ([^@\s]+)@([^:\s]+):(\S+)$/;
const TOKEN = /^[0-9a-f]{16}$/;
const PLACEHOLDER = "0".repeat(16);
/** Seats whose skills ship in this release (design 10.1). */
export const RELEASED_SEATS = ["general", "adversarial"];

/**
 * Every tracked file under `root`, from `git ls-files`. A git failure
 * throws, so the scan never silently covers nothing.
 * @param {string} root @returns {string[]}
 */
export function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files exited ${result.status}: ${result.stderr}`);
  const files = result.stdout.split("\0").filter((path) => path !== "");
  if (files.length === 0) throw new Error(`git ls-files listed no file in ${root}`);
  return files;
}

/** @param {string} haystack @param {string} needle @returns {number} occurrences, case-insensitively */
const count = (haystack, needle) => haystack.toLowerCase().split(needle.toLowerCase()).length - 1;

/**
 * The marker rules of design 6.4: each SKILL.md with a marker has exactly
 * one, naming its own directory and plugin.json's version, with a 16-hex
 * token that appears once in its SKILL.md, in no other tracked file (in any
 * case), and in no other skill's marker.
 * @param {string} root plugin root
 * @param {{tracked?: string[]}} [options] the tracked files to scan
 * @returns {string[]} violations
 */
export function checkMarkers(root, { tracked = listTrackedFiles(root) } = {}) {
  const version = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
  const violations = [];
  const tokens = new Map();
  for (const skill of listSkills(root)) {
    if (skill.text === null) continue;
    const where = `skills/${skill.name}/SKILL.md`;
    const lines = skill.text.split("\n").filter((line) => LOOSE.test(line));
    if (lines.length === 0) continue;
    if (lines.length > 1) {
      violations.push(`${where}: ${lines.length} skill_marker lines, expected one`);
      continue;
    }
    const match = STRICT.exec(lines[0]);
    if (!match) {
      violations.push(`${where}: malformed skill_marker line`);
      continue;
    }
    const [, name, markerVersion, token] = match;
    if (name !== skill.name) violations.push(`${where}: marker names ${name}, expected ${skill.name}`);
    if (markerVersion !== version) violations.push(`${where}: marker version ${markerVersion} differs from plugin.json ${version}`);
    if (!TOKEN.test(token) || token === PLACEHOLDER) {
      violations.push(`${where}: token is not 16 random lowercase hex characters`);
      continue;
    }
    if (count(skill.text, token) !== 1) violations.push(`${where}: token appears more than once in its SKILL.md`);
    if (tokens.has(token)) violations.push(`${where}: token equals the token of skills/${tokens.get(token)}/SKILL.md`);
    else tokens.set(token, skill.name);
  }
  for (const path of tracked) {
    const file = join(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const text = readFileSync(file).toString("latin1");
    for (const [token, owner] of tokens) {
      if (path === `skills/${owner}/SKILL.md`) continue;
      if (count(text, token) > 0) violations.push(`${path}: holds the live marker token of skills/${owner}/SKILL.md; write it as <token>`);
    }
  }
  return violations;
}

/**
 * The seat skills this release ships exist and carry a marker line.
 * @param {string} root @returns {string[]}
 */
export function checkSeatSkills(root) {
  return RELEASED_SEATS.flatMap((seat) => {
    const path = join(root, "skills", SEAT_SKILLS[seat], "SKILL.md");
    if (!existsSync(path)) return [`seat ${seat}: skills/${SEAT_SKILLS[seat]}/SKILL.md does not exist`];
    const markers = readFileSync(path, "utf8").split("\n").filter((line) => LOOSE.test(line));
    return markers.length === 1 ? [] : [`seat ${seat}: skills/${SEAT_SKILLS[seat]}/SKILL.md has ${markers.length} marker lines`];
  });
}

test("every marker in this repository is well formed and its token is unique", () => {
  assert.deepEqual(checkMarkers(REPO), []);
});

test("the general and adversarial seat skills exist and carry markers", () => {
  assert.deepEqual(checkSeatSkills(REPO), []);
});

// Fixture plugin: two marked skills and one unmarked.
const MARK_A = "a1b2c3d4e5f60718";
const MARK_B = "b2c3d4e5f6071829";
const skillText = (name, markers) => `---\nname: ${name}\ndescription: Use when testing.\n---\n\nBody.\n\n${markers.join("\n")}\n`;

/** @param {Record<string, string>} [over] path -> content @returns {{root: string, tracked: string[]}} */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "marker-"));
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "ship-kit", version: "0.1.0" }),
    "skills/reviewing-x/SKILL.md": skillText("reviewing-x", [`skill_marker: reviewing-x@0.1.0:${MARK_A}`]),
    "skills/hunting-y/SKILL.md": skillText("hunting-y", [`skill_marker: hunting-y@0.1.0:${MARK_B}`]),
    "skills/plain-z/SKILL.md": skillText("plain-z", []),
    "tests/skills/reviewing-x/result.md": "Returned skill_marker reviewing-x@0.1.0:<token>.\n",
    "README.md": "# Fixture\n",
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, tracked: Object.keys(files) };
}

const check = ({ root, tracked }) => checkMarkers(root, { tracked });

test("the fixture passes, with <token> standing in for a token in a record", () => {
  assert.deepEqual(check(fixture()), []);
});

test("a SKILL.md with two marker lines fails", () => {
  const text = skillText("reviewing-x", [`skill_marker: reviewing-x@0.1.0:${MARK_A}`, "skill_marker: reviewing-x@0.1.0:c3d4e5f607182930"]);
  assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": text })), ["skills/reviewing-x/SKILL.md: 2 skill_marker lines, expected one"]);
});

test("a marker naming another directory fails", () => {
  const text = skillText("reviewing-x", [`skill_marker: hunting-y@0.1.0:${MARK_A}`]);
  assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": text })), ["skills/reviewing-x/SKILL.md: marker names hunting-y, expected reviewing-x"]);
});

test("a marker version other than plugin.json's fails", () => {
  const text = skillText("reviewing-x", [`skill_marker: reviewing-x@0.2.0:${MARK_A}`]);
  assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": text })), [
    "skills/reviewing-x/SKILL.md: marker version 0.2.0 differs from plugin.json 0.1.0",
  ]);
});

test("a token that is not 16 lowercase hex, or is the placeholder, fails", () => {
  for (const token of ["a1b2c3d4e5f6071", "a1b2c3d4e5f607182", "A1B2C3D4E5F60718", "g1b2c3d4e5f60718", PLACEHOLDER]) {
    const text = skillText("reviewing-x", [`skill_marker: reviewing-x@0.1.0:${token}`]);
    assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": text })), [
      "skills/reviewing-x/SKILL.md: token is not 16 random lowercase hex characters",
    ], token);
  }
});

test("a malformed marker line fails, including one with no space or a trailing word", () => {
  for (const line of [`skill_marker:reviewing-x@0.1.0:${MARK_A}`, `skill_marker: reviewing-x@0.1.0:${MARK_A} extra`, "skill_marker: reviewing-x"]) {
    const text = skillText("reviewing-x", [line]);
    assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": text })), ["skills/reviewing-x/SKILL.md: malformed skill_marker line"], line);
  }
});

test("two skills sharing a token fail", () => {
  const text = skillText("hunting-y", [`skill_marker: hunting-y@0.1.0:${MARK_A}`]);
  assert.deepEqual(check(fixture({ "skills/hunting-y/SKILL.md": text })), [
    "skills/reviewing-x/SKILL.md: token equals the token of skills/hunting-y/SKILL.md",
    "skills/reviewing-x/SKILL.md: holds the live marker token of skills/hunting-y/SKILL.md; write it as <token>",
  ]);
});

test("a token duplicated in a README fails", () => {
  assert.deepEqual(check(fixture({ "README.md": `Marker: reviewing-x@0.1.0:${MARK_A}\n` })), [
    "README.md: holds the live marker token of skills/reviewing-x/SKILL.md; write it as <token>",
  ]);
});

test("a fixture token copied into a tests/skills result.md fails", () => {
  const record = `Returned skill_marker reviewing-x@0.1.0:${MARK_A}.\n`;
  assert.deepEqual(check(fixture({ "tests/skills/reviewing-x/result.md": record })), [
    "tests/skills/reviewing-x/result.md: holds the live marker token of skills/reviewing-x/SKILL.md; write it as <token>",
  ]);
});

test("a token in another case, in a reference file of its own skill, or twice in its SKILL.md fails", () => {
  const upper = check(fixture({ "docs/notes.md": `token ${MARK_B.toUpperCase()}\n` }));
  assert.deepEqual(upper, ["docs/notes.md: holds the live marker token of skills/hunting-y/SKILL.md; write it as <token>"]);
  const reference = check(fixture({ "skills/hunting-y/method.md": `${MARK_B}\n` }));
  assert.deepEqual(reference, ["skills/hunting-y/method.md: holds the live marker token of skills/hunting-y/SKILL.md; write it as <token>"]);
  const twice = skillText("reviewing-x", [`skill_marker: reviewing-x@0.1.0:${MARK_A}`, `Echo ${MARK_A}.`]);
  assert.deepEqual(check(fixture({ "skills/reviewing-x/SKILL.md": twice })), ["skills/reviewing-x/SKILL.md: token appears more than once in its SKILL.md"]);
});

test("the scan covers only tracked files, and a git failure throws", () => {
  const { root, tracked } = fixture();
  writeFileSync(join(root, "scratch.txt"), MARK_A);
  assert.deepEqual(checkMarkers(root, { tracked }), []);
  assert.throws(() => listTrackedFiles(root), /git ls-files|not a git repository/);
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.throws(() => listTrackedFiles(root), /listed no file/);
  assert.equal(git("add", "README.md", "tests/skills/reviewing-x/result.md", "skills").status, 0);
  assert.deepEqual(checkMarkers(root), []);
  writeFileSync(join(root, "README.md"), MARK_A);
  assert.deepEqual(checkMarkers(root), ["README.md: holds the live marker token of skills/reviewing-x/SKILL.md; write it as <token>"]);
});

test("a missing released seat skill, or one without a marker, fails", () => {
  const root = mkdtempSync(join(tmpdir(), "marker-seat-"));
  const general = join(root, "skills", SEAT_SKILLS.general);
  mkdirSync(general, { recursive: true });
  writeFileSync(join(general, "SKILL.md"), skillText(SEAT_SKILLS.general, []));
  assert.deepEqual(checkSeatSkills(root), [
    `seat general: skills/${SEAT_SKILLS.general}/SKILL.md has 0 marker lines`,
    `seat adversarial: skills/${SEAT_SKILLS.adversarial}/SKILL.md does not exist`,
  ]);
  assert.equal(readFileSync(join(general, "SKILL.md"), "utf8").includes("skill_marker"), false);
});
