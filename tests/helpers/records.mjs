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

const GREEN_RUNS_HEADING = "## GREEN runs";
const RUN_HEADING = /^### Run ([1-9][0-9]*)$/;
/** `<n>. PASS` or `<n>. FAIL`, then optionally `.`, then the end of the line or a space and the evidence. */
const VERDICT_LINE = /^([1-9][0-9]*)\. (PASS|FAIL)\.?(?: .*)?$/;
const CHECK_OUTPUT = "Shipped-text SHA-256: ";

/**
 * A record's lines as they render: fenceMap's lines, with the text of HTML
 * comments (`<!-- ... -->`, which may span lines) removed from lines
 * outside fences, and fenced lines that sit inside a comment dropped.
 * @param {string} text @returns {{text: string, fenced: boolean, block: number}[]}
 */
export function visibleLines(text) {
  const visible = [];
  let hidden = false;
  for (const line of fenceMap(text).lines) {
    if (line.fenced) {
      if (!hidden) visible.push(line);
      continue;
    }
    let shown = "";
    let rest = line.text;
    while (rest !== "") {
      const at = rest.indexOf(hidden ? "-->" : "<!--");
      if (at === -1) {
        if (!hidden) shown += rest;
        break;
      }
      if (!hidden) shown += rest.slice(0, at);
      rest = rest.slice(at + (hidden ? 3 : 4));
      hidden = !hidden;
    }
    visible.push({ ...line, text: shown });
  }
  return visible;
}

/**
 * The runs of result.md's one `## GREEN runs` section (CLAUDE.md,
 * "Pressure-test method"), read from its visible lines: the section ends
 * at the next `# ` or `## ` heading outside fences, and each `### ` heading
 * outside fences in it opens a run and must read `### Run <n>`, numbered
 * from 1 in order; lines before the first run belong to none. A check
 * output is a fenced block whose first line starts `Shipped-text SHA-256: `,
 * given as its lines between the fence lines. Each run yields its check
 * outputs and every verdict line (VERDICT_LINE) outside fences.
 * `elsewhere` holds every check output of the record, hidden ones
 * included, that is not one of a run's.
 * @param {string} text result.md
 * @returns {{runs: {outputs: string[][], verdicts: {criterion: string, verdict: string}[]}[], elsewhere: string[][], problems: string[]}}
 */
export function greenRuns(text) {
  /** @param {{text: string, fenced: boolean, block: number}[]} lines @returns {Map<number, string[]>} check outputs by block */
  const outputsOf = (lines) => {
    const blocks = new Map();
    for (const line of lines.filter((l) => l.fenced)) blocks.set(line.block, [...(blocks.get(line.block) ?? []), line.text]);
    return new Map([...blocks].filter(([, block]) => block.length > 1 && block[1].startsWith(CHECK_OUTPUT)).map(([n, block]) => [n, block.slice(1, -1)]));
  };
  const all = outputsOf(fenceMap(text).lines);
  const lines = visibleLines(text);
  const starts = lines.flatMap((line, i) => (!line.fenced && line.text === GREEN_RUNS_HEADING ? [i] : []));
  if (starts.length !== 1) {
    return { runs: [], elsewhere: [...all.values()], problems: [starts.length === 0 ? "no ## GREEN runs section" : "more than one ## GREEN runs section"] };
  }
  const rest = lines.slice(starts[0] + 1);
  const end = rest.findIndex((line) => !line.fenced && /^#{1,2} /.test(line.text));
  const buckets = [];
  const problems = [];
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    if (!line.fenced && line.text.startsWith("### ")) {
      const expected = `### Run ${buckets.length + 1}`;
      if (RUN_HEADING.exec(line.text)?.[0] !== expected) problems.push(`heading "${line.text}" in ## GREEN runs is not "${expected}"`);
      buckets.push([]);
    } else if (buckets.length > 0) buckets.at(-1).push(line);
  }
  const counted = new Set();
  const runs = buckets.map((run) => {
    const outputs = outputsOf(run);
    for (const block of outputs.keys()) counted.add(block);
    const verdicts = run.flatMap((l) => {
      const match = l.fenced ? null : VERDICT_LINE.exec(l.text);
      return match ? [{ criterion: match[1], verdict: match[2] }] : [];
    });
    return { outputs: [...outputs.values()], verdicts };
  });
  const elsewhere = [...all].filter(([block]) => !counted.has(block)).map(([, output]) => output);
  return { runs, elsewhere, problems };
}
