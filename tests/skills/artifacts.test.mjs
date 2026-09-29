import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shippedTextHash } from "../helpers/pressure.mjs";
import { listSkills } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ARTIFACTS = ["scenario.md", "baseline.md", "result.md"];
const HASH_LINE = /^Shipped-text SHA-256: (.*)$/;
const CRITERIA_LINE = /^Discriminating criteria: (.*)$/;
const CODE_FILE = /\.(mjs|cjs|js)$/;
const RELATIVE_IMPORTS = [
  /\bfrom\s*(["'])(\.\.?\/[^"']+)\1/g,
  /\bimport\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g,
  /^\s*import\s*(["'])(\.\.?\/[^"']+)\1/gm,
];

/** @param {string} root @param {string} skill @param {string} file @returns {string | null} */
const readRecord = (root, skill, file) => {
  const path = join(root, "tests", "skills", skill, file);
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
};

/** Lines of a Markdown text that sit outside fenced code blocks. @param {string} text @returns {string[]} */
export function linesOutsideFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null && open) fence = open[1];
    else if (fence !== null && line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") fence = null;
    else if (fence === null) out.push(line);
  }
  return out;
}

/**
 * The body of a `## <heading>` section: the lines up to the next `## ` or
 * `# ` heading, outside fences. Null when the section is absent.
 * @param {string} text @param {string} heading @returns {string[] | null}
 */
export function section(text, heading) {
  const lines = linesOutsideFences(text);
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every skill carries its pressure-test record (design 21.5). @returns {string[]} */
export function checkSkillArtifacts(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    for (const file of ARTIFACTS) {
      const text = readRecord(root, skill.name, file);
      if (text === null || text.trim() === "") {
        violations.push(`tests/skills/${skill.name}/${file}: missing or empty`);
      }
    }
  }
  return violations;
}

/**
 * result.md names, outside fenced blocks, exactly one shipped-text hash equal
 * to the skill's current one, and exactly one discriminating-criteria line
 * whose numbers are pass criteria of scenario.md.
 * @param {string} root @returns {string[]}
 */
export function checkRecordHeaders(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const where = `tests/skills/${skill.name}/result.md`;
    const result = readRecord(root, skill.name, "result.md");
    if (result === null) continue;
    const lines = linesOutsideFences(result);
    const hashes = lines.flatMap((line) => HASH_LINE.exec(line)?.slice(1) ?? []);
    if (hashes.length !== 1) violations.push(`${where}: expected one Shipped-text SHA-256 line, found ${hashes.length}`);
    else if (hashes[0] !== shippedTextHash(skill.dir)) {
      violations.push(`${where}: Shipped-text SHA-256 is stale for skills/${skill.name}; rerun GREEN on the shipped text`);
    }
    const criteria = lines.flatMap((line) => CRITERIA_LINE.exec(line)?.slice(1) ?? []);
    if (criteria.length !== 1) {
      violations.push(`${where}: expected one Discriminating criteria line, found ${criteria.length}`);
      continue;
    }
    if (!/^[1-9][0-9]*(, [1-9][0-9]*)*$/.test(criteria[0])) {
      violations.push(`${where}: Discriminating criteria must list criterion numbers, got "${criteria[0]}"`);
      continue;
    }
    const known = new Set(
      (section(readRecord(root, skill.name, "scenario.md") ?? "", "Pass criteria") ?? []).flatMap(
        (line) => /^([1-9][0-9]*)\. /.exec(line)?.slice(1) ?? [],
      ),
    );
    for (const n of criteria[0].split(", ")) {
      if (!known.has(n)) violations.push(`${where}: discriminating criterion ${n} is not a pass criterion in scenario.md`);
    }
  }
  return violations;
}

/** @param {string} root @param {string} rel @returns {boolean} a regular file inside root */
const isRepoFile = (root, rel) => {
  if (isAbsolute(rel) || posix.normalize(rel) !== rel || rel.startsWith("..")) return false;
  const path = join(root, rel);
  return existsSync(path) && lstatSync(path).isFile();
};

/**
 * Relative import specifiers of a module, resolved against its directory.
 * @param {string} text module source @param {string} rel the module's repo path
 * @returns {string[]} repo-relative paths, possibly escaping the repo
 */
export function relativeImports(text, rel) {
  const found = new Set();
  for (const pattern of RELATIVE_IMPORTS) {
    for (const match of text.matchAll(pattern)) found.add(posix.normalize(posix.join(posix.dirname(rel), match[2])));
  }
  return [...found].sort();
}

/**
 * scenario.md has a `## Run directory` section that says `None.` or lists
 * backticked repository files, and every relative import of a listed code
 * file is listed too.
 * @param {string} root @returns {string[]}
 */
export function checkRunDirectories(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const where = `tests/skills/${skill.name}/scenario.md`;
    const scenario = readRecord(root, skill.name, "scenario.md");
    if (scenario === null) continue;
    const body = section(scenario, "Run directory");
    if (body === null) {
      violations.push(`${where}: no ## Run directory section`);
      continue;
    }
    const text = body.join("\n").trim();
    const listed = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (text === "None.") continue;
    if (listed.length === 0) {
      violations.push(`${where}: ## Run directory lists no backticked file and is not "None."`);
      continue;
    }
    for (const rel of listed) {
      if (!isRepoFile(root, rel)) violations.push(`${where}: run directory file ${rel} is not a file in the repository`);
    }
    for (const rel of listed.filter((r) => CODE_FILE.test(r) && isRepoFile(root, r))) {
      for (const imported of relativeImports(readFileSync(join(root, rel), "utf8"), rel)) {
        if (!listed.includes(imported)) violations.push(`${where}: ${rel} imports ${imported}, which the run directory does not list`);
      }
    }
  }
  return violations;
}

/** @param {string} dir @returns {string[]} Markdown files at any depth */
const markdownUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });

/** @param {string} line @returns {string[]} the cells of a Markdown table row */
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * The first cell of every data row in a rationalization table (one whose
 * header's first cell is Excuse or Rationalization).
 * @param {string} text @returns {string[]}
 */
export function rationalizationCells(text) {
  const rows = [];
  let inTable = false;
  for (const line of linesOutsideFences(text.replace(/\r\n/g, "\n"))) {
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const first = cells(line)[0];
    if (!inTable && /^(excuses?|rationalizations?)$/i.test(first)) inTable = true;
    else if (inTable && !/^:?-+:?$/.test(first)) rows.push(first);
  }
  return rows;
}

/** @param {string} text @returns {string} whitespace runs collapsed to one space */
const collapse = (text) => text.replace(/\s+/g, " ");

/**
 * The fragments a rationalization cell claims were observed: every quoted
 * string, split at ` ... `, trailing `.,;:!?` trimmed. Empty when the cell
 * quotes nothing.
 * @param {string} cell @returns {string[]}
 */
export function quotedFragments(cell) {
  return [...cell.matchAll(/"([^"]*)"/g)].flatMap((m) =>
    m[1].split(" ... ").map((part) => collapse(part).trim().replace(/[.,;:!?]+$/, "").trim()),
  );
}

/**
 * Every rationalization row quotes only excuses observed in a RED or GREEN
 * run: each fragment appears verbatim in baseline.md or result.md.
 * @param {string} root @returns {string[]}
 */
export function checkRationalizations(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const observed = ["baseline.md", "result.md"].map((file) => collapse(readRecord(root, skill.name, file) ?? ""));
    for (const file of markdownUnder(skill.dir)) {
      const where = `skills/${skill.name}/${file.slice(skill.dir.length + 1)}`;
      for (const cell of rationalizationCells(readFileSync(file, "utf8"))) {
        const fragments = quotedFragments(cell);
        if (fragments.length === 0) violations.push(`${where}: rationalization row quotes nothing: ${cell}`);
        for (const fragment of fragments) {
          if (fragment === "" || !observed.some((text) => text.includes(fragment))) {
            violations.push(`${where}: "${fragment}" is not an observed quote in baseline.md or result.md`);
          }
        }
      }
    }
  }
  return violations;
}

test("every skill in this repository has its pressure-test record", () => {
  assert.deepEqual(checkSkillArtifacts(REPO), []);
});

test("a skill with a missing or empty artifact fails, one per file", () => {
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  mkdirSync(join(root, "skills", "mining-x"), { recursive: true });
  writeFileSync(join(root, "skills", "mining-x", "SKILL.md"), "---\nname: mining-x\n---\n");
  mkdirSync(join(root, "tests", "skills", "mining-x"), { recursive: true });
  writeFileSync(join(root, "tests", "skills", "mining-x", "scenario.md"), "Scenario.\n");
  writeFileSync(join(root, "tests", "skills", "mining-x", "baseline.md"), "  \n");
  assert.deepEqual(checkSkillArtifacts(root), [
    "tests/skills/mining-x/baseline.md: missing or empty",
    "tests/skills/mining-x/result.md: missing or empty",
  ]);
});

// Fixture plugin: one skill, `mining-x`, whose records pass every gate.
const SCENARIO = [
  "# Pressure scenario: mining-x",
  "",
  "## Prompt",
  "",
  "Do the thing.",
  "",
  "## Pass criteria",
  "",
  "1. Does the first thing.",
  "2. Does the second thing.",
  "",
  "## Run directory",
  "",
  "`lib/a.mjs` and `lib/b.mjs`, copied at their relative paths.",
  "",
].join("\n");
const SKILL_MD = [
  "---",
  "name: mining-x",
  "description: Use when testing.",
  "---",
  "",
  "| Excuse | Reality |",
  "|---|---|",
  '| "ship it tonight" | No. |',
  "",
].join("\n");
const BASELINE = 'Attempt 1: "I will ship it tonight." and "it is fine ... trust me".\n';

/** @param {Record<string, string>} [over] repo-relative path -> content @returns {string} the fixture root */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  const files = {
    "skills/mining-x/SKILL.md": SKILL_MD,
    "lib/a.mjs": 'import { b } from "./b.mjs";\nexport const a = b;\n',
    "lib/b.mjs": "export const b = 1;\n",
    "tests/skills/mining-x/scenario.md": SCENARIO,
    "tests/skills/mining-x/baseline.md": BASELINE,
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  if (!("tests/skills/mining-x/result.md" in over)) {
    const hash = shippedTextHash(join(root, "skills", "mining-x"));
    writeFileSync(
      join(root, "tests/skills/mining-x/result.md"),
      `# Result\n\nShipped-text SHA-256: ${hash}\nDiscriminating criteria: 1, 2\n\n\`\`\`\nShipped-text SHA-256: ${"0".repeat(64)}\n\`\`\`\n`,
    );
  }
  return root;
}

test("the fixture passes every records gate", () => {
  const root = fixture();
  assert.deepEqual(checkRecordHeaders(root), []);
  assert.deepEqual(checkRunDirectories(root), []);
  assert.deepEqual(checkRationalizations(root), []);
});

test("every result.md carries the current shipped-text hash", () => {
  assert.deepEqual(checkRecordHeaders(REPO), []);
});

test("a stale hash fails", () => {
  const root = fixture();
  writeFileSync(join(root, "skills/mining-x/SKILL.md"), `${SKILL_MD}One more line.\n`);
  assert.deepEqual(checkRecordHeaders(root), [
    "tests/skills/mining-x/result.md: Shipped-text SHA-256 is stale for skills/mining-x; rerun GREEN on the shipped text",
  ]);
});

test("a hash line inside a fence does not count, and two outside it fail", () => {
  const hash = shippedTextHash(join(fixture(), "skills", "mining-x"));
  const fenced = fixture({
    "tests/skills/mining-x/result.md": `\`\`\`\nShipped-text SHA-256: ${hash}\n\`\`\`\nDiscriminating criteria: 1\n`,
  });
  assert.deepEqual(checkRecordHeaders(fenced), [
    "tests/skills/mining-x/result.md: expected one Shipped-text SHA-256 line, found 0",
  ]);
  const twice = fixture({
    "tests/skills/mining-x/result.md": `Shipped-text SHA-256: ${hash}\nShipped-text SHA-256: ${hash}\nDiscriminating criteria: 1\n`,
  });
  assert.deepEqual(checkRecordHeaders(twice), [
    "tests/skills/mining-x/result.md: expected one Shipped-text SHA-256 line, found 2",
  ]);
});

test("every result.md names its discriminating criteria", () => {
  const hash = shippedTextHash(join(fixture(), "skills", "mining-x"));
  const result = (line) => fixture({ "tests/skills/mining-x/result.md": `Shipped-text SHA-256: ${hash}\n${line}` });
  assert.deepEqual(checkRecordHeaders(result("")), [
    "tests/skills/mining-x/result.md: expected one Discriminating criteria line, found 0",
  ]);
  assert.deepEqual(checkRecordHeaders(result("Discriminating criteria: none\n")), [
    'tests/skills/mining-x/result.md: Discriminating criteria must list criterion numbers, got "none"',
  ]);
  assert.deepEqual(checkRecordHeaders(result("Discriminating criteria: 2, 3\n")), [
    "tests/skills/mining-x/result.md: discriminating criterion 3 is not a pass criterion in scenario.md",
  ]);
  assert.deepEqual(checkRecordHeaders(result("Discriminating criteria: 2\n")), []);
});

test("every scenario lists its run directory", () => {
  assert.deepEqual(checkRunDirectories(REPO), []);
  const scenario = (body) => fixture({ "tests/skills/mining-x/scenario.md": SCENARIO.replace(/## Run directory[^]*$/, body) });
  assert.deepEqual(checkRunDirectories(scenario("## Other\n\nNone.\n")), [
    "tests/skills/mining-x/scenario.md: no ## Run directory section",
  ]);
  assert.deepEqual(checkRunDirectories(scenario("## Run directory\n\nNone.\n\n## Notes\n\n`missing.mjs`\n")), []);
  assert.deepEqual(checkRunDirectories(scenario("## Run directory\n\nNo files.\n")), [
    'tests/skills/mining-x/scenario.md: ## Run directory lists no backticked file and is not "None."',
  ]);
  assert.deepEqual(checkRunDirectories(scenario("## Run directory\n\n`lib/a.mjs`, `lib/b.mjs`, `lib/gone.mjs`, `lib`, `../x`\n")), [
    "tests/skills/mining-x/scenario.md: run directory file lib/gone.mjs is not a file in the repository",
    "tests/skills/mining-x/scenario.md: run directory file lib is not a file in the repository",
    "tests/skills/mining-x/scenario.md: run directory file ../x is not a file in the repository",
  ]);
});

test("a listed module's relative import must be listed", () => {
  const root = fixture({
    "tests/skills/mining-x/scenario.md": SCENARIO.replace("`lib/a.mjs` and `lib/b.mjs`", "`lib/a.mjs`"),
  });
  assert.deepEqual(checkRunDirectories(root), [
    "tests/skills/mining-x/scenario.md: lib/a.mjs imports lib/b.mjs, which the run directory does not list",
  ]);
});

test("relative imports are read from static, dynamic and side-effect forms, resolved against the module", () => {
  const source = [
    'import { x } from "./x.mjs";',
    "import y from '../y.mjs';",
    'const z = await import("./sub/z.mjs");',
    'import "./side.mjs";',
    'import { readFileSync } from "node:fs";',
    'export { w } from "./w.mjs";',
  ].join("\n");
  assert.deepEqual(relativeImports(source, "lib/a.mjs"), ["lib/side.mjs", "lib/sub/z.mjs", "lib/w.mjs", "lib/x.mjs", "y.mjs"]);
});

test("every rationalization row is an observed quote", () => {
  assert.deepEqual(checkRationalizations(REPO), []);
  const row = (cell, extra = {}) =>
    fixture({ "skills/mining-x/SKILL.md": SKILL_MD.replace('"ship it tonight"', cell), ...extra });
  // Found only in scenario.md: not observed.
  assert.deepEqual(checkRationalizations(row('"Do the thing."')), [
    'skills/mining-x/SKILL.md: "Do the thing" is not an observed quote in baseline.md or result.md',
  ]);
  // Found in baseline.md: observed.
  assert.deepEqual(checkRationalizations(row('"I will ship it tonight."')), []);
  // A ` ... ` split row with both fragments present.
  assert.deepEqual(checkRationalizations(row('"it is fine ... trust me"')), []);
  // A ` ... ` split row with one fragment missing.
  assert.deepEqual(checkRationalizations(row('"it is fine ... do not worry"')), [
    'skills/mining-x/SKILL.md: "do not worry" is not an observed quote in baseline.md or result.md',
  ]);
  // Several quoted strings in one cell: each is checked.
  assert.deepEqual(checkRationalizations(row('"ship it tonight", "trust me", "never said"')), [
    'skills/mining-x/SKILL.md: "never said" is not an observed quote in baseline.md or result.md',
  ]);
  // A row quoting nothing fails.
  assert.deepEqual(checkRationalizations(row("ship it tonight")), [
    "skills/mining-x/SKILL.md: rationalization row quotes nothing: ship it tonight",
  ]);
  // Observed in result.md, in a reference file, across a line break.
  const reference = "# Ref\n\n| Rationalization | Reality |\n|---|---|\n| \"wrapped quote\" | No. |\n";
  assert.deepEqual(
    checkRationalizations(
      row('"ship it tonight"', {
        "skills/mining-x/ref/deep.md": reference,
        "tests/skills/mining-x/result.md": 'Run 1: "wrapped\n  quote".\nShipped-text SHA-256: x\n',
      }),
    ),
    [],
  );
  // Case matters: verbatim means verbatim.
  assert.deepEqual(checkRationalizations(row('"Ship it tonight"')), [
    'skills/mining-x/SKILL.md: "Ship it tonight" is not an observed quote in baseline.md or result.md',
  ]);
});

test("tables that are not rationalization tables, and fenced tables, are not checked", () => {
  const text = [
    "| Exit | Meaning |",
    "|---|---|",
    '| 0 | "green" |',
    "",
    "```",
    "| Excuse | Reality |",
    "|---|---|",
    '| "fenced" | x |',
    "```",
    "",
    "| Excuse | Reality |",
    "| :--- | --- |",
    '| "real" | x |',
    "Not a row.",
    '| "after" | x |',
  ].join("\n");
  assert.deepEqual(rationalizationCells(text), ['"real"']);
  assert.deepEqual(quotedFragments('"a ... b.", "c!?"'), ["a", "b", "c"]);
});
