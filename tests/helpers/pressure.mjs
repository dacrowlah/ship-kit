#!/usr/bin/env node
// Pressure-test tooling (CLAUDE.md, Skills, "Pressure-test method").
//
//   stage --out <dir>                          copy what ships, minus dependencies
//   check --skill <name> --stream <f> [--dmi]  decide whether a GREEN run counts;
//                                              prints the hash of the text it loaded
//   hash --skill <name>                        shipped-text SHA-256 of a skill
//
// Exit codes: 0 valid, 1 the stream fails a condition, 2 usage or I/O error.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const STAGED = [".claude-plugin", "skills", "scripts", "review", "schemas", "templates"];
const MARKER_PREFIX = "skill_marker: ";
const MARKER_VALUE = /^[a-z0-9][a-z0-9-]*@[^\s:]+:([0-9a-f]{16})$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PLUGIN_REFERENCE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g;

class UsageError extends Error {}

/**
 * Copies each shipped directory that exists under `root` into `out` and
 * deletes `dependencies` from the copy's plugin.json. `out` must be empty
 * or absent and outside `root`.
 * @param {{root: string, out: string}} options
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
  for (const from of sources) {
    cpSync(from, join(target, relative(source, from)), { recursive: true, verbatimSymlinks: true });
  }
  delete json.dependencies;
  writeFileSync(join(target, ".claude-plugin", "plugin.json"), JSON.stringify(json, null, 2) + "\n");
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
 * @param {string} text the stream, one JSON message per line
 * @param {{skill: string, dmi?: boolean, marker?: string | null}} options
 * @returns {{ok: true, text: string, pluginPath: string} | {ok: false, reason: string}}
 */
export function checkStream(text, { skill, dmi = false, marker = null }) {
  const qualified = `ship-kit:${skill}`;
  const messages = [];
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (isObject(value)) messages.push(value);
    } catch {
      // Lines that are not JSON are ignored.
    }
  }
  const inits = messages.flatMap((m, i) => (m.type === "system" && m.subtype === "init" ? [i] : []));
  if (inits.length === 0) return { ok: false, reason: "no system/init message" };
  if (inits.length > 1) return { ok: false, reason: "more than one system/init message" };
  const init = messages[inits[0]];
  const lists = (key) => Array.isArray(init[key]) && init[key].includes(qualified);
  if (!lists("skills") && !lists("slash_commands")) {
    return { ok: false, reason: `init lists ${qualified} in neither skills nor slash_commands` };
  }
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter((p) => isObject(p) && p.name === "ship-kit");
  if (plugins.length !== 1 || typeof plugins[0].path !== "string" || !isAbsolute(plugins[0].path)) {
    return { ok: false, reason: "init lists no single ship-kit plugin with an absolute path" };
  }
  const final = messages.at(-1);
  if (final.type !== "result") return { ok: false, reason: "no final result message" };
  if (final.subtype !== "success" || final.is_error === true) {
    return { ok: false, reason: "final result message is not a success" };
  }
  if (typeof final.result !== "string") return { ok: false, reason: "final result message has no result text" };
  if (dmi) {
    if (!marker) return { ok: false, reason: `skills/${skill}/SKILL.md has no skill_marker line` };
    const returned = final.structured_output?.skill_marker;
    if (typeof returned !== "string") return { ok: false, reason: "final result has no structured_output.skill_marker" };
    if (returned !== marker) return { ok: false, reason: "structured_output.skill_marker differs from the SKILL.md marker" };
  } else if (!invokedSkill(messages, inits[0], qualified)) {
    return { ok: false, reason: `no Skill tool call invoked ${qualified} successfully` };
  }
  return { ok: true, text: redactToken(final.result, marker ?? undefined), pluginPath: plugins[0].path };
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
      if (clean.startsWith("..") || !existsSync(join(root, clean))) continue;
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
      stage({ root, out: flags.out });
      io.stdout.write(`staged ${flags.out}\n`);
      return 0;
    }
    if (verb === "check") {
      const flags = parseFlags(rest, ["skill", "stream"], ["dmi"]);
      const name = skillName(flags.skill);
      if (!flags.stream) throw new UsageError("--stream <file> is required");
      const marker = readMarker(readFileSync(join(skillDirOf(root, name), "SKILL.md"), "utf8"));
      const verdict = checkStream(readFileSync(flags.stream, "utf8"), { skill: name, dmi: flags.dmi === true, marker });
      if (!verdict.ok) {
        io.stderr.write(`invalid GREEN run: ${verdict.reason}\n`);
        return 1;
      }
      const loaded = join(verdict.pluginPath, "skills", name);
      if (!existsSync(join(loaded, "SKILL.md"))) {
        io.stderr.write(`invalid GREEN run: the staged plugin the run loaded has no skills/${name}/SKILL.md\n`);
        return 1;
      }
      io.stdout.write(`Shipped-text SHA-256: ${shippedTextHash(loaded)}\n\n${verdict.text}\n`);
      return 0;
    }
    if (verb === "hash") {
      const flags = parseFlags(rest, ["skill"], []);
      io.stdout.write(shippedTextHash(skillDirOf(root, skillName(flags.skill))) + "\n");
      return 0;
    }
    throw new UsageError("usage: pressure.mjs stage --out <dir> | check --skill <name> --stream <file> [--dmi] | hash --skill <name>");
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
