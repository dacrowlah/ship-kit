import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readRunSpec, skillsWithRecords } from "../helpers/drift.mjs";
import { pinnedModel, shippedTextHash } from "../helpers/pressure.mjs";
import { fenceMap, isRepoFile, linesOutsideFences, section, sections } from "../helpers/records.mjs";
import { listSkills, parseFrontmatter } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ARTIFACTS = ["scenario.md", "baseline.md", "result.md"];
const HASH_LINE = /^Shipped-text SHA-256: (.*)$/;
const CRITERIA_LINE = /^Discriminating criteria: (.*)$/;
const MODEL_LINE = /^Model: (.*)$/;
const CODE_FILE = /\.(mjs|cjs|js)$/;
const RELATIVE_IMPORTS = [
  /\bfrom\s*(["'])(\.\.?\/[^"']+)\1/g,
  /\bimport\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g,
  /^\s*import\s*(["'])(\.\.?\/[^"']+)\1/gm,
  /\brequire\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g,
  /\bnew\s+URL\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
];
/** Header of the column holding the excuses in a rationalization table. */
const EXCUSE_HEADER = /excuse|rationali|thought/i;
/** The label of a fenced block that records a prompt rather than a run's output. */
const PROMPT_LABEL = /^(attempt \d+ )?prompt:$/i;
/** The furthest one piece of a ` ... ` quote may start after the previous piece ends. */
export const MAX_PIECE_GAP = 400;

/** @param {string} root @param {string} skill @param {string} file @returns {string | null} */
const readRecord = (root, skill, file) => {
  const path = join(root, "tests", "skills", skill, file);
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
};

/** @param {string} where @param {string} text @returns {string[]} a violation when a fence is never closed */
const unclosedFence = (where, text) => {
  const line = fenceMap(text).unclosed;
  return line === null ? [] : [`${where}: code fence opened at line ${line} is never closed`];
};

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
    const fence = unclosedFence(where, result);
    if (fence.length > 0) {
      violations.push(...fence);
      continue;
    }
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

/**
 * baseline.md and result.md each name, outside fenced blocks, exactly one
 * `Model: <id>` line, and `<id>` is the pinned model: `pressure.mjs check`
 * and `baseline` accept only runs under the pin and print that line.
 * @param {string} root @returns {string[]}
 */
export function checkModelLines(root) {
  const violations = [];
  const pinned = pinnedModel(root);
  for (const skill of listSkills(root)) {
    for (const file of ["baseline.md", "result.md"]) {
      const where = `tests/skills/${skill.name}/${file}`;
      const text = readRecord(root, skill.name, file);
      if (text === null) continue;
      const fence = unclosedFence(where, text);
      if (fence.length > 0) {
        violations.push(...fence);
        continue;
      }
      const models = linesOutsideFences(text).flatMap((line) => MODEL_LINE.exec(line)?.slice(1) ?? []);
      if (models.length !== 1) violations.push(`${where}: expected one Model line, found ${models.length}`);
      else if (models[0] !== pinned) violations.push(`${where}: Model ${models[0]} is not the pinned model ${pinned}`);
    }
  }
  return violations;
}

/** @param {string[]} lines a section's body @returns {string[]} every backticked span in it */
const backticked = (lines) => [...lines.join("\n").matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/**
 * Relative module and file specifiers of a module (static, dynamic and
 * side-effect imports, `require`, `new URL(<rel>, import.meta.url)`),
 * resolved against its directory.
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
 * scenario.md has one `## Run directory` section that says `None.` or lists
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
    const fence = unclosedFence(where, scenario);
    if (fence.length > 0) {
      violations.push(...fence);
      continue;
    }
    const found = sections(scenario, "Run directory");
    if (found.length !== 1) {
      violations.push(found.length === 0 ? `${where}: no ## Run directory section` : `${where}: more than one ## Run directory section`);
      continue;
    }
    const text = found[0].join("\n").trim();
    const listed = backticked(found[0]);
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

/**
 * Every skill with a record has the run spec the drift runner reads
 * (tests/helpers/drift.mjs, which refuses a malformed spec and any `to`
 * that leaves the run directory), and it agrees with scenario.md: its
 * `prompt` appears verbatim in `## Prompt`, its `from` paths are
 * exactly the backticked paths of `## Run directory`, and `dmi` is true
 * exactly when SKILL.md sets `disable-model-invocation: true`.
 * @param {string} root @returns {string[]}
 */
export function checkRunSpecs(root) {
  const violations = [];
  for (const skill of skillsWithRecords(root)) {
    const where = `tests/skills/${skill.name}/run.json`;
    let spec;
    try {
      spec = readRunSpec(root, skill.name);
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    const scenario = readRecord(root, skill.name, "scenario.md") ?? "";
    const prompt = section(scenario, "Prompt");
    if (prompt === null || !prompt.join("\n").includes(spec.prompt)) {
      violations.push(`${where}: prompt does not appear verbatim in scenario.md's ## Prompt section`);
    }
    const found = sections(scenario, "Run directory");
    const listed = new Set(found.length === 1 ? backticked(found[0]) : []);
    const copied = new Set(spec.files.map((file) => file.from));
    for (const path of listed) {
      if (!copied.has(path)) violations.push(`${where}: ${path} is in scenario.md's ## Run directory but no files entry copies it`);
    }
    for (const path of copied) {
      if (!listed.has(path)) violations.push(`${where}: files copies ${path}, which scenario.md's ## Run directory does not list`);
    }
    const dmi = skill.text !== null && parseFrontmatter(skill.text)["disable-model-invocation"] === "true";
    if (spec.dmi !== dmi) {
      violations.push(`${where}: dmi is ${spec.dmi} but SKILL.md ${dmi ? "sets" : "does not set"} disable-model-invocation: true`);
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

/** @param {string} line @returns {string[]} the cells of a Markdown table row, leading and trailing pipes optional */
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** @param {string} line @returns {boolean} a table delimiter row such as `|---|:--:|` or `--- | ---` */
const isDelimiterRow = (line) => line.includes("-") && cells(line).every((c) => /^:?-+:?$/.test(c));

/** @param {string} cell @returns {string} the header text without emphasis or code marks */
const plainHeader = (cell) => cell.replace(/[*_`]/g, "").trim();

/**
 * The excuse cell of every data row in a rationalization table: a table
 * (a header row with a pipe, then a delimiter row) whose header names an
 * excuse, rationalization or thought column. Fenced tables count, since
 * the model reads them too. A table runs until a blank line or a heading.
 * @param {string} text @returns {string[]}
 */
export function rationalizationCells(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rows = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].includes("|") || !isDelimiterRow(lines[i + 1])) continue;
    const column = cells(lines[i]).findIndex((c) => EXCUSE_HEADER.test(plainHeader(c)));
    if (column === -1) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j].trim() !== "" && !/^\s{0,3}#/.test(lines[j]) && !/^\s{0,3}(`{3,}|~{3,})/.test(lines[j]); j += 1) {
      rows.push(cells(lines[j])[column] ?? "");
    }
    i = j - 1;
  }
  return rows;
}

/** @param {string} text @returns {string} whitespace runs collapsed to one space */
const collapse = (text) => text.replace(/\s+/g, " ");

/**
 * The quotes a rationalization cell claims were observed: one entry per
 * quoted string, each split at ` ... ` into pieces with whitespace collapsed
 * and trailing `.,;:!?` trimmed. Empty when the cell quotes nothing.
 * @param {string} cell @returns {string[][]}
 */
export function quotedPieces(cell) {
  return [...cell.matchAll(/"([^"]*)"/g)].map((m) =>
    m[1].split(" ... ").map((part) => collapse(part).trim().replace(/[.,;:!?]+$/, "").trim()),
  );
}

/**
 * A record split into its attempts: the text between headings outside
 * fences, each with whitespace collapsed. A fenced block labelled as a
 * recorded prompt (its label, the last non-blank line outside a fence
 * before the opener, is `Prompt:` or `Attempt N prompt:`) is left out, so
 * prompt text is never read as something a run said.
 * @param {string} text @returns {string[]}
 */
export function attemptSections(text) {
  const out = [[]];
  let label = "";
  let dropped = -1;
  for (const line of fenceMap(text).lines) {
    if (line.fenced) {
      if (line.block !== dropped && PROMPT_LABEL.test(label)) dropped = line.block;
      if (line.block === dropped) continue;
    } else {
      if (/^ {0,3}#{1,6}(\s|$)/.test(line.text)) out.push([]);
      if (line.text.trim() !== "") label = line.text.trim();
    }
    out.at(-1).push(line.text);
  }
  return out.map((lines) => collapse(lines.join("\n")));
}

/**
 * True when the pieces occur in `text` in order, each starting at most
 * MAX_PIECE_GAP characters after the previous one ends.
 * @param {string} text @param {string[]} pieces @param {number} [from] @param {boolean} [first]
 */
export function piecesInOrder(text, pieces, from = 0, first = true) {
  if (pieces.length === 0) return true;
  const [piece, ...rest] = pieces;
  for (let at = text.indexOf(piece, from); at !== -1; at = text.indexOf(piece, at + 1)) {
    if (!first && at - from > MAX_PIECE_GAP) return false;
    if (piecesInOrder(text, rest, at + piece.length, false)) return true;
  }
  return false;
}

/**
 * Every rationalization row quotes only excuses observed in a RED or GREEN
 * run: no piece is prompt text (scenario.md's `## Prompt`, options
 * included, compared case-insensitively), and all the pieces of one quote
 * occur in order, close together, within one attempt of baseline.md or
 * result.md.
 * @param {string} root @returns {string[]}
 */
export function checkRationalizations(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const records = ["baseline.md", "result.md"].map((file) => [file, readRecord(root, skill.name, file) ?? ""]);
    const broken = records.flatMap(([file, text]) => unclosedFence(`tests/skills/${skill.name}/${file}`, text));
    if (broken.length > 0) {
      violations.push(...broken);
      continue;
    }
    const attempts = records.flatMap(([, text]) => attemptSections(text));
    const prompt = collapse((section(readRecord(root, skill.name, "scenario.md") ?? "", "Prompt") ?? []).join("\n")).toLowerCase();
    for (const file of markdownUnder(skill.dir)) {
      const where = `skills/${skill.name}/${file.slice(skill.dir.length + 1)}`;
      const text = readFileSync(file, "utf8");
      const rows = rationalizationCells(text);
      if (rows.length === 0 && linesOutsideFences(text).some((l) => /^#{1,6}\s.*rationali/i.test(l))) {
        violations.push(`${where}: the Rationalizations section has no table rows`);
      }
      for (const cell of rows) {
        const quotes = quotedPieces(cell);
        if (quotes.length === 0) violations.push(`${where}: rationalization row quotes nothing: ${cell}`);
        if (quotes.some((pieces) => pieces.includes(""))) {
          violations.push(`${where}: empty quoted string in rationalization row: ${cell}`);
          continue;
        }
        for (const pieces of quotes) {
          const fromPrompt = pieces.filter((piece) => prompt.includes(piece.toLowerCase()));
          for (const piece of fromPrompt) violations.push(`${where}: "${piece}" is prompt text in scenario.md, not an observed excuse`);
          if (fromPrompt.length > 0) continue;
          if (!attempts.some((attempt) => piecesInOrder(attempt, pieces))) {
            violations.push(`${where}: "${pieces.join(" ... ")}" is not an observed quote in baseline.md or result.md`);
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
const RUN_SPEC = `${JSON.stringify(
  {
    prompt: "Do the thing.",
    files: [
      { from: "lib/a.mjs", to: "lib/a.mjs" },
      { from: "lib/b.mjs", to: "lib/b.mjs" },
    ],
    dmi: false,
    jsonSchema: null,
  },
  null,
  2,
)}\n`;
const BASELINE = 'Model: claude-opus-5-5\n\nAttempt 1: "I will ship it tonight." and "it is fine ... trust me".\n';

/** @param {Record<string, string>} [over] repo-relative path -> content @returns {string} the fixture root */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  const files = {
    "skills/mining-x/SKILL.md": SKILL_MD,
    "lib/a.mjs": 'import { b } from "./b.mjs";\nexport const a = b;\n',
    "lib/b.mjs": "export const b = 1;\n",
    "tests/skills/mining-x/scenario.md": SCENARIO,
    "tests/skills/mining-x/baseline.md": BASELINE,
    "tests/skills/pinned-model.txt": "claude-opus-5-5\n",
    "tests/skills/mining-x/run.json": RUN_SPEC,
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
      `# Result\n\nShipped-text SHA-256: ${hash}\nModel: claude-opus-5-5\nDiscriminating criteria: 1, 2\n\n\`\`\`\nShipped-text SHA-256: ${"0".repeat(64)}\nModel: other-model\n\`\`\`\n`,
    );
  }
  return root;
}

test("the fixture passes every records gate", () => {
  const root = fixture();
  assert.deepEqual(checkRecordHeaders(root), []);
  assert.deepEqual(checkRunDirectories(root), []);
  assert.deepEqual(checkRationalizations(root), []);
  assert.deepEqual(checkModelLines(root), []);
  assert.deepEqual(checkRunSpecs(root), []);
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
  // Found only in scenario.md: prompt text, not observed.
  assert.deepEqual(checkRationalizations(row('"Do the thing."')), [
    'skills/mining-x/SKILL.md: "Do the thing" is prompt text in scenario.md, not an observed excuse',
  ]);
  // Found in baseline.md: observed.
  assert.deepEqual(checkRationalizations(row('"I will ship it tonight."')), []);
  // A ` ... ` split row with both fragments present.
  assert.deepEqual(checkRationalizations(row('"it is fine ... trust me"')), []);
  // A ` ... ` split row with one fragment missing.
  assert.deepEqual(checkRationalizations(row('"it is fine ... do not worry"')), [
    'skills/mining-x/SKILL.md: "it is fine ... do not worry" is not an observed quote in baseline.md or result.md',
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

test("tables that are not rationalization tables are not checked; fenced ones and unpiped rows are", () => {
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
  assert.deepEqual(rationalizationCells(text), ['"fenced"', '"real"', "Not a row.", '"after"']);
  assert.deepEqual(quotedPieces('"a ... b.", "c!?"'), [["a", "b"], ["c"]]);
});

test("a quote that is prompt text fails even when a record copies the prompt", () => {
  const prompt = SCENARIO.replace("Do the thing.", "Do the thing.\n\nA) Ship it tonight anyway.\nB) Wait.");
  const baseline = `${BASELINE}Prompt: Do the thing. A) Ship it tonight anyway.\n`;
  const row = (cell) =>
    fixture({
      "skills/mining-x/SKILL.md": SKILL_MD.replace('"ship it tonight"', cell),
      "tests/skills/mining-x/scenario.md": prompt,
      "tests/skills/mining-x/baseline.md": baseline,
    });
  assert.deepEqual(checkRationalizations(row('"Do the thing."')), [
    'skills/mining-x/SKILL.md: "Do the thing" is prompt text in scenario.md, not an observed excuse',
  ]);
  assert.deepEqual(checkRationalizations(row('"do THE   thing"')), [
    'skills/mining-x/SKILL.md: "do THE thing" is prompt text in scenario.md, not an observed excuse',
  ]);
  assert.deepEqual(checkRationalizations(row('"it is fine ... Ship it tonight anyway"')), [
    'skills/mining-x/SKILL.md: "Ship it tonight anyway" is prompt text in scenario.md, not an observed excuse',
  ]);
  assert.deepEqual(checkRationalizations(row('"I will ship it tonight"')), []);
});

test("the pieces of a split quote must appear in order, in one attempt of one record, close together", () => {
  const records = (baseline, result = "Shipped-text SHA-256: x\n") => ({
    "tests/skills/mining-x/baseline.md": baseline,
    "tests/skills/mining-x/result.md": result,
  });
  const row = (cell, extra) => fixture({ "skills/mining-x/SKILL.md": SKILL_MD.replace('"ship it tonight"', cell), ...extra });
  const attempts = "## Attempt 1\n\nI'd accept that the table covers it.\n\n## Attempt 3\n\nskip it and ship as-is.\n";
  assert.deepEqual(checkRationalizations(row('"I\'d accept that ... skip it and ship as-is"', records(attempts))), [
    `skills/mining-x/SKILL.md: "I'd accept that ... skip it and ship as-is" is not an observed quote in baseline.md or result.md`,
  ]);
  assert.deepEqual(
    checkRationalizations(row('"alpha said ... beta said"', records("## A\n\nalpha said\n", "## A\n\nbeta said\n"))),
    ['skills/mining-x/SKILL.md: "alpha said ... beta said" is not an observed quote in baseline.md or result.md'],
  );
  assert.deepEqual(checkRationalizations(row('"beta said ... alpha said"', records("alpha said, then beta said\n"))), [
    'skills/mining-x/SKILL.md: "beta said ... alpha said" is not an observed quote in baseline.md or result.md',
  ]);
  const far = `alpha said ${"x".repeat(401)} beta said\n`;
  assert.deepEqual(checkRationalizations(row('"alpha said ... beta said"', records(far))), [
    'skills/mining-x/SKILL.md: "alpha said ... beta said" is not an observed quote in baseline.md or result.md',
  ]);
  const near = `alpha said ${"x".repeat(398)} beta said\n`;
  assert.deepEqual(checkRationalizations(row('"alpha said ... beta said"', records(near))), []);
  // A later occurrence of the first piece can start the match.
  assert.deepEqual(checkRationalizations(row('"alpha said ... beta said"', records(`alpha said ${"x".repeat(500)} alpha said, beta said\n`))), []);
  // A heading inside a fenced block does not split an attempt.
  assert.deepEqual(checkRationalizations(row('"alpha said ... beta said"', records("```\nalpha said\n## Inner\nbeta said\n```\n"))), []);
  // A single quote that crosses an attempt heading is not observed either.
  assert.deepEqual(checkRationalizations(row('"alpha said beta said"', records("alpha said\n## B\nbeta said\n"))), [
    'skills/mining-x/SKILL.md: "alpha said beta said" is not an observed quote in baseline.md or result.md',
  ]);
});

test("an empty quoted string or piece fails", () => {
  const row = (cell) => fixture({ "skills/mining-x/SKILL.md": SKILL_MD.replace('"ship it tonight"', cell) });
  assert.deepEqual(checkRationalizations(row('"", "ship it tonight"')), [
    'skills/mining-x/SKILL.md: empty quoted string in rationalization row: "", "ship it tonight"',
  ]);
  assert.deepEqual(checkRationalizations(row('" ... trust me"')), [
    'skills/mining-x/SKILL.md: empty quoted string in rationalization row: " ... trust me"',
  ]);
});

test("rationalization tables are found by any excuse-column header, with or without pipes, fenced or not", () => {
  const table = (header, sep = "|---|---|", row = '| "never said" | No. |') =>
    fixture({ "skills/mining-x/SKILL.md": SKILL_MD.replace("| Excuse | Reality |\n|---|---|\n| \"ship it tonight\" | No. |", `${header}\n${sep}\n${row}`) });
  const unobserved = ['skills/mining-x/SKILL.md: "never said" is not an observed quote in baseline.md or result.md'];
  assert.deepEqual(checkRationalizations(table("| **Excuse** | Reality |")), unobserved);
  assert.deepEqual(checkRationalizations(table("| _Rationalization_ | Reality |")), unobserved);
  assert.deepEqual(checkRationalizations(table("| Thought | Reality |")), unobserved);
  assert.deepEqual(checkRationalizations(table("| Excuse (heard) | Reality |")), unobserved);
  assert.deepEqual(checkRationalizations(table("| Reality | Excuse |", "|---|---|", '| No. | "never said" |')), unobserved);
  assert.deepEqual(checkRationalizations(table("Excuse | Reality", "--- | ---", '"never said" | No.')), unobserved);
  const fenced = fixture({
    "skills/mining-x/SKILL.md": `${SKILL_MD}\n\`\`\`\n| Excuse | Reality |\n|---|---|\n| "never said" | No. |\n\`\`\`\n`,
  });
  assert.deepEqual(checkRationalizations(fenced), unobserved);
  // A row that is not piped still belongs to the table until a blank line or heading.
  assert.deepEqual(checkRationalizations(table("| Excuse | Reality |", "|---|---|", '| "ship it tonight" | No. |\nnever quoted')), [
    "skills/mining-x/SKILL.md: rationalization row quotes nothing: never quoted",
  ]);
  const empty = fixture({ "skills/mining-x/SKILL.md": "---\nname: mining-x\ndescription: Use when testing.\n---\n\n## Rationalizations\n\nNone yet.\n" });
  assert.deepEqual(checkRationalizations(empty), [
    "skills/mining-x/SKILL.md: the Rationalizations section has no table rows",
  ]);
});

test("an unclosed code fence in a record fails instead of hiding what follows", () => {
  const hash = shippedTextHash(join(fixture(), "skills", "mining-x"));
  const result = fixture({
    "tests/skills/mining-x/result.md": `Shipped-text SHA-256: ${hash}\nDiscriminating criteria: 1\n\n\`\`\`text\nopen\n`,
  });
  assert.deepEqual(checkRecordHeaders(result), ["tests/skills/mining-x/result.md: code fence opened at line 4 is never closed"]);
  const scenario = fixture({ "tests/skills/mining-x/scenario.md": `${SCENARIO}\n~~~~\n## Run directory\n\n\`gone.mjs\`\n` });
  assert.deepEqual(checkRunDirectories(scenario), [`tests/skills/mining-x/scenario.md: code fence opened at line ${SCENARIO.split("\n").length + 1} is never closed`]);
  const baseline = fixture({ "tests/skills/mining-x/baseline.md": `${BASELINE}\`\`\`\n` });
  assert.deepEqual(checkRationalizations(baseline), ["tests/skills/mining-x/baseline.md: code fence opened at line 4 is never closed"]);
  // An info string holding a backtick does not open a fence; a shorter closer does not close one.
  assert.deepEqual(fenceMap("```not-closed`\ntext").unclosed, null);
  assert.deepEqual(fenceMap("````\n```\n````\nafter").lines.map((l) => l.fenced), [true, true, true, false]);
});

test("a second Run directory section fails", () => {
  const root = fixture({ "tests/skills/mining-x/scenario.md": `${SCENARIO}\n## Run directory\n\n\`lib/gone.mjs\`\n` });
  assert.deepEqual(checkRunDirectories(root), ["tests/skills/mining-x/scenario.md: more than one ## Run directory section"]);
});

test("require() and new URL(..., import.meta.url) count as relative imports", () => {
  const source = ['const x = require("./x.cjs");', "const f = new URL('../fixtures/f.json', import.meta.url);", 'const g = new URL("./g.txt",import.meta.url);'].join("\n");
  assert.deepEqual(relativeImports(source, "lib/a.mjs"), ["fixtures/f.json", "lib/g.txt", "lib/x.cjs"]);
});

test("a quote from an earlier attempt's recorded prompt is not observed", () => {
  const earlier = [
    'The tech lead, who owns the release, says: "Ship it, and don\'t touch glob.mjs again tonight."',
    "D) Delete the test: the fix is obvious and the rest of the suite is green.",
  ].join("\n");
  const baseline = (label) =>
    `# Baseline\n\n## Attempt 1\n\n${label}\n\n\`\`\`text\n${earlier}\n\`\`\`\n\nOutput (\`red-1.txt\`):\n\n\`\`\`text\nI pick C.\n\`\`\`\n`;
  const row = (cell, label) =>
    fixture({
      "skills/mining-x/SKILL.md": SKILL_MD.replace('"ship it tonight"', cell),
      "tests/skills/mining-x/baseline.md": baseline(label),
    });
  const cell = '"Ship it, and don\'t touch glob.mjs again tonight", "the rest of the suite is green", "The tech lead, who owns the release"';
  const refused = [
    `skills/mining-x/SKILL.md: "Ship it, and don't touch glob.mjs again tonight" is not an observed quote in baseline.md or result.md`,
    'skills/mining-x/SKILL.md: "the rest of the suite is green" is not an observed quote in baseline.md or result.md',
    'skills/mining-x/SKILL.md: "The tech lead, who owns the release" is not an observed quote in baseline.md or result.md',
  ];
  assert.deepEqual(checkRationalizations(row(cell, "Prompt:")), refused);
  assert.deepEqual(checkRationalizations(row(cell, "Attempt 2 prompt:")), refused);
  // The same text under any other label is recorded output and counts.
  assert.deepEqual(checkRationalizations(row(cell, "Output (`red-0.txt`):")), []);
  // Output after the prompt fence still counts.
  assert.deepEqual(checkRationalizations(row('"I pick C"', "Prompt:")), []);
  assert.deepEqual(attemptSections("Prompt:\n\n~~~\nsecret\n~~~\nafter\n"), ["Prompt: after "]);
});

test("every record names the pinned model", () => {
  assert.deepEqual(checkModelLines(REPO), []);
});

test("a record with no model line fails", () => {
  const root = fixture({ "tests/skills/mining-x/baseline.md": BASELINE.replace("Model: claude-opus-5-5\n", "") });
  assert.deepEqual(checkModelLines(root), ["tests/skills/mining-x/baseline.md: expected one Model line, found 0"]);
});

test("a record under a model other than the pin fails", () => {
  const hash = shippedTextHash(join(fixture(), "skills", "mining-x"));
  const root = fixture({ "tests/skills/mining-x/result.md": `Shipped-text SHA-256: ${hash}\nModel: other-model\nDiscriminating criteria: 1\n` });
  assert.deepEqual(checkModelLines(root), ["tests/skills/mining-x/result.md: Model other-model is not the pinned model claude-opus-5-5"]);
  const moved = fixture({ "tests/skills/pinned-model.txt": "other-model\n" });
  assert.deepEqual(checkModelLines(moved), [
    "tests/skills/mining-x/baseline.md: Model claude-opus-5-5 is not the pinned model other-model",
    "tests/skills/mining-x/result.md: Model claude-opus-5-5 is not the pinned model other-model",
  ]);
});

test("a model line inside a fence does not count", () => {
  const fenced = fixture({ "tests/skills/mining-x/baseline.md": BASELINE.replace("Model: claude-opus-5-5\n", "```\nModel: claude-opus-5-5\n```\n") });
  assert.deepEqual(checkModelLines(fenced), ["tests/skills/mining-x/baseline.md: expected one Model line, found 0"]);
  const twice = fixture({ "tests/skills/mining-x/baseline.md": `Model: claude-opus-5-5\n${BASELINE}` });
  assert.deepEqual(checkModelLines(twice), ["tests/skills/mining-x/baseline.md: expected one Model line, found 2"]);
  const unclosed = fixture({ "tests/skills/mining-x/baseline.md": `${BASELINE}\`\`\`\nModel: x\n` });
  assert.deepEqual(checkModelLines(unclosed), ["tests/skills/mining-x/baseline.md: code fence opened at line 4 is never closed"]);
  assert.throws(() => checkModelLines(fixture({ "tests/skills/pinned-model.txt": "a b\n" })), /pinned-model\.txt/);
});

test("every skill with a record has a consistent run spec", () => {
  assert.deepEqual(checkRunSpecs(REPO), []);
});

/** The fixture with its run spec edited by `edit`. @returns {string} root */
const withSpec = (edit) => fixture({ "tests/skills/mining-x/run.json": JSON.stringify(edit(JSON.parse(RUN_SPEC))) });

test("a skill with a record and no run spec fails", () => {
  const root = fixture();
  rmSync(join(root, "tests/skills/mining-x/run.json"));
  assert.deepEqual(checkRunSpecs(root), ["tests/skills/mining-x/run.json is missing"]);
  const unrecorded = fixture();
  rmSync(join(unrecorded, "tests/skills/mining-x/run.json"));
  rmSync(join(unrecorded, "tests/skills/mining-x/result.md"));
  assert.deepEqual(checkRunSpecs(unrecorded), [], "a skill with no record needs no run spec");
});

test("a run spec copying a file its Run directory does not list fails", () => {
  const root = withSpec((spec) => ({ ...spec, files: [...spec.files, { from: "skills/mining-x/SKILL.md", to: "SKILL.md" }] }));
  assert.deepEqual(checkRunSpecs(root), [
    "tests/skills/mining-x/run.json: files copies skills/mining-x/SKILL.md, which scenario.md's ## Run directory does not list",
  ]);
});

test("a Run directory path that no run spec entry copies fails", () => {
  const root = withSpec((spec) => ({ ...spec, files: spec.files.slice(0, 1) }));
  assert.deepEqual(checkRunSpecs(root), [
    "tests/skills/mining-x/run.json: lib/b.mjs is in scenario.md's ## Run directory but no files entry copies it",
  ]);
  const none = fixture({
    "tests/skills/mining-x/scenario.md": SCENARIO.replace(/## Run directory[^]*$/, "## Run directory\n\nNone.\n"),
  });
  assert.deepEqual(checkRunSpecs(none), [
    "tests/skills/mining-x/run.json: files copies lib/a.mjs, which scenario.md's ## Run directory does not list",
    "tests/skills/mining-x/run.json: files copies lib/b.mjs, which scenario.md's ## Run directory does not list",
  ]);
});

test("a run spec whose to leaves the run directory fails", () => {
  for (const to of ["../lib/a.mjs", "lib/../../a.mjs", "/tmp/a.mjs", "./lib/a.mjs", "lib//a.mjs", ""]) {
    const root = withSpec((spec) => ({ ...spec, files: [{ from: "lib/a.mjs", to }, spec.files[1]] }));
    const violations = checkRunSpecs(root);
    assert.equal(violations.length, 1, `${JSON.stringify(to)}: ${violations}`);
    assert.match(violations[0], /^tests\/skills\/mining-x\/run\.json: /);
    assert.match(violations[0], /relative path/);
  }
});

test("a run spec whose prompt is not the scenario's prompt, or whose dmi disagrees with SKILL.md, fails", () => {
  assert.deepEqual(checkRunSpecs(withSpec((spec) => ({ ...spec, prompt: "Do another thing." }))), [
    "tests/skills/mining-x/run.json: prompt does not appear verbatim in scenario.md's ## Prompt section",
  ]);
  assert.deepEqual(checkRunSpecs(withSpec((spec) => ({ ...spec, prompt: "Pass criteria" }))), [
    "tests/skills/mining-x/run.json: prompt does not appear verbatim in scenario.md's ## Prompt section",
  ]);
  assert.deepEqual(checkRunSpecs(withSpec((spec) => ({ ...spec, dmi: true }))), [
    "tests/skills/mining-x/run.json: dmi is true but SKILL.md does not set disable-model-invocation: true",
  ]);
  const dmiSkill = fixture({
    "skills/mining-x/SKILL.md": SKILL_MD.replace("description: Use when testing.", "description: Use when testing.\ndisable-model-invocation: true"),
  });
  assert.deepEqual(checkRunSpecs(dmiSkill), [
    "tests/skills/mining-x/run.json: dmi is false but SKILL.md sets disable-model-invocation: true",
  ]);
});
