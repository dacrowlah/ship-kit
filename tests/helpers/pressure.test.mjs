import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { checkStream, loadedBodyMatches, main, MODEL_ID, pinnedModel, readMarker, shippedTextHash, stage, stagedTreeHash } from "./pressure.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(HERE, "pressure.mjs");
const RAW_INVOKED = readFileSync(join(HERE, "fixtures", "stream-invoked.jsonl"), "utf8");
const RAW_LISTED = readFileSync(join(HERE, "fixtures", "stream-listed-not-invoked.jsonl"), "utf8");
/** Points every redacted `<plugin-dir>` in a fixture at `path`. @returns {string} */
const loadedFrom = (text, path) => {
  const out = text.split("<plugin-dir>").join(path);
  assert.notEqual(out, text, "the fixture names the redacted plugin path");
  return out;
};
const STAGED_PATH = `/staged/${"a".repeat(64)}`;
const BASE_PREFIX = "Base directory for this skill: ";
/** The skill body the real run loaded, as the fixture shows it. */
const LOADED_BODY = RAW_INVOKED.split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .flatMap((m) => (m.type === "user" && Array.isArray(m.message?.content) ? m.message.content : []))
  .find((c) => c.type === "text" && c.text.startsWith(`${BASE_PREFIX}<plugin-dir>/skills/`))
  .text.split("\n\n")
  .slice(1)
  .join("\n\n");
const INVOKED = loadedFrom(RAW_INVOKED, STAGED_PATH);
const LISTED = loadedFrom(RAW_LISTED, STAGED_PATH);
const SKILL = "proving-tests-can-fail";
const HEX = "0123456789abcdef";
const MARKER = `${SKILL}@0.1.0:${HEX}`;
const OTHER_MODEL = "claude-other-model-1";

/** Writes `<root>/tests/skills/pinned-model.txt`. @returns {string} root */
function pin(root, content = `${FIXTURE_MODEL}\n`) {
  mkdirSync(join(root, "tests", "skills"), { recursive: true });
  writeFileSync(join(root, "tests", "skills", "pinned-model.txt"), content);
  return root;
}

/** @param {string} text @returns {object[]} */
const parse = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
/** @param {object[]} messages @returns {string} */
const join_ = (messages) => messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
const finalResult = (text) => parse(text).filter((m) => m.type === "result").at(-1).result;
/** The model the fixture streams' init message reports. */
const FIXTURE_MODEL = parse(RAW_INVOKED)[0].model;

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

/**
 * `<root>/skills/s` holding `files` (paths may have subdirectories), plus
 * `shared` files under `<root>`. @returns {string} the skill directory
 */
function skillDir(files, shared = {}) {
  const root = tmp("pressure-skill-");
  const dir = join(root, "skills", "s");
  for (const [base, set] of [[dir, files], [root, shared]]) {
    for (const [name, content] of Object.entries(set)) {
      mkdirSync(dirname(join(base, name)), { recursive: true });
      writeFileSync(join(base, name), content);
    }
  }
  mkdirSync(dir, { recursive: true });
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
  return pin(root);
}

/**
 * A plugin source whose proving-tests-can-fail SKILL.md has the body the
 * fixture run loaded (plus `extra`), staged content-addressed.
 * @returns {{root: string, out: string, plugin: string}}
 */
function stagedFixtureSkill(extra = "") {
  const root = pluginRoot();
  mkdirSync(join(root, "skills", SKILL), { recursive: true });
  const text = `---\nname: ${SKILL}\ndescription: Use when testing.\n---\n\n${LOADED_BODY}${extra}`;
  writeFileSync(join(root, "skills", SKILL, "SKILL.md"), text);
  const out = join(tmp("pressure-out-"), "plug");
  return { root, out, plugin: stage({ root, out }) };
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

/** The fixture's Skill call, its message and its tool_result message. */
function skillCallParts(messages) {
  const call = messages.find((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Skill"'));
  const block = call.message.content.find((c) => c.name === "Skill");
  const result = messages.find((m) => m.type === "user" && JSON.stringify(m).includes(`"tool_use_id":"${block.id}"`));
  return { call, block, result };
}

test("a Skill call without an id, or whose result comes first, does not count", () => {
  const noId = parse(INVOKED);
  const parts = skillCallParts(noId);
  delete parts.block.id;
  delete parts.result.message.content.find((c) => c.type === "tool_result").tool_use_id;
  assert.equal(checkStream(join_(noId), { skill: SKILL, dmi: false }).ok, false);
  const reordered = parse(INVOKED);
  const { call, result } = skillCallParts(reordered);
  const [moved] = reordered.splice(reordered.indexOf(result), 1);
  reordered.splice(reordered.indexOf(call), 0, moved);
  assert.equal(checkStream(join_(reordered), { skill: SKILL, dmi: false }).ok, false);
});

test("a Skill call id that is reused or answered twice does not count", () => {
  const reused = parse(INVOKED);
  const { block } = skillCallParts(reused);
  const read = reused.find((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Read"'));
  read.message.content.find((c) => c.name === "Read").id = block.id;
  assert.equal(checkStream(join_(reused), { skill: SKILL, dmi: false }).ok, false);
  const twice = parse(INVOKED);
  const { result } = skillCallParts(twice);
  twice.splice(twice.indexOf(result) + 1, 0, result);
  assert.equal(checkStream(join_(twice), { skill: SKILL, dmi: false }).ok, false);
});

test("a Skill tool_use outside an assistant message does not count", () => {
  const messages = parse(INVOKED);
  const { call } = skillCallParts(messages);
  call.type = "user";
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no Skill tool call/);
});

test("init must name exactly one ship-kit plugin at an absolute path", () => {
  const verdict = checkStream(INVOKED, { skill: SKILL, dmi: false });
  assert.equal(verdict.ok && verdict.pluginPath, STAGED_PATH);
  const cases = [
    (init) => delete init.plugins,
    (init) => (init.plugins = init.plugins.filter((p) => p.name !== "ship-kit")),
    (init) => init.plugins.push({ name: "ship-kit", path: "/other" }),
    (init) => (init.plugins.find((p) => p.name === "ship-kit").path = "relative/plugin"),
    (init) => delete init.plugins.find((p) => p.name === "ship-kit").path,
  ];
  for (const edit of cases) {
    const messages = parse(INVOKED);
    edit(messages[0]);
    const bad = checkStream(join_(messages), { skill: SKILL, dmi: false });
    assert.equal(bad.ok, false, edit.toString());
    assert.match(bad.reason, /no single ship-kit plugin/);
  }
  assert.equal(checkStream(RAW_INVOKED, { skill: SKILL, dmi: false }).ok, false, "the redacted placeholder is not a path");
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
  assert.match(errored.reason, /final result message is not a success/);
  const subtype = checkStream(withResult(INVOKED, (m) => ({ ...m, subtype: "error_max_turns" })), {
    skill: SKILL,
    dmi: false,
  });
  assert.equal(subtype.ok, false);
  assert.match(subtype.reason, /final result message is not a success/);
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

test("hash ignores the SKILL.md marker line only", () => {
  const base = { "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\n`, "ref.md": "ref\n" };
  const a = skillDir(base);
  const b = skillDir({ ...base, "SKILL.md": `# S\nskill_marker: ${SKILL}@0.2.0:fedcba9876543210\nbody\n` });
  const c = skillDir({ ...base, "SKILL.md": `# S\nskill_marker: ${MARKER}\nbodY\n` });
  const d = skillDir({ ...base, "extra.md": "\n" });
  const e = skillDir({ ...base, "SKILL.md": `# S\nskill_marker: ${MARKER}\nbody\nskill_marker: do something else\n` });
  const f = skillDir({ ...base, "ref.md": "ref\nskill_marker: hidden\n" });
  assert.equal(shippedTextHash(a), shippedTextHash(b));
  assert.notEqual(shippedTextHash(a), shippedTextHash(c));
  assert.notEqual(shippedTextHash(a), shippedTextHash(d), "a new reference file changes the hash");
  assert.notEqual(shippedTextHash(a), shippedTextHash(e), "a second marker-shaped line is hashed");
  assert.notEqual(shippedTextHash(a), shippedTextHash(f), "marker-shaped lines in other files are hashed");
  assert.match(shippedTextHash(a), /^[0-9a-f]{64}$/);
});

test("hash covers every file under the skill directory", () => {
  const base = { "SKILL.md": "s\n", "refs/r.md": "r\n", "notes.txt": "n\n" };
  const a = shippedTextHash(skillDir(base));
  assert.notEqual(a, shippedTextHash(skillDir({ ...base, "refs/r.md": "R\n" })), "a nested reference file counts");
  assert.notEqual(a, shippedTextHash(skillDir({ ...base, "notes.txt": "N\n" })), "a non-md sibling counts");
  assert.notEqual(a, shippedTextHash(skillDir({ ...base, "UPPER.MD": "x\n" })), "any extension counts");
  const invalid = (byte) => skillDir({ ...base, "SKILL.md": Buffer.from([0x73, byte, 0x0a]) });
  assert.notEqual(shippedTextHash(invalid(0xff)), shippedTextHash(invalid(0xfe)), "raw bytes, not decoded text");
});

test("hash covers shared files the skill names under the plugin root", () => {
  const skill = { "SKILL.md": "Read `${CLAUDE_PLUGIN_ROOT}/review/list.md` and ${CLAUDE_PLUGIN_ROOT}/review/dir.\n" };
  const shared = { "review/list.md": "one\n", "review/dir/a.md": "a\n", "review/other.md": "o\n" };
  const a = shippedTextHash(skillDir(skill, shared));
  assert.notEqual(a, shippedTextHash(skillDir(skill, { ...shared, "review/list.md": "two\n" })), "a named file");
  assert.notEqual(a, shippedTextHash(skillDir(skill, { ...shared, "review/dir/a.md": "b\n" })), "a named directory");
  assert.equal(a, shippedTextHash(skillDir(skill, { ...shared, "review/other.md": "p\n" })), "unnamed files do not count");
  const viaReference = { ...skill, "ref.md": "See ${CLAUDE_PLUGIN_ROOT}/review/other.md.\n" };
  const b = shippedTextHash(skillDir(viaReference, shared));
  assert.notEqual(b, shippedTextHash(skillDir(viaReference, { ...shared, "review/other.md": "p\n" })), "named by a reference file");
  const escaping = { "SKILL.md": "${CLAUDE_PLUGIN_ROOT}/../outside.md and ${CLAUDE_PLUGIN_ROOT}/missing.md\n" };
  assert.match(shippedTextHash(skillDir(escaping)), /^[0-9a-f]{64}$/, "escaping and missing names are skipped");
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

test("hash refuses a directory without SKILL.md or holding a symlink", () => {
  assert.throws(() => shippedTextHash(skillDir({ "ref.md": "x" })), /no SKILL\.md/);
  const dir = skillDir({ "SKILL.md": "s\n" });
  const linked = skillDir({ "SKILL.md": "s\n" });
  symlinkSync(join(dir, "SKILL.md"), join(linked, "link.md"));
  assert.throws(() => shippedTextHash(linked), /not a regular file/);
  const sharedLink = skillDir({ "SKILL.md": "${CLAUDE_PLUGIN_ROOT}/review/l.md\n" });
  mkdirSync(join(sharedLink, "..", "..", "review"));
  symlinkSync(join(dir, "SKILL.md"), join(sharedLink, "..", "..", "review", "l.md"));
  assert.throws(() => shippedTextHash(sharedLink), /not a regular file/);
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
  const plugin = stage({ root, out });
  assert.equal(dirname(plugin), out);
  assert.equal(basename(plugin), stagedTreeHash(plugin), "the stage is named by its content");
  assert.deepEqual(readdirSync(out), [basename(plugin)], "no partial copy is left");
  const staged = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal("dependencies" in staged, false);
  assert.equal(staged.name, "ship-kit");
  assert.equal(staged.version, "0.1.0");
  assert.equal(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"), before);
  assert.equal(readFileSync(join(plugin, "skills", "a-skill", "SKILL.md"), "utf8"), "skill\n");
  assert.equal(readFileSync(join(plugin, ".claude-plugin", "marketplace.json"), "utf8"), "{}\n");
  assert.equal(existsSync(join(plugin, "scripts", "x.mjs")), true);
  assert.equal(existsSync(join(plugin, "docs")), false, "docs never reach the staged plugin");
  assert.equal(existsSync(join(plugin, "review")), false, "absent directories are skipped");
});

test("stage accepts an existing empty out", () => {
  const root = pluginRoot();
  const out = tmp("pressure-out-");
  const plugin = stage({ root, out });
  assert.equal(existsSync(join(plugin, ".claude-plugin", "plugin.json")), true);
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

test("stage refuses an out whose name only starts with two dots inside the tree", () => {
  const root = pluginRoot();
  const result = run(["stage", "--out", join(root, "..staged")], { root });
  assert.equal(result.code, 2);
  assert.match(result.err, /inside the source tree/);
});

test("stage keeps a relative symlink inside the staged directories verbatim", () => {
  const root = pluginRoot();
  symlinkSync("../../scripts/x.mjs", join(root, "skills", "a-skill", "x.mjs"));
  const plugin = stage({ root, out: join(tmp("pressure-out-"), "plug") });
  assert.equal(readlinkSync(join(plugin, "skills", "a-skill", "x.mjs")), "../../scripts/x.mjs");
  assert.equal(readFileSync(join(plugin, "skills", "a-skill", "x.mjs"), "utf8"), "x\n");
});

test("stage refuses a symlink that leaves the staged directories", () => {
  const cases = [
    (root) => symlinkSync("../../docs/design.md", join(root, "skills", "a-skill", "d.md")),
    (root) => symlinkSync(join(root, "scripts", "x.mjs"), join(root, "skills", "a-skill", "abs.mjs")),
    (root) => symlinkSync("docs", join(root, "review")),
    (root) => symlinkSync("../dangling", join(root, "review")),
  ];
  for (const plant of cases) {
    const root = pluginRoot();
    plant(root);
    const out = join(tmp("pressure-out-"), "plug");
    const result = run(["stage", "--out", out], { root });
    assert.equal(result.code, 2, plant.toString());
    assert.match(result.err, /symlink leaving the staged directories/);
    assert.equal(existsSync(out), false, "nothing is copied");
  }
});

test("stage through main reports success", () => {
  const root = pluginRoot();
  const out = join(tmp("pressure-out-"), "plug");
  const result = run(["stage", "--out", out], { root });
  assert.equal(result.code, 0, result.err);
  const plugin = result.out.trimEnd();
  assert.equal(result.out, `${plugin}\n`, "prints only the staged path");
  assert.equal(dirname(plugin), out);
  assert.equal(existsSync(join(plugin, ".claude-plugin", "plugin.json")), true);
});

// --- main / CLI -----------------------------------------------------------

/** A repository root holding one skill, for main(). */
function repoWithSkill(skillText) {
  const root = tmp("pressure-repo-");
  mkdirSync(join(root, "skills", SKILL), { recursive: true });
  writeFileSync(join(root, "skills", SKILL, "SKILL.md"), skillText);
  return pin(root);
}

function streamFile(text) {
  const file = join(tmp("pressure-stream-"), "s.jsonl");
  writeFileSync(file, text);
  return file;
}

/** Output of a valid check: the hash line, a blank line, the text. */
const checked = (plugin, text, model = FIXTURE_MODEL) =>
  `Shipped-text SHA-256: ${shippedTextHash(join(plugin, "skills", SKILL))}\nModel: ${model}\n\n${text}\n`;

test("check through main prints the text on success and the reason on failure", () => {
  const { root, plugin } = stagedFixtureSkill();
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, plugin))], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, checked(plugin, finalResult(INVOKED)));
  const bad = run(["check", "--skill", SKILL, "--stream", streamFile(LISTED)], { root });
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "");
  assert.match(bad.err, /no Skill tool call/);
});

test("check --dmi through main reads the marker from SKILL.md", () => {
  // A slash-command run shows no "Base directory" body in its stream
  // (observed at Claude Code 2.1.284), so the dmi stream carries none.
  const { root, plugin } = stagedFixtureSkill(`\nskill_marker: ${MARKER}\n`);
  const bodyless = parse(loadedFrom(RAW_INVOKED, plugin)).filter(
    (m) => !(m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX)),
  );
  const stream = withResult(join_(bodyless), (m) => ({
    ...m,
    result: `marker ${MARKER}`,
    structured_output: { skill_marker: MARKER },
  }));
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(stream), "--dmi"], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, checked(plugin, `marker ${SKILL}@0.1.0:<token>`));
  const noMarker = repoWithSkill("---\nname: x\n---\n");
  const refused = run(["check", "--skill", SKILL, "--stream", streamFile(stream), "--dmi"], { root: noMarker });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /no skill_marker line/);
});

test("check prints the hash of the text the run loaded, not of the repository", () => {
  const { root, plugin } = stagedFixtureSkill();
  writeFileSync(join(root, "skills", SKILL, "SKILL.md"), "---\nname: x\n---\nrepository text since staging\n");
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, plugin))], { root });
  assert.equal(ok.code, 0, ok.err);
  const printed = ok.out.split("\n")[0];
  assert.equal(printed, `Shipped-text SHA-256: ${shippedTextHash(join(plugin, "skills", SKILL))}`);
  assert.notEqual(printed, `Shipped-text SHA-256: ${shippedTextHash(join(root, "skills", SKILL))}`);
  const gone = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, join(dirname(plugin), "f".repeat(64))))], {
    root,
  });
  assert.equal(gone.code, 1);
  assert.equal(gone.out, "");
  assert.match(gone.err, /staged plugin the run loaded has no skills\/proving-tests-can-fail/);
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

// --- binding to the staged text the run loaded ----------------------------

test("the fixture's loaded body is the staged SKILL.md body, and check accepts it", () => {
  const { root, plugin } = stagedFixtureSkill();
  assert.match(plugin, /[\\/][0-9a-f]{64}$/);
  const result = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, plugin))], { root });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, checked(plugin, finalResult(INVOKED)));
});

test("re-staging edited text at the same out fails an old stream", () => {
  const { root, out, plugin } = stagedFixtureSkill();
  const stream = streamFile(loadedFrom(RAW_INVOKED, plugin));
  assert.equal(run(["check", "--skill", SKILL, "--stream", stream], { root }).code, 0);
  writeFileSync(join(root, "skills", SKILL, "SKILL.md"), readFileSync(join(root, "skills", SKILL, "SKILL.md"), "utf8") + "\nNew rule.\n");
  rmSync(out, { recursive: true, force: true });
  const again = stage({ root, out });
  assert.notEqual(again, plugin, "different text stages at a different path");
  const result = run(["check", "--skill", SKILL, "--stream", stream], { root });
  assert.equal(result.code, 1);
  assert.equal(result.out, "");
});

test("a staged copy edited in place fails the check", () => {
  const { root, plugin } = stagedFixtureSkill();
  const stream = streamFile(loadedFrom(RAW_INVOKED, plugin));
  writeFileSync(join(plugin, "skills", "a-skill", "SKILL.md"), "edited\n");
  const result = run(["check", "--skill", SKILL, "--stream", stream], { root });
  assert.equal(result.code, 1);
  assert.match(result.err, /does not match its content hash/);
});

test("a stream whose loaded body differs from the staged copy fails", () => {
  const { root, plugin } = stagedFixtureSkill();
  const edited = loadedFrom(RAW_INVOKED, plugin).replace("# Proving tests can fail", "# Proving tests can pass");
  const result = run(["check", "--skill", SKILL, "--stream", streamFile(edited)], { root });
  assert.equal(result.code, 1);
  assert.match(result.err, /loaded skill body differs from the staged SKILL\.md/);
  const older = stagedFixtureSkill("\nA rule the run never saw.\n");
  const stale = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, older.plugin))], {
    root: older.root,
  });
  assert.equal(stale.code, 1);
  assert.match(stale.err, /loaded skill body differs/);
});

test("a stream that shows no loaded skill body fails", () => {
  const messages = parse(INVOKED).filter(
    (m) => !(m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX)),
  );
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no loaded skill body/);
});

test("a loaded body shown inside a subagent does not count", () => {
  const messages = parse(INVOKED);
  messages.find((m) => m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX)).parent_tool_use_id = "toolu_parent";
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no loaded skill body/);
});

test("a body the model wrote itself does not count as loaded", () => {
  const messages = parse(INVOKED);
  messages.find((m) => m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX)).type = "assistant";
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no loaded skill body/);
});

test("a loaded body from another directory for the skill fails", () => {
  const messages = parse(INVOKED);
  const body = messages.find((m) => m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX));
  const copy = JSON.parse(JSON.stringify(body).replace(`${BASE_PREFIX}${STAGED_PATH}/skills/`, `${BASE_PREFIX}/elsewhere/skills/`));
  messages.splice(messages.indexOf(body) + 1, 0, copy);
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /from another directory/);
});

test("the plugin path must be a normalized content-addressed stage", () => {
  for (const path of ["/staged/plugin", `/staged/x/../${"a".repeat(64)}`, `/staged/${"A".repeat(64)}`]) {
    const verdict = checkStream(loadedFrom(RAW_INVOKED, path), { skill: SKILL, dmi: false });
    assert.equal(verdict.ok, false, path);
    assert.match(verdict.reason, /content-addressed stage/);
  }
});

test("loaded bodies are compared after the plugin-root and skill-dir substitutions", () => {
  const body = "Run `${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs` from ${CLAUDE_SKILL_DIR}.";
  const skillText = `---\nname: s\n---\n\n${body}\n`;
  const plugin = "/p/" + "b".repeat(64);
  const loaded = `Run \`${plugin}/scripts/x.mjs\` from ${plugin}/skills/s.`;
  assert.equal(loadedBodyMatches(skillText, loaded, { pluginPath: plugin, skill: "s" }), true);
  assert.equal(loadedBodyMatches(skillText, body, { pluginPath: plugin, skill: "s" }), false);
  assert.equal(loadedBodyMatches("no frontmatter\n", "no frontmatter", { pluginPath: plugin, skill: "s" }), true);
});

test("the staged tree hash covers paths, bytes and symlink targets", () => {
  const make = (edit) => {
    const dir = tmp("pressure-tree-");
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "f"), "x");
    symlinkSync("f", join(dir, "a", "l"));
    edit?.(dir);
    return stagedTreeHash(dir);
  };
  const base = make();
  assert.equal(base, make());
  assert.notEqual(base, make((d) => writeFileSync(join(d, "a", "f"), "y")));
  assert.notEqual(base, make((d) => writeFileSync(join(d, "a", "g"), "")));
  assert.notEqual(base, make((d) => (rmSync(join(d, "a", "l")), symlinkSync("g", join(d, "a", "l")))));
  assert.notEqual(base, make((d) => (rmSync(join(d, "a", "f")), writeFileSync(join(d, "f"), "x"))));
  assert.notEqual(base, make((d) => (rmSync(join(d, "a", "f")), writeFileSync(join(d, "a", "e"), "x"))), "a rename counts");
});

// --- guards the re-review found unheld ------------------------------------

test("a Skill tool_result outside a top-level user message does not count", () => {
  const asAssistant = parse(INVOKED);
  skillCallParts(asAssistant).result.type = "assistant";
  assert.equal(checkStream(join_(asAssistant), { skill: SKILL, dmi: false }).ok, false);
  const nested = parse(INVOKED);
  skillCallParts(nested).result.parent_tool_use_id = "toolu_parent";
  assert.equal(checkStream(join_(nested), { skill: SKILL, dmi: false }).ok, false);
});

test("stage refuses an absolute symlink even when it points inside the staged directories", () => {
  const root = realpathSync(pluginRoot());
  symlinkSync(join(root, "scripts", "x.mjs"), join(root, "skills", "a-skill", "abs.mjs"));
  const result = run(["stage", "--out", join(tmp("pressure-out-"), "plug")], { root });
  assert.equal(result.code, 2);
  assert.match(result.err, /symlink leaving the staged directories/);
});

test("stage refuses a staged top-level directory that is a symlink to another staged one", () => {
  const root = pluginRoot();
  symlinkSync("skills", join(root, "review"));
  const result = run(["stage", "--out", join(tmp("pressure-out-"), "plug")], { root });
  assert.equal(result.code, 2);
  assert.match(result.err, /symlink leaving the staged directories/);
});

test("hash never reads outside the plugin root or the whole root", () => {
  const outsideName = `outside-${process.pid}-${Date.now()}.md`;
  const skill = { "SKILL.md": `\${CLAUDE_PLUGIN_ROOT}/../${outsideName} \${CLAUDE_PLUGIN_ROOT}/. \${CLAUDE_PLUGIN_ROOT}/..\n` };
  const dir = skillDir(skill, { "top.md": "t\n" });
  const root = join(dir, "..", "..");
  const outside = join(root, "..", outsideName);
  writeFileSync(outside, "one\n");
  const before = shippedTextHash(dir);
  writeFileSync(outside, "two\n");
  writeFileSync(join(root, "top.md"), "changed\n");
  try {
    assert.equal(shippedTextHash(dir), before);
  } finally {
    rmSync(outside);
  }
});

// --- reads of the staged plugin must succeed --------------------------------

/**
 * Inserts a tool call and its result before the final result message.
 * @returns {string}
 */
function withToolCall(text, { name, input, isError, parent = null, result = true }) {
  const messages = parse(text);
  const id = `toolu_probe_${name}`;
  const call = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: parent,
  };
  const reply = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: isError ? "Claude requested permissions to read from it, but you haven't granted it yet." : "ok", ...(isError ? { is_error: true } : {}) }],
    },
    parent_tool_use_id: parent,
  };
  messages.splice(messages.length - 1, 0, call, ...(result ? [reply] : []));
  return join_(messages);
}

const UNDER = `${STAGED_PATH}/review/hunt-lists/design-shared.md`;

test("a refused Read of a staged plugin file fails the run", () => {
  const verdict = checkStream(withToolCall(INVOKED, { name: "Read", input: { file_path: UNDER }, isError: true }), {
    skill: SKILL,
    dmi: false,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /could not read the staged plugin: Read .*design-shared\.md/);
});

test("a failed Grep or Glob under the staged plugin fails the run, in dmi mode too", () => {
  const grep = withToolCall(INVOKED, { name: "Grep", input: { pattern: "x", path: `${STAGED_PATH}/review` }, isError: true });
  assert.equal(checkStream(grep, { skill: SKILL, dmi: false }).ok, false);
  const glob = withToolCall(INVOKED, { name: "Glob", input: { pattern: `${STAGED_PATH}/review/**/*.md` }, isError: true });
  assert.equal(checkStream(glob, { skill: SKILL, dmi: false }).ok, false);
  const inRoot = withToolCall(INVOKED, { name: "Glob", input: { pattern: "*.md", path: STAGED_PATH }, isError: true });
  assert.equal(checkStream(inRoot, { skill: SKILL, dmi: false }).ok, false);
  const dmi = withResult(
    withToolCall(INVOKED, { name: "Read", input: { file_path: UNDER }, isError: true }),
    (m) => ({ ...m, structured_output: { skill_marker: MARKER } }),
  );
  assert.equal(checkStream(dmi, { skill: SKILL, dmi: true, marker: MARKER }).ok, false);
});

test("a staged plugin read with no result, or inside a subagent, still counts against the run", () => {
  const unanswered = withToolCall(INVOKED, { name: "Read", input: { file_path: UNDER }, isError: false, result: false });
  assert.match(checkStream(unanswered, { skill: SKILL, dmi: false }).reason, /could not read the staged plugin/);
  const nested = withToolCall(INVOKED, { name: "Read", input: { file_path: UNDER }, isError: true, parent: "toolu_x" });
  assert.equal(checkStream(nested, { skill: SKILL, dmi: false }).ok, false);
});

test("successful staged reads and failed reads elsewhere are accepted", () => {
  const read = withToolCall(INVOKED, { name: "Read", input: { file_path: UNDER }, isError: false });
  assert.equal(checkStream(read, { skill: SKILL, dmi: false }).ok, true);
  const elsewhere = withToolCall(INVOKED, { name: "Read", input: { file_path: "/run/dir/missing.md" }, isError: true });
  assert.equal(checkStream(elsewhere, { skill: SKILL, dmi: false }).ok, true);
  const sibling = withToolCall(INVOKED, { name: "Read", input: { file_path: `${STAGED_PATH}x/a.md` }, isError: true });
  assert.equal(checkStream(sibling, { skill: SKILL, dmi: false }).ok, true, "a sibling path sharing the prefix is not under it");
});

test("a loaded body shown before the init message does not count", () => {
  const messages = parse(INVOKED);
  const body = messages.find((m) => m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX));
  messages.splice(messages.indexOf(body), 1);
  const verdict = checkStream(join_([body, ...messages]), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no loaded skill body/);
});

test("a near-miss base directory for the skill is refused", () => {
  const nearMiss = INVOKED.replace(`${BASE_PREFIX}${STAGED_PATH}/skills/${SKILL}\\n`, `${BASE_PREFIX}${STAGED_PATH}/skills/${SKILL}/\\n`);
  assert.notEqual(nearMiss, INVOKED);
  const messages = parse(nearMiss);
  const body = parse(INVOKED).find((m) => m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX));
  messages.splice(1, 0, body);
  const verdict = checkStream(join_(messages), { skill: SKILL, dmi: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /from another directory/);
});

test("$ARGUMENTS in a model-invoked body is compared as empty", () => {
  const plugin = "/p/" + "c".repeat(64);
  assert.equal(loadedBodyMatches("---\nname: s\n---\nArgs: $ARGUMENTS.\n", "Args: .", { pluginPath: plugin, skill: "s" }), true);
});

/**
 * Passes `args` in the stream's Skill call and appends `appended` to the
 * loaded body. With arguments and no `$ARGUMENTS` in SKILL.md, Claude Code
 * 2.1.284 appends "\n\nARGUMENTS: <args>" to the body (seen in a real
 * GREEN stream), which is the default here.
 * @param {string} text @param {string | undefined} args @param {string} [appended]
 */
function withSkillArgs(text, args, appended = `\n\n\nARGUMENTS: ${args}`) {
  const messages = parse(text).map((m) => {
    const content = Array.isArray(m.message?.content) ? m.message.content : null;
    if (!content) return m;
    const edited = content.map((block) => {
      if (block.type === "tool_use" && block.name === "Skill" && args !== undefined) return { ...block, input: { ...block.input, args } };
      if (block.type === "text" && typeof block.text === "string" && block.text.startsWith(BASE_PREFIX)) return { ...block, text: block.text + appended };
      return block;
    });
    return { ...m, message: { ...m.message, content: edited } };
  });
  return join_(messages);
}

test("a run that passed arguments counts when the loaded body ends with exactly those arguments", () => {
  const { root, plugin } = stagedFixtureSkill();
  const base = loadedFrom(RAW_INVOKED, plugin);
  const check = (stream) => run(["check", "--skill", SKILL, "--stream", streamFile(stream)], { root });
  const ok = check(withSkillArgs(base, "scripts/lib/glob.mjs"));
  assert.equal(ok.code, 0, ok.err);
  for (const stream of [
    withSkillArgs(base, "scripts/lib/glob.mjs", "\n\n\nARGUMENTS: other"),
    withSkillArgs(base, undefined, "\n\n\nARGUMENTS: scripts/lib/glob.mjs"),
    withSkillArgs(base, "a", "\n\n\nARGUMENTS: a\nmore text"),
    withSkillArgs(base, "a", "\n\nextra\n\nARGUMENTS: a"),
  ]) {
    const refused = check(stream);
    assert.equal(refused.code, 1, stream.slice(-200));
    assert.match(refused.err, /loaded skill body differs/);
  }
});

test("a skill that places $ARGUMENTS itself does not accept an appended ARGUMENTS line", () => {
  const plugin = "/p/" + "d".repeat(64);
  const text = "---\nname: s\n---\nArgs: $ARGUMENTS.\n";
  const options = { pluginPath: plugin, skill: "s", args: ["x"] };
  assert.equal(loadedBodyMatches(text, "Args: .\n\n\nARGUMENTS: x", options), false);
  assert.equal(loadedBodyMatches("---\nname: s\n---\nBody.\n", "Body.\n\n\nARGUMENTS: x", options), true);
  assert.equal(loadedBodyMatches("---\nname: s\n---\nBody.\n", "Body.\n\n\nARGUMENTS: x", { pluginPath: plugin, skill: "s" }), false);
});

// --- the pinned model ------------------------------------------------------

/** Sets the init message's model (deletes it for `undefined`). @returns {string} */
function withModel(text, model) {
  const messages = parse(text);
  if (model === undefined) delete messages[0].model;
  else messages[0].model = model;
  return join_(messages);
}

/**
 * A RED stream: the invoked fixture with ship-kit cleared from the init
 * message's plugins, skills and slash commands, and its Skill call, that
 * call's result and the loaded skill body removed.
 * @returns {string}
 */
function baselineStream() {
  const messages = parse(INVOKED);
  const init = messages[0];
  init.plugins = init.plugins.filter((p) => p.name !== "ship-kit");
  init.skills = init.skills.filter((s) => !s.startsWith("ship-kit:"));
  init.slash_commands = init.slash_commands.filter((s) => !s.startsWith("ship-kit:"));
  const { call, result } = skillCallParts(messages);
  return join_(messages.filter((m) => m !== call && m !== result && !(m.type === "user" && JSON.stringify(m).includes(BASE_PREFIX))));
}

test("the pinned model file is one well-formed line", () => {
  assert.equal(pinnedModel(REPO), "claude-opus-5-5");
  assert.match(pinnedModel(REPO), MODEL_ID);
  assert.equal(pinnedModel(pin(tmp("pressure-pin-"), "model-a[1m]\n")), "model-a[1m]");
  const cases = ["a\nb\n", "claude-opus-5-5", "claude opus\n", "claude-opus-5-5\n\n", "claude-opus-5-5\r\n", "\n", "", `${"a".repeat(101)}\n`, "a/b\n"];
  for (const content of cases) {
    const root = pin(tmp("pressure-pin-"), content);
    assert.throws(() => pinnedModel(root), /pinned-model\.txt/, JSON.stringify(content));
  }
  assert.throws(() => pinnedModel(tmp("pressure-pin-")), /pinned-model\.txt/, "a missing pin file");
  const { root, plugin } = stagedFixtureSkill();
  pin(root, "two\nlines\n");
  const result = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, plugin))], { root });
  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.equal(run(["baseline", "--stream", streamFile(baselineStream())], { root }).code, 2);
});

test("a GREEN run under the pin passes and prints its model", () => {
  const verdict = checkStream(INVOKED, { skill: SKILL, dmi: false, expectModel: FIXTURE_MODEL });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.model, FIXTURE_MODEL);
  const { root, plugin } = stagedFixtureSkill();
  const ok = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, plugin))], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out.split("\n")[1], `Model: ${FIXTURE_MODEL}`);
  assert.equal(ok.out, checked(plugin, finalResult(INVOKED)));
});

test("a GREEN run under another model fails", () => {
  const verdict = checkStream(withModel(INVOKED, OTHER_MODEL), { skill: SKILL, dmi: false, expectModel: FIXTURE_MODEL });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, `the run's model ${OTHER_MODEL} differs from the pinned model ${FIXTURE_MODEL}`);
  const { root, plugin } = stagedFixtureSkill();
  const refused = run(["check", "--skill", SKILL, "--stream", streamFile(withModel(loadedFrom(RAW_INVOKED, plugin), OTHER_MODEL))], { root });
  assert.equal(refused.code, 1);
  assert.equal(refused.out, "");
  assert.match(refused.err, new RegExp(`${OTHER_MODEL} differs from the pinned model ${FIXTURE_MODEL}`));
  const dmi = withResult(withModel(INVOKED, OTHER_MODEL), (m) => ({ ...m, structured_output: { skill_marker: MARKER } }));
  assert.equal(checkStream(dmi, { skill: SKILL, dmi: true, marker: MARKER, expectModel: FIXTURE_MODEL }).ok, false, "dmi too");
});

test("an init with no model fails", () => {
  for (const model of [undefined, 42, null]) {
    for (const expectModel of [FIXTURE_MODEL, undefined]) {
      const verdict = checkStream(withModel(INVOKED, model), { skill: SKILL, dmi: false, expectModel });
      assert.equal(verdict.ok, false, `${model} ${expectModel}`);
      assert.equal(verdict.reason, "init message names no model");
    }
  }
});

test("--any-model accepts another model", () => {
  const { root, plugin } = stagedFixtureSkill();
  const stream = streamFile(withModel(loadedFrom(RAW_INVOKED, plugin), OTHER_MODEL));
  const ok = run(["check", "--skill", SKILL, "--stream", stream, "--any-model"], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, checked(plugin, finalResult(INVOKED), OTHER_MODEL));
  const noPin = stagedFixtureSkill();
  rmSync(join(noPin.root, "tests", "skills", "pinned-model.txt"));
  const unpinned = run(["check", "--skill", SKILL, "--stream", streamFile(loadedFrom(RAW_INVOKED, noPin.plugin)), "--any-model"], {
    root: noPin.root,
  });
  assert.equal(unpinned.code, 0, "--any-model never reads the pin");
  const modelless = run(["check", "--skill", SKILL, "--stream", streamFile(withModel(loadedFrom(RAW_INVOKED, plugin), undefined)), "--any-model"], {
    root,
  });
  assert.equal(modelless.code, 1);
  assert.match(modelless.err, /init message names no model/);
});

test("a RED run under the pin passes", () => {
  const root = repoWithSkill("s\n");
  const ok = run(["baseline", "--stream", streamFile(baselineStream())], { root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, `Model: ${FIXTURE_MODEL}\n\n${finalResult(INVOKED)}\n`);
  const other = parse(baselineStream());
  other[0].plugins.push({ name: "ship-kit-extras", path: "/x" });
  other[0].skills.push("superpowers:ship-kit-like");
  assert.equal(run(["baseline", "--stream", streamFile(join_(other))], { root }).code, 0, "other names are not ship-kit");
});

test("a RED run that loaded ship-kit is refused", () => {
  const root = repoWithSkill("s\n");
  const invoked = run(["baseline", "--stream", streamFile(INVOKED)], { root });
  assert.equal(invoked.code, 1);
  assert.equal(invoked.out, "");
  assert.match(invoked.err, /ship-kit/);
  const plantings = [
    (init) => init.plugins.push({ name: "ship-kit", path: "/p" }),
    (init) => init.skills.push(`ship-kit:${SKILL}`),
    (init) => init.slash_commands.push("ship-kit:anything"),
  ];
  for (const plant of plantings) {
    const messages = parse(baselineStream());
    plant(messages[0]);
    const refused = run(["baseline", "--stream", streamFile(join_(messages))], { root });
    assert.equal(refused.code, 1, plant.toString());
    assert.match(refused.err, /ship-kit/);
  }
});

test("a RED run under another model is refused", () => {
  const root = repoWithSkill("s\n");
  const other = run(["baseline", "--stream", streamFile(withModel(baselineStream(), OTHER_MODEL))], { root });
  assert.equal(other.code, 1);
  assert.equal(other.out, "");
  assert.match(other.err, new RegExp(`${OTHER_MODEL} differs from the pinned model ${FIXTURE_MODEL}`));
  const none = run(["baseline", "--stream", streamFile(withModel(baselineStream(), undefined))], { root });
  assert.equal(none.code, 1);
  assert.match(none.err, /init message names no model/);
});

test("a RED run with no final success is refused", () => {
  const root = repoWithSkill("s\n");
  const messages = parse(baselineStream());
  const truncated = messages.slice(0, messages.findLastIndex((m) => m.type === "result"));
  const cases = [
    join_(truncated),
    join_([...messages, messages[1]]),
    withResult(baselineStream(), (m) => ({ ...m, subtype: "error_max_turns" })),
    withResult(baselineStream(), (m) => ({ ...m, is_error: true })),
    withResult(baselineStream(), (m) => ({ ...m, result: 42 })),
    join_(messages.slice(1)),
    join_([messages[0], ...messages]),
    "",
  ];
  for (const stream of cases) {
    const refused = run(["baseline", "--stream", streamFile(stream)], { root });
    assert.equal(refused.code, 1, stream.slice(-120));
    assert.equal(refused.out, "");
    assert.ok(refused.err.length > 0);
  }
});

test("baseline usage errors exit 2", () => {
  const root = repoWithSkill("s\n");
  for (const argv of [["baseline"], ["baseline", "--stream"], ["baseline", "--stream", join(root, "missing.jsonl")], ["baseline", "--stream", "x", "--any-model"]]) {
    const result = run(argv, { root });
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.ok(result.err.length > 0);
  }
});
