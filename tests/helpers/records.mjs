// Reads the Markdown pressure-test records under tests/skills/<skill>/ for
// the records gates (tests/skills/artifacts.test.mjs) and the drift runner
// (tests/helpers/drift.mjs), so both read a section, a fenced block and a
// repository path the same way.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";

/**
 * Marks each line as inside or outside a fenced code block, following
 * CommonMark: an opener is up to three spaces, then three or more backticks
 * (with no backtick in the info string) or tildes; a closer is the same
 * character, at least as long, with nothing but spaces after it.
 * @param {string} text
 * @returns {{lines: {text: string, fenced: boolean, block: number}[], unclosed: number | null}}
 *   block numbers each fenced block from 1 (0 outside fences); unclosed is the 1-based line of a fence never closed
 */
export function fenceMap(text) {
  const lines = [];
  let open = null;
  let blocks = 0;
  text.split("\n").forEach((line, index) => {
    if (open === null) {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
        blocks += 1;
        open = { fence: opener[1], line: index + 1 };
        lines.push({ text: line, fenced: true, block: blocks });
      } else lines.push({ text: line, fenced: false, block: 0 });
      return;
    }
    lines.push({ text: line, fenced: true, block: blocks });
    const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (closer && closer[1][0] === open.fence[0] && closer[1].length >= open.fence.length) open = null;
  });
  return { lines, unclosed: open === null ? null : open.line };
}

/** Lines of a Markdown text that sit outside fenced code blocks. @param {string} text @returns {string[]} */
export function linesOutsideFences(text) {
  return fenceMap(text).lines.filter((l) => !l.fenced).map((l) => l.text);
}

/**
 * The bodies of every `## <heading>` section: the lines up to the next
 * `## ` or `# ` heading, outside fences.
 * @param {string} text @param {string} heading @returns {string[][]}
 */
export function sections(text, heading) {
  const lines = linesOutsideFences(text);
  const found = [];
  lines.forEach((line, start) => {
    if (line !== `## ${heading}`) return;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^#{1,2} /.test(l));
    found.push(end === -1 ? rest : rest.slice(0, end));
  });
  return found;
}

/** The first `## <heading>` section's body, or null. @param {string} text @param {string} heading */
export function section(text, heading) {
  return sections(text, heading)[0] ?? null;
}

/**
 * True when `rel` is a normalized relative path naming a regular file (not
 * a symlink) whose real path, every directory resolved, lies inside root.
 * @param {string} root @param {string} rel @returns {boolean}
 */
export function isRepoFile(root, rel) {
  if (typeof rel !== "string" || isAbsolute(rel) || posix.normalize(rel) !== rel || rel.startsWith("..")) return false;
  const path = join(root, rel);
  if (!existsSync(path) || !lstatSync(path).isFile()) return false;
  return realpathSync(path).startsWith(`${realpathSync(root)}${sep}`);
}
