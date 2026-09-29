import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { checkStream, main, readMarker, shippedTextHash, stage } from "./pressure.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(HERE, "pressure.mjs");
const INVOKED = readFileSync(join(HERE, "fixtures", "stream-invoked.jsonl"), "utf8");
const LISTED = readFileSync(join(HERE, "fixtures", "stream-listed-not-invoked.jsonl"), "utf8");
const SKILL = "proving-tests-can-fail";
const HEX = "0123456789abcdef";
const MARKER = `${SKILL}@0.1.0:${HEX}`;

/** @param {string} text @returns {object[]} */
const parse = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
/** @param {object[]} messages @returns {string} */
const join_ = (messages) => messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
const finalResult = (text) => parse(text).filter((m) => m.type === "result").at(-1).result;

/** Rewrites the stream's final result message. @returns {string} */
function withResult(text, edit) {
  const messages = parse(text);
  const last = messages.findLastIndex((m) => m.type === "result");
  messages[last] = edit({ ...messages[last] });
  return join_(messages);
}

/** Captures a main() run. */
function run(argv, extra = {}) {
  let out = "";
  let err = "";
  const code = main(argv, {
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    ...extra,
  });
  return { code, out, err };
}

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** A skill directory holding the given files. @returns {string} */
function skillDir(files) {
  const dir = tmp("pressure-skill-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** A plugin source tree for stage(). @returns {string} */
function pluginRoot() {
  const root = tmp("pressure-root-");
  mkdirSync(join(root, ".claude-plugin"));
  const manifest = { name: "ship-kit", version: "0.1.0", dependencies: [{ name: "superpowers" }] };
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), "{}\n");
  mkdirSync(join(root, "skills", "a-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "a-skill", "SKILL.md"), "skill\n");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "x.mjs"), "x\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "design.md"), "answers\n");
  return root;
}

// --- check ---------------------------------------------------------------

test("a real invoked stream passes", () => {
  const verdict = checkStream(INVOKED, { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.text, finalResult(INVOKED));
  assert.ok(verdict.text.length > 0);
});

test("listed but never invoked fails", () => {
  const verdict = checkStream(LISTED, { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no Skill tool call invoked ship-kit:proving-tests-can-fail/);
});

test("another skill invoked fails", () => {
  const other = INVOKED.split('"skill":"ship-kit:proving-tests-can-fail"').join('"skill":"ship-kit:other"');
  assert.notEqual(other, INVOKED);
  const verdict = checkStream(other, { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no Skill tool call/);
});

test("init missing fails", () => {
  const messages = parse(INVOKED).filter((m) => !(m.type === "system" && m.subtype === "init"));
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no system\/init message/);
});

test("two init messages fail", () => {
  const messages = parse(INVOKED);
  const verdict = checkStream(join_([messages[0], ...messages]), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /more than one system\/init/);
});

test("init that does not list the skill fails", () => {
  const messages = parse(INVOKED);
  const init = messages[0];
  init.skills = init.skills.filter((s) => s !== `ship-kit:${SKILL}`);
  init.slash_commands = init.slash_commands.filter((s) => s !== `ship-kit:${SKILL}`);
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /init lists ship-kit:proving-tests-can-fail in neither skills nor slash_commands/);
});

test("init listing the skill only in slash_commands passes", () => {
  const messages = parse(INVOKED);
  messages[0].skills = [];
  assert.equal(checkStream(join_(messages), { skill: SKILL, dmi: false }).ok, true);
  messages[0].skills = "ship-kit:proving-tests-can-fail";
  messages[0].slash_commands = "ship-kit:proving-tests-can-fail";
  assert.equal(checkStream(join_(messages), { skill: SKILL, dmi: false }).ok, false, "non-array lists never match");
});

test("a Skill call before the init message does not count", () => {
  const messages = parse(INVOKED);
  const call = messages.findIndex((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Skill"'));
  const [skillCall] = messages.splice(call, 1);
  const verdict = checkStream(join_([skillCall, ...messages]), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no Skill tool call/);
});

test("a Skill call made inside a subagent does not count", () => {
  const messages = parse(INVOKED);
  const call = messages.find((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Skill"'));
  call.parent_tool_use_id = "toolu_parent";
  assert.equal(checkStream(join_(messages), { skill: SKILL, dmi: false }).ok, false);
});

test("a Skill call whose result is an error or missing fails", () => {
  const messages = parse(INVOKED);
  const call = messages.find((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Skill"'));
  const id = call.message.content.find((c) => c.name === "Skill").id;
  const resultMsg = messages.find(
    (m) => m.type === "user" && Array.isArray(m.message?.content) && m.message.content.some((c) => c.tool_use_id === id),
  );
  resultMsg.message.content.find((c) => c.tool_use_id === id).is_error = true;
  const errored = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(errored.ok, false);
  assert.match(errored.reason, /no Skill tool call/);
  const withoutResult = messages.filter((m) => m !== resultMsg);
  assert.equal(checkStream(join_(withoutResult), { skill: SKILL, dmi: false }).ok, false);
});

test("truncated stream fails", () => {
  const messages = parse(INVOKED).filter((m) => m.type !== "result");
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no final result message/);
});

test("a result message that is not last, is an error or has no text fails", () => {
  const messages = parse(INVOKED);
  const notLast = checkStream(join_([...messages, messages[1]]), { skill: SKILL, dmi: false });
  assert.equal(notLast.ok, false);
  assert.match(notLast.reason, /no final result message/);
  const errored = checkStream(withResult(INVOKED, (m) => ({ ...m, is_error: true })), { skill: SKILL, dmi: false });
  assert.equal(errored.ok, false);
  assert.match(errored.reason, /final result message is an error/);
  const noText = checkStream(withResult(INVOKED, (m) => ({ ...m, result: 42 })), { skill: SKILL, dmi: false });
  assert.equal(noText.ok, false);
  assert.match(noText.reason, /final result message has no result text/);
});

test("garbage lines are ignored", () => {
  const lines = INVOKED.split("\n");
  const noisy = lines.flatMap((line, i) => [line, i % 3 === 0 ? "not json {" : "", '"a string"', "null", "[1]"]).join("\n");
  const verdict = checkStream(noisy, { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.text, finalResult(INVOKED));
});

test("an empty stream fails", () => {
  assert.equal(checkStream("", { skill: SKILL, dmi: false }).ok, false);
});

test("dmi marker must match", () => {
  const good = withResult(INVOKED, (m) => ({ ...m, structured_output: { skill_marker: MARKER } }));
  const ok = checkStream(good, { skill: SKILL, dmi: true, marker: MARKER });
  assert.equal(ok.ok, true, ok.reason);
  const bad = withResult(INVOKED, (m) => ({ ...m, structured_output: { skill_marker: `${MARKER.slice(0, -1)}e` } }));
  const verdict = checkStream(bad, { skill: SKILL, dmi: true, marker: MARKER });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /skill_marker differs from the SKILL\.md marker/);
});

test("dmi does not need a Skill call but still needs the init listing", () => {
  const good = withResult(LISTED, (m) => ({ ...m, structured_output: { skill_marker: MARKER } }));
  assert.equal(checkStream(good, { skill: SKILL, dmi: true, marker: MARKER }).ok, true);
  const messages = parse(good);
  messages[0].skills = [];
  messages[0].slash_commands = [];
  assert.equal(checkStream(join_(messages), { skill: SKILL, dmi: true, marker: MARKER }).ok, false);
});

test("dmi with no structured_output fails", () => {
  const verdict = checkStream(INVOKED, { skill: SKILL, dmi: true, marker: MARKER });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no structured_output\.skill_marker/);
  const nonString = withResult(INVOKED, (m) => ({ ...m, structured_output: { skill_marker: 7 } }));
  assert.equal(checkStream(nonString, { skill: SKILL, dmi: true, marker: MARKER }).ok, false);
});

test("dmi without an expected marker fails closed", () => {
  const good = withResult(INVOKED, (m) => ({ ...m, structured_output: { skill_marker: MARKER } }));
  const verdict = checkStream(good, { skill: SKILL, dmi: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no skill_marker line/);
});

test("printed text never holds the marker token", () => {
  const quoted = withResult(INVOKED, (m) => ({
    ...m,
    result: `Loaded.\nskill_marker: ${MARKER}\nAgain ${HEX.toUpperCase()} and ${HEX}.`,
    structured_output: { skill_marker: MARKER },
  }));
  const verdict = checkStream(quoted, { skill: SKILL, dmi: true, marker: MARKER });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.ok(verdict.text.includes(`skill_marker: ${SKILL}@0.1.0:<token>`));
  assert.ok(!verdict.text.toLowerCase().includes(HEX));
  const plain = checkStream(withResult(INVOKED, (m) => ({ ...m, result: `x ${HEX}` })), {
    skill: SKILL,
    dmi: false,
    marker: MARKER,
  });
  assert.equal(plain.text, "x <token>");
});

// --- marker --------------------------------------------------------------

test("readMarker takes the single skill_marker line and refuses a malformed or repeated one", () => {
  assert.equal(readMarker(`---\nname: x\n---\nskill_marker: ${MARKER}\r\nbody\n`), MARKER);
  assert.equal(readMarker("---\nname: x\n---\nbody\n"), null);
  assert.throws(() => readMarker(`skill_marker: ${MARKER}\nskill_marker: ${MARKER}\n`), /more than one/);
  assert.throws(() => readMarker("skill_marker: x@0.1.0:nothex\n"), /malformed/);
});

// --- hash ----------------------------------------------------------------

test("hash ignores marker lines only", () => {
  const a = skillDir({ "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\n`, "ref.md": "ref\n" });
  const b = skillDir({ "SKILL.md": `# S\nskill_marker: ${SKILL}@0.2.0:fedcba9876543210\nbody\n`, "ref.md": "ref\n" });
  const c = skillDir({ "SKILL.md": `# S\nskill_marker: ${MARKER}\nbodY\n`, "ref.md": "ref\n" });
  const d = skillDir({ "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\n`, "ref.md": "ref\n", "extra.md": "\n" });
  const e = skillDir({ "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\n`, "ref.md": "ref\n", "notes.txt": "x\n" });
  assert.equal(shippedTextHash(a), shippedTextHash(b));
  assert.notEqual(shippedTextHash(a), shippedTextHash(c));
  assert.notEqual(shippedTextHash(a), shippedTextHash(d), "a new reference file changes the hash");
  assert.equal(shippedTextHash(a), shippedTextHash(e), "only *.md files count");
  assert.match(shippedTextHash(a), /^[0-9a-f]{64}$/);
});

test("hash separates file boundaries", () => {
  const a = skillDir({ "SKILL.md": "s\n", "a.md": "xy", "b.md": "z" });
  const b = skillDir({ "SKILL.md": "s\n", "a.md": "x", "b.md": "yz" });
  assert.notEqual(shippedTextHash(a), shippedTextHash(b));
  // Without the length prefix both of these concatenate to the same bytes:
  // "a.md\n" + "x" + "b.md\n" + "b.md\ny" and "a.md\n" + "xb.md\n" + "b.md\n" + "y".
  const c = skillDir({ "SKILL.md": "s\n", "a.md": "x", "b.md": "b.md\ny" });
  const d = skillDir({ "SKILL.md": "s\n", "a.md": "xb.md\n", "b.md": "y" });
  assert.notEqual(shippedTextHash(c), shippedTextHash(d));
});

test("hash reads CRLF as LF", () => {
  const lf = skillDir({ "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\n`, "ref.md": "a\nb\n" });
  const crlf = skillDir({ "SKILL.md": `# S\r\nskill_marker: ${MARKER}\r\nbody\r\n`, "ref.md": "a\r\nb\r\n" });
  assert.equal(shippedTextHash(lf), shippedTextHash(crlf));
});

test("hash refuses a directory without SKILL.md or with a non-file *.md", () => {
  assert.throws(() => shippedTextHash(skillDir({ "ref.md": "x" })), /no SKILL\.md/);
  const dir = skillDir({ "SKILL.md": "s\n" });
  mkdirSync(join(dir, "nested.md"));
  assert.throws(() => shippedTextHash(dir), /not a regular file/);
  const linked = skillDir({ "SKILL.md": "s\n" });
  symlinkSync(join(dir, "SKILL.md"), join(linked, "link.md"));
  assert.throws(() => shippedTextHash(linked), /not a regular file/);
});

test("hash of a shipped skill is stable across calls", () => {
  const dir = join(REPO, "skills", SKILL);
  assert.equal(shippedTextHash(dir), shippedTextHash(dir));
});

// --- stage ---------------------------------------------------------------

test("stage strips dependencies only in the copy", () => {
  const root = pluginRoot();
  const before = readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8");
  const out = join(tmp("pressure-out-"), "plug");
  stage({ root, out });
  const staged = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal("dependencies" in staged, false);
  assert.equal(staged.name, "ship-kit");
  assert.equal(staged.version, "0.1.0");
  assert.equal(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"), before);
  assert.equal(readFileSync(join(out, "skills", "a-skill", "SKILL.md"), "utf8"), "skill\n");
  assert.equal(readFileSync(join(out, ".claude-plugin", "marketplace.json"), "utf8"), "{}\n");
  assert.equal(existsSync(join(out, "scripts", "x.mjs")), true);
  assert.equal(existsSync(join(out, "docs")), false, "docs never reach the staged plugin");
  assert.equal(existsSync(join(out, "review")), false, "absent directories are skipped");
});

test("stage accepts an existing empty out", () => {
  const root = pluginRoot();
  const out = tmp("pressure-out-");
  stage({ root, out });
  assert.equal(existsSync(join(out, ".claude-plugin", "plugin.json")), true);
});

test("stage refuses a non-empty out", () => {
  const root = pluginRoot();
  const out = tmp("pressure-out-");
  writeFileSync(join(out, "leftover"), "x");
  const result = run(["stage", "--out", out], { root });
  assert.equal(result.code, 2);
  assert.match(result.err, /must be empty or absent/);
  assert.equal(existsSync(join(out, ".claude-plugin")), false);
  const file = join(tmp("pressure-out-"), "a-file");
  writeFileSync(file, "x");
  assert.equal(run(["stage", "--out", file], { root }).code, 2);
});

test("stage refuses an out inside the source tree and a source without plugin.json", () => {
  const root = pluginRoot();
  const inside = run(["stage", "--out", join(root, "plug")], { root });
  assert.equal(inside.code, 2);
  assert.match(inside.err, /inside the source tree/);
  const bare = tmp("pressure-root-");
  mkdirSync(join(bare, "skills"));
  const missing = run(["stage", "--out", join(tmp("pressure-out-"), "plug")], { root: bare });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /plugin\.json/);
});

test("stage through main reports success", () => {
  const root = pluginRoot();
  const out = join(tmp("pressure-out-"), "plug");
  const result = run(["stage", "--out", out], { root });
  assert.equal(result.code, 0, result.err);
  assert.equal(existsSync(join(out, ".claude-plugin", "plugin.json")), true);
});

// --- main / CLI -----------------------------------------------------------

/** A repository root holding one skill, for main(). */
function repoWithSkill(skillText) {
  const root = tmp("pressure-repo-");
  mkdirSync(join(root, "skills", SKILL), { recursive: true });
  writeFileSync(join(root, "skills", SKILL, "SKILL.md"), skillText);
  return root;
}

function streamFile(text) {
  const file = join(tmp("pressure-stream-"), "s.jsonl");
  writeFileSync(file, text);
  return file;
}

test("check through main prints the text on success and the reason on failure", () => {
  const root = repoWithSkill("---\nname: x\n---\nbody\n");
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(INVOKED)], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, finalResult(INVOKED) + "\n");
  const bad = run(["check", "--skill", SKILL, "--stream", streamFile(LISTED)], { root });
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "");
  assert.match(bad.err, /no Skill tool call/);
});

test("check --dmi through main reads the marker from SKILL.md", () => {
  const root = repoWithSkill(`---\nname: x\n---\nskill_marker: ${MARKER}\n`);
  const stream = withResult(INVOKED, (m) => ({
    ...m,
    result: `marker ${MARKER}`,
    structured_output: { skill_marker: MARKER },
  }));
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(stream), "--dmi"], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, `marker ${SKILL}@0.1.0:<token>\n`);
  const noMarker = repoWithSkill("---\nname: x\n---\n");
  const refused = run(["check", "--skill", SKILL, "--stream", streamFile(stream), "--dmi"], { root: noMarker });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /no skill_marker line/);
});

test("hash through main prints the digest", () => {
  const root = repoWithSkill("---\nname: x\n---\nbody\n");
  const result = run(["hash", "--skill", SKILL], { root });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, shippedTextHash(join(root, "skills", SKILL)) + "\n");
});

test("usage errors exit 2", () => {
  const root = repoWithSkill("s\n");
  const cases = [
    [],
    ["nope"],
    ["check", "--skill", SKILL],
    ["check", "--stream", "x"],
    ["check", "--skill", "../escape", "--stream", "x"],
    ["check", "--skill", SKILL, "--stream", join(root, "missing.jsonl")],
    ["check", "--skill", "absent-skill", "--stream", streamFile(INVOKED)],
    ["hash"],
    ["hash", "--skill", "Bad/Name"],
    ["hash", "--skill", "absent-skill"],
    ["stage"],
    ["stage", "--out"],
    ["stage", "--out", "x", "--extra"],
    ["hash", "--skill", SKILL, "--skill", SKILL],
  ];
  for (const argv of cases) {
    const result = run(argv, { root });
    assert.equal(result.code, 2, `argv ${JSON.stringify(argv)} exited ${result.code}: ${result.err}`);
    assert.ok(result.err.length > 0);
  }
  const malformed = repoWithSkill("skill_marker: x@0.1.0:zz\n");
  assert.equal(run(["check", "--skill", SKILL, "--stream", streamFile(INVOKED)], { root: malformed }).code, 2);
});

test("the command line runs main against the repository", () => {
  const child = spawnSync(process.execPath, [SCRIPT, "hash", "--skill", SKILL], {
    encoding: "utf8",
    env: isolatedEnv(),
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, shippedTextHash(join(REPO, "skills", SKILL)) + "\n");
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: isolatedEnv() });
  assert.equal(bad.status, 2);
});
