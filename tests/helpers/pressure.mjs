#!/usr/bin/env node
// Pressure-test tooling (CLAUDE.md, Skills, "Pressure-test method").
//
//   stage --out <dir>                          copy what ships, minus dependencies
//   check --skill <name> --stream <f> [--dmi]  decide whether a GREEN run counts
//   hash --skill <name>                        shipped-text SHA-256 of a skill
//
// Exit codes: 0 valid, 1 the stream fails a condition, 2 usage or I/O error.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const STAGED = [".claude-plugin", "skills", "scripts", "review", "schemas", "templates"];
const MARKER_PREFIX = "skill_marker: ";
const MARKER_VALUE = /^[a-z0-9][a-z0-9-]*@[^\s:]+:([0-9a-f]{16})$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

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
  const rel = relative(source, join(realpathSync(existing), relative(existing, target)));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new UsageError(`${out} is inside the source tree ${root}`);
  }
  const manifest = join(source, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) throw new UsageError(`${manifest} does not exist`);
  const json = JSON.parse(readFileSync(manifest, "utf8"));
  for (const name of STAGED) {
    const from = join(source, name);
    if (existsSync(from)) cpSync(from, join(target, name), { recursive: true });
  }
  delete json.dependencies;
  writeFileSync(join(target, ".claude-plugin", "plugin.json"), JSON.stringify(json, null, 2) + "\n");
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
  if (!MARKER_VALUE.test(value)) throw new UsageError(`malformed skill_marker line: ${lines[0]}`);
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
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
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
  const final = messages.at(-1);
  if (final.type !== "result") return { ok: false, reason: "no final result message" };
  if (final.is_error === true) return { ok: false, reason: "final result message is an error" };
  if (typeof final.result !== "string") return { ok: false, reason: "final result message has no result text" };
  if (dmi) {
    if (!marker) return { ok: false, reason: `skills/${skill}/SKILL.md has no skill_marker line` };
    const returned = final.structured_output?.skill_marker;
    if (typeof returned !== "string") return { ok: false, reason: "final result has no structured_output.skill_marker" };
    if (returned !== marker) return { ok: false, reason: "structured_output.skill_marker differs from the SKILL.md marker" };
  } else {
    const after = messages.slice(inits[0] + 1).filter(isTopLevel);
    const calls = after
      .filter((m) => m.type === "assistant")
      .flatMap(contentOf)
      .filter((c) => c?.type === "tool_use" && c.name === "Skill" && c.input?.skill === qualified);
    const succeeded = calls.some((call) =>
      after
        .filter((m) => m.type === "user")
        .flatMap(contentOf)
        .some((c) => c?.type === "tool_result" && c.tool_use_id === call.id && c.is_error !== true),
    );
    if (!succeeded) return { ok: false, reason: `no Skill tool call invoked ${qualified} successfully` };
  }
  return { ok: true, text: redactToken(final.result, marker ?? undefined) };
}

/**
 * SHA-256 over SKILL.md and every *.md beside it, sorted by name, each as
 * `<name>\n<byte length>\n<content>` with CRLF read as LF and every line
 * starting `skill_marker: ` removed.
 * @param {string} dir the skill directory
 * @returns {string} hex digest
 */
export function shippedTextHash(dir) {
  const names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  if (!names.includes("SKILL.md")) throw new UsageError(`${dir} has no SKILL.md`);
  const hash = createHash("sha256");
  for (const name of names) {
    const path = join(dir, name);
    if (!lstatSync(path).isFile()) throw new UsageError(`${path} is not a regular file`);
    const content = readFileSync(path, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !line.startsWith(MARKER_PREFIX))
      .join("\n");
    hash.update(`${name}\n${Buffer.byteLength(content, "utf8")}\n`);
    hash.update(content, "utf8");
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
      io.stdout.write(verdict.text + "\n");
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
