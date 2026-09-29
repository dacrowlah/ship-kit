#!/usr/bin/env node
// Pressure-test tooling (CLAUDE.md, Skills, "Pressure-test method").
//
//   stage --out <dir>                          copy what ships, minus dependencies,
//                                              into <dir>/<tree hash>; prints that path
//   check --skill <name> --stream <f> [--dmi] [--any-model]
//                                              decide whether a GREEN run counts;
//                                              prints the hash of the text it loaded
//                                              and the run's model
//   baseline --stream <f>                      decide whether a RED run counts;
//                                              prints the run's model and final text
//   hash --skill <name>                        shipped-text SHA-256 of a skill
//
// check and baseline accept only a run whose init message reports the model
// in tests/skills/pinned-model.txt; --any-model lifts that for check alone.
//
// Exit codes: 0 valid, 1 the stream fails a condition, 2 usage or I/O error.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const STAGED = [".claude-plugin", "skills", "scripts", "review", "schemas", "templates"];
const MARKER_PREFIX = "skill_marker: ";
const MARKER_VALUE = /^[a-z0-9][a-z0-9-]*@[^\s:]+:([0-9a-f]{16})$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const BASE_PREFIX = "Base directory for this skill: ";
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const ARGUMENTS_SUFFIX = "\n\nARGUMENTS: ";
const PLUGIN_REFERENCE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g;
/** A model id as the config schema accepts it. */
export const MODEL_ID = /^[A-Za-z0-9._\[\]-]{1,100}$/;
const PIN_FILE = join("tests", "skills", "pinned-model.txt");

class UsageError extends Error {}

/**
 * The pressure-test model: the one line of `<root>/tests/skills/pinned-model.txt`,
 * which must match MODEL_ID and end in exactly one newline.
 * @param {string} root the repository root
 * @returns {string}
 */
export function pinnedModel(root) {
  const path = join(root, PIN_FILE);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${PIN_FILE}: ${error.message}`);
  }
  const line = /^([^\n]*)\n$/.exec(text)?.[1];
  if (line === undefined || !MODEL_ID.test(line)) {
    throw new UsageError(`${PIN_FILE} must hold one model id line ending in a newline`);
  }
  return line;
}

/**
 * Copies each shipped directory that exists under `root` into
 * `<out>/<staged tree hash>` and deletes `dependencies` from the copy's
 * plugin.json. `out` must be empty or absent and outside `root`. The path
 * names its content, so different text never stages at the same path.
 * @param {{root: string, out: string}} options
 * @returns {string} the staged plugin directory
 */
export function stage({ root, out }) {
  const source = realpathSync(root);
  const target = resolve(out);
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory() || readdirSync(target).length > 0) {
      throw new UsageError(`${out} must be empty or absent`);
    }
  }
  const existing = nearestExisting(target);
  if (isInside(source, join(realpathSync(existing), relative(existing, target)))) {
    throw new UsageError(`${out} is inside the source tree ${root}`);
  }
  const manifest = join(source, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) throw new UsageError(`${manifest} does not exist`);
  const json = JSON.parse(readFileSync(manifest, "utf8"));
  const sources = STAGED.map((name) => join(source, name)).filter(present);
  for (const from of sources) refuseEscapingLinks(from, sources);
  const partial = join(target, ".partial");
  for (const from of sources) {
    cpSync(from, join(partial, relative(source, from)), { recursive: true, verbatimSymlinks: true });
  }
  delete json.dependencies;
  writeFileSync(join(partial, ".claude-plugin", "plugin.json"), JSON.stringify(json, null, 2) + "\n");
  const staged = join(target, stagedTreeHash(partial));
  renameSync(partial, staged);
  return staged;
}

/**
 * SHA-256 over a staged tree: every regular file (path, byte length,
 * bytes) and every symlink (path, target), sorted by path.
 * @param {string} dir
 * @returns {string} hex digest
 */
export function stagedTreeHash(dir) {
  const entries = [];
  const walk = (path) => {
    const stat = lstatSync(path);
    const name = relative(dir, path).split(sep).join("/");
    if (stat.isDirectory()) for (const child of readdirSync(path)) walk(join(path, child));
    else if (stat.isSymbolicLink()) entries.push([name, `L\n${name}\n${readlinkSync(path)}\n`, null]);
    else if (stat.isFile()) entries.push([name, null, readFileSync(path)]);
    else throw new UsageError(`${path} is neither a file, a directory nor a symlink`);
  };
  walk(dir);
  const hash = createHash("sha256");
  for (const [name, link, bytes] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (link !== null) hash.update(link);
    else hash.update(`F\n${name}\n${bytes.length}\n`).update(bytes);
  }
  return hash.digest("hex");
}

/**
 * True when `loaded`, the skill body a run showed after "Base directory
 * for this skill:", equals SKILL.md without its frontmatter once the
 * plugin-root and skill-dir variables are substituted as Claude Code does.
 * When SKILL.md has no `$ARGUMENTS` and the run passed arguments, Claude
 * Code appends "\n\nARGUMENTS: <args>" to the body; that exact suffix,
 * with arguments the run's Skill call passed, is also accepted.
 * @param {string} skillText SKILL.md content @param {string} loaded
 * @param {{pluginPath: string, skill: string, args?: string[]}} options
 */
export function loadedBodyMatches(skillText, loaded, { pluginPath, skill, args = [] }) {
  let body = skillText.replace(/\r\n/g, "\n");
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 3);
    body = end === -1 ? "" : body.slice(end + 5);
  }
  const expected = body
    .split("${CLAUDE_PLUGIN_ROOT}")
    .join(pluginPath)
    .split("${CLAUDE_SKILL_DIR}")
    .join(`${pluginPath}/skills/${skill}`)
    .split("$ARGUMENTS")
    .join("");
  const text = loaded.replace(/\r\n/g, "\n");
  if (expected.trim() === text.trim()) return true;
  if (body.includes("$ARGUMENTS")) return false;
  const at = text.lastIndexOf(ARGUMENTS_SUFFIX);
  return at !== -1 && args.includes(text.slice(at + ARGUMENTS_SUFFIX.length)) && expected.trim() === text.slice(0, at).trim();
}

/** @param {string} parent @param {string} path @returns {boolean} path is parent or below it */
function isInside(parent, path) {
  const rel = relative(parent, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Throws on a symlink at or under `path` that is absolute or resolves
 * outside every staged directory, since the copy keeps link targets verbatim.
 * @param {string} path @param {string[]} staged
 */
function refuseEscapingLinks(path, staged) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    const resolved = resolve(dirname(path), target);
    if (isAbsolute(target) || staged.includes(path) || !staged.some((dir) => isInside(dir, resolved))) {
      throw new UsageError(`${path} is a symlink leaving the staged directories`);
    }
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) refuseEscapingLinks(join(path, name), staged);
  }
}

/** @param {string} path @returns {boolean} the path exists, a dangling symlink included */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path @returns {string} the nearest existing ancestor */
function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  return current;
}

/**
 * The value of the single `skill_marker: ` line, or null when there is none.
 * @param {string} text SKILL.md content
 * @returns {string | null}
 */
export function readMarker(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.startsWith(MARKER_PREFIX));
  if (lines.length === 0) return null;
  if (lines.length > 1) throw new UsageError("SKILL.md has more than one skill_marker line");
  const value = lines[0].slice(MARKER_PREFIX.length).trim();
  if (!MARKER_VALUE.test(value)) throw new UsageError("malformed skill_marker line in SKILL.md");
  return value;
}

/** @param {string} text @param {string | undefined} marker @returns {string} */
function redactToken(text, marker) {
  const match = marker ? MARKER_VALUE.exec(marker) : null;
  return match ? text.replace(new RegExp(match[1], "gi"), "<token>") : text;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {Record<string, any>} message */
const isTopLevel = (message) => message.parent_tool_use_id === undefined || message.parent_tool_use_id === null;

/** @param {Record<string, any>} message @returns {any[]} */
const contentOf = (message) => (Array.isArray(message.message?.content) ? message.message.content : []);

/**
 * Decides whether a stream-json run counts as a GREEN run of `ship-kit:<skill>`.
 * The init message must report a model, equal to `expectModel` when given.
 * @param {string} text the stream, one JSON message per line
 * @param {{skill: string, dmi?: boolean, marker?: string | null, expectModel?: string}} options
 * @returns {{ok: true, text: string, model: string, pluginPath: string, loadedBodies: string[], skillArgs: string[]} | {ok: false, reason: string}}
 */
export function checkStream(text, { skill, dmi = false, marker = null, expectModel }) {
  const qualified = `ship-kit:${skill}`;
  const messages = parseMessages(text);
  const found = singleInit(messages, expectModel);
  if (!found.ok) return found;
  const { init, index: initAt, model } = found;
  const lists = (key) => Array.isArray(init[key]) && init[key].includes(qualified);
  if (!lists("skills") && !lists("slash_commands")) {
    return { ok: false, reason: `init lists ${qualified} in neither skills nor slash_commands` };
  }
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter((p) => isObject(p) && p.name === "ship-kit");
  if (plugins.length !== 1 || typeof plugins[0].path !== "string" || !isAbsolute(plugins[0].path)) {
    return { ok: false, reason: "init lists no single ship-kit plugin with an absolute path" };
  }
  const pluginPath = plugins[0].path;
  if (posix.normalize(pluginPath) !== pluginPath || !CONTENT_HASH.test(basename(pluginPath))) {
    return { ok: false, reason: "the ship-kit plugin path is not a content-addressed stage" };
  }
  const failedRead = stagedReadFailure(messages, pluginPath);
  if (failedRead) return { ok: false, reason: `the run could not read the staged plugin: ${failedRead}` };
  const skillDir = `${pluginPath}/skills/${skill}`;
  const loadedBodies = [];
  for (const m of messages.slice(initAt + 1)) {
    if (m.type !== "user" || !isTopLevel(m)) continue;
    for (const block of contentOf(m)) {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") continue;
      if (!block.text.startsWith(BASE_PREFIX)) continue;
      const [head, ...rest] = block.text.split("\n\n");
      const dir = head.slice(BASE_PREFIX.length);
      if (dir === skillDir) loadedBodies.push(rest.join("\n\n"));
      else if (dir.includes(`/skills/${skill}`)) {
        return { ok: false, reason: `the run loaded ${qualified} from another directory` };
      }
    }
  }
  if (!dmi && loadedBodies.length === 0) return { ok: false, reason: `the stream shows no loaded skill body for ${qualified}` };
  const final = messages.at(-1);
  const ended = finalSuccess(messages);
  if (ended) return { ok: false, reason: ended };
  if (dmi) {
    if (!marker) return { ok: false, reason: `skills/${skill}/SKILL.md has no skill_marker line` };
    const returned = final.structured_output?.skill_marker;
    if (typeof returned !== "string") return { ok: false, reason: "final result has no structured_output.skill_marker" };
    if (returned !== marker) return { ok: false, reason: "structured_output.skill_marker differs from the SKILL.md marker" };
  } else if (!invokedSkill(messages, initAt, qualified)) {
    return { ok: false, reason: `no Skill tool call invoked ${qualified} successfully` };
  }
  const skillArgs = messages.flatMap((m) =>
    m.type === "assistant" && isTopLevel(m)
      ? contentOf(m).flatMap((b) =>
          isObject(b) && b.type === "tool_use" && b.name === "Skill" && b.input?.skill === qualified && typeof b.input.args === "string"
            ? [b.input.args]
            : [],
        )
      : [],
  );
  return { ok: true, text: redactToken(final.result, marker ?? undefined), model, pluginPath, loadedBodies, skillArgs };
}

/** @param {string} text a stream, one JSON message per line @returns {Record<string, any>[]} its object messages */
function parseMessages(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (isObject(value)) messages.push(value);
    } catch {
      // Lines that are not JSON are ignored.
    }
  }
  return messages;
}

/**
 * The stream's one system/init message and the model it reports, which
 * must equal `expectModel` when that is a string.
 * @param {Record<string, any>[]} messages @param {string | undefined} expectModel
 * @returns {{ok: true, init: Record<string, any>, index: number, model: string} | {ok: false, reason: string}}
 */
function singleInit(messages, expectModel) {
  const inits = messages.flatMap((m, i) => (m.type === "system" && m.subtype === "init" ? [i] : []));
  if (inits.length === 0) return { ok: false, reason: "no system/init message" };
  if (inits.length > 1) return { ok: false, reason: "more than one system/init message" };
  const init = messages[inits[0]];
  if (typeof init.model !== "string") return { ok: false, reason: "init message names no model" };
  if (typeof expectModel === "string" && init.model !== expectModel) {
    return { ok: false, reason: `the run's model ${init.model} differs from the pinned model ${expectModel}` };
  }
  return { ok: true, init, index: inits[0], model: init.model };
}

/** @param {Record<string, any>[]} messages @returns {string | null} why the stream does not end in a success result, or null */
function finalSuccess(messages) {
  const final = messages.at(-1);
  if (final?.type !== "result") return "no final result message";
  if (final.subtype !== "success" || final.is_error === true) return "final result message is not a success";
  if (typeof final.result !== "string") return "final result message has no result text";
  return null;
}

/**
 * Decides whether a stream-json run counts as a RED run: one init message
 * reporting `expectModel`, no ship-kit plugin, skill or slash command in
 * it (a run that loaded ship-kit is not a baseline), and a final success.
 * @param {string} text the stream @param {{expectModel: string}} options
 * @returns {{ok: true, text: string, model: string} | {ok: false, reason: string}}
 */
export function checkBaseline(text, { expectModel }) {
  if (typeof expectModel !== "string") throw new UsageError("checkBaseline needs the expectModel it accepts");
  const messages = parseMessages(text);
  const found = singleInit(messages, expectModel);
  if (!found.ok) return found;
  const { init, model } = found;
  const listed = (key) => (Array.isArray(init[key]) ? init[key] : []);
  if (listed("plugins").some((p) => isObject(p) && p.name === "ship-kit")) {
    return { ok: false, reason: "init lists the ship-kit plugin" };
  }
  for (const key of ["skills", "slash_commands"]) {
    const entry = listed(key).find((name) => typeof name === "string" && name.startsWith("ship-kit:"));
    if (entry !== undefined) return { ok: false, reason: `init lists ${entry} in ${key}` };
  }
  const ended = finalSuccess(messages);
  if (ended) return { ok: false, reason: ended };
  return { ok: true, text: messages.at(-1).result, model };
}

/**
 * The first Read, Grep or Glob call aimed at the staged plugin whose result
 * is missing or an error, as "<tool> <path>", or null. A GREEN run that
 * could not read the plugin's files never saw the text its hash covers.
 * @param {Record<string, any>[]} messages @param {string} pluginPath
 * @returns {string | null}
 */
function stagedReadFailure(messages, pluginPath) {
  const blocks = messages.flatMap(contentOf).filter(isObject);
  const under = (value) => typeof value === "string" && (value === pluginPath || value.startsWith(`${pluginPath}/`));
  for (const call of blocks) {
    if (call.type !== "tool_use" || !["Read", "Grep", "Glob"].includes(call.name)) continue;
    const target = [call.input?.file_path, call.input?.path, call.input?.pattern].find(under);
    if (target === undefined) continue;
    const results = blocks.filter((b) => b.type === "tool_result" && b.tool_use_id === call.id);
    if (results.length === 0 || results.some((r) => r.is_error === true)) return `${call.name} ${target}`;
  }
  return null;
}

/**
 * True when a top-level assistant message after the init calls Skill on
 * `qualified` with an id no other block uses, and exactly one tool_result
 * for that id follows it in a top-level user message and is not an error.
 * @param {Record<string, any>[]} messages @param {number} start init index @param {string} qualified
 */
function invokedSkill(messages, start, qualified) {
  const blocks = messages.flatMap((m, index) => contentOf(m).filter(isObject).map((block) => ({ m, index, block })));
  return blocks.some(({ m, index, block }) => {
    if (index <= start || m.type !== "assistant" || !isTopLevel(m)) return false;
    if (block.type !== "tool_use" || block.name !== "Skill" || block.input?.skill !== qualified) return false;
    if (typeof block.id !== "string" || block.id === "") return false;
    if (blocks.filter((b) => b.block.type === "tool_use" && b.block.id === block.id).length !== 1) return false;
    const results = blocks.filter((b) => b.block.type === "tool_result" && b.block.tool_use_id === block.id);
    if (results.length !== 1) return false;
    const [result] = results;
    return result.index > index && result.m.type === "user" && isTopLevel(result.m) && result.block.is_error !== true;
  });
}

/**
 * Every regular file under `dir` (a directory or a symlink throws), keyed
 * by its path relative to `base` with `/` separators.
 * @param {string} dir @param {string} base @param {Map<string, string>} into
 */
function collectFiles(dir, base, into) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) collectFiles(path, base, into);
    else if (stat.isFile()) into.set(relative(base, path).split(sep).join("/"), path);
    else throw new UsageError(`${path} is not a regular file`);
  }
}

/**
 * The shipped-text SHA-256 of a skill: every regular file under its
 * directory, plus every file under the plugin root that one of them names
 * as `${CLAUDE_PLUGIN_ROOT}/<path>`, sorted by name, each contributing
 * `<name>\n<byte length>\n<content>` with CRLF read as LF. The single
 * `skill_marker: ` line of SKILL.md is left out, and nothing else is.
 * @param {string} dir the skill directory, `<plugin root>/skills/<name>`
 * @returns {string} hex digest
 */
export function shippedTextHash(dir) {
  const root = resolve(dir, "..", "..");
  const own = new Map();
  collectFiles(dir, dir, own);
  if (!own.has("SKILL.md")) throw new UsageError(`${dir} has no SKILL.md`);
  const read = (path) => readFileSync(path).toString("latin1").replace(/\r\n/g, "\n");
  const entries = new Map([...own].map(([name, path]) => [name, read(path)]));
  const skillLines = entries.get("SKILL.md").split("\n");
  const markerAt = skillLines.findIndex((line) => line.startsWith(MARKER_PREFIX));
  if (markerAt !== -1) skillLines.splice(markerAt, 1);
  entries.set("SKILL.md", skillLines.join("\n"));
  for (const content of [...entries.values()]) {
    for (const [, reference] of content.matchAll(PLUGIN_REFERENCE)) {
      const clean = posix.normalize(reference.replace(/[.]+$/, ""));
      if (clean === "." || clean.startsWith("..") || !existsSync(join(root, clean))) continue;
      const target = join(root, clean);
      const shared = new Map();
      if (lstatSync(target).isDirectory()) collectFiles(target, root, shared);
      else if (lstatSync(target).isFile()) shared.set(clean, target);
      else throw new UsageError(`${target} is not a regular file`);
      for (const [name, path] of shared) entries.set(`\${CLAUDE_PLUGIN_ROOT}/${name}`, read(path));
    }
  }
  const hash = createHash("sha256");
  for (const name of [...entries.keys()].sort()) {
    const bytes = Buffer.from(entries.get(name), "latin1");
    hash.update(`${name}\n${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Checks the staged copy a valid stream names: it still hashes to its
 * path's name, and every body the run loaded equals its SKILL.md.
 * @param {{pluginPath: string, loadedBodies: string[]}} verdict @param {string} skill
 * @returns {string | null} the failed condition, or null
 */
function verifyStaged({ pluginPath, loadedBodies, skillArgs = [] }, skill) {
  const skillFile = join(pluginPath, "skills", skill, "SKILL.md");
  if (!existsSync(skillFile)) return `the staged plugin the run loaded has no skills/${skill}/SKILL.md`;
  if (stagedTreeHash(pluginPath) !== basename(pluginPath)) {
    return `the staged copy at ${pluginPath} does not match its content hash`;
  }
  const text = readFileSync(skillFile, "utf8");
  if (!loadedBodies.every((body) => loadedBodyMatches(text, body, { pluginPath, skill, args: skillArgs }))) {
    return "the loaded skill body differs from the staged SKILL.md";
  }
  return null;
}

/**
 * Parses `--flag value` pairs and bare boolean flags; each flag at most once.
 * @param {string[]} args @param {string[]} valued @param {string[]} booleans
 */
function parseFlags(args, valued, booleans) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || name in flags) throw new UsageError(`unexpected argument ${args[i]}`);
    if (booleans.includes(name)) flags[name] = true;
    else if (valued.includes(name) && i + 1 < args.length) flags[name] = args[++i];
    else throw new UsageError(`unexpected argument ${args[i]}`);
  }
  return flags;
}

/** @param {string | undefined} name @returns {string} */
function skillName(name) {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new UsageError("--skill <name> is required");
  return name;
}

/** @param {string} root @param {string} name */
function skillDirOf(root, name) {
  const dir = join(root, "skills", name);
  if (!existsSync(join(dir, "SKILL.md"))) throw new UsageError(`${join("skills", name, "SKILL.md")} does not exist`);
  return dir;
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{stdout: {write(s: string): void}, stderr: {write(s: string): void}, root?: string}} io
 * @returns {number} exit code
 */
export function main(argv, io) {
  const root = io.root ?? REPO;
  try {
    const [verb, ...rest] = argv;
    if (verb === "stage") {
      const flags = parseFlags(rest, ["out"], []);
      if (!flags.out) throw new UsageError("--out <dir> is required");
      io.stdout.write(`${stage({ root, out: flags.out })}\n`);
      return 0;
    }
    if (verb === "check") {
      const flags = parseFlags(rest, ["skill", "stream"], ["dmi", "any-model"]);
      const name = skillName(flags.skill);
      if (!flags.stream) throw new UsageError("--stream <file> is required");
      const marker = readMarker(readFileSync(join(skillDirOf(root, name), "SKILL.md"), "utf8"));
      const expectModel = flags["any-model"] === true ? undefined : pinnedModel(root);
      const stream = readFileSync(flags.stream, "utf8");
      const verdict = checkStream(stream, { skill: name, dmi: flags.dmi === true, marker, expectModel });
      if (!verdict.ok) {
        io.stderr.write(`invalid GREEN run: ${verdict.reason}\n`);
        return 1;
      }
      const staged = verifyStaged(verdict, name);
      if (staged) {
        io.stderr.write(`invalid GREEN run: ${staged}\n`);
        return 1;
      }
      const loaded = join(verdict.pluginPath, "skills", name);
      io.stdout.write(`Shipped-text SHA-256: ${shippedTextHash(loaded)}\nModel: ${verdict.model}\n\n${verdict.text}\n`);
      return 0;
    }
    if (verb === "baseline") {
      const flags = parseFlags(rest, ["stream"], []);
      if (!flags.stream) throw new UsageError("--stream <file> is required");
      const expectModel = pinnedModel(root);
      const verdict = checkBaseline(readFileSync(flags.stream, "utf8"), { expectModel });
      if (!verdict.ok) {
        io.stderr.write(`invalid RED run: ${verdict.reason}\n`);
        return 1;
      }
      io.stdout.write(`Model: ${verdict.model}\n\n${verdict.text}\n`);
      return 0;
    }
    if (verb === "hash") {
      const flags = parseFlags(rest, ["skill"], []);
      io.stdout.write(shippedTextHash(skillDirOf(root, skillName(flags.skill))) + "\n");
      return 0;
    }
    throw new UsageError(
      "usage: pressure.mjs stage --out <dir> | check --skill <name> --stream <file> [--dmi] [--any-model] | baseline --stream <file> | hash --skill <name>",
    );
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
