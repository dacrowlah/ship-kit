import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills, parseFrontmatter } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MAX_LINES = 500;
const MAX_LISTING_CHARS = 1536;

/** @returns {string[]} violations */
export function checkSkillShape(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const where = `skills/${skill.name}`;
    if (skill.text === null) continue; // reported by the naming gate
    const lineCount = skill.text.split("\n").length - (skill.text.endsWith("\n") ? 1 : 0);
    if (lineCount >= MAX_LINES) violations.push(`${where}: SKILL.md has ${lineCount} lines (limit: under ${MAX_LINES})`);
    let fields;
    try {
      fields = parseFrontmatter(skill.text);
    } catch (error) {
      violations.push(`${where}: ${error.message}`);
      continue;
    }
    const description = fields.description ?? "";
    if (!description.startsWith("Use when ")) {
      violations.push(`${where}: description must state triggering conditions, starting "Use when "`);
    }
    if (fields["disable-model-invocation"] !== "true") {
      const listing = description.length + (fields.when_to_use ?? "").length;
      if (listing >= MAX_LISTING_CHARS) {
        violations.push(`${where}: description plus when_to_use is ${listing} characters (limit: under ${MAX_LISTING_CHARS})`);
      }
    }
    for (const file of skill.files) {
      if (file === "SKILL.md") continue;
      if (!file.endsWith(".md")) {
        violations.push(`${where}/${file}: a skill directory holds only SKILL.md and .md reference files`);
      } else if (!skill.text.includes(file)) {
        violations.push(`${where}/${file}: not referenced from SKILL.md (references are one level deep)`);
      }
    }
  }
  return violations;
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "size-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, "skills", path);
    mkdirSync(join(full, ".."), { recursive: true });
    if (text === "<dir>") mkdirSync(full, { recursive: true });
    else writeFileSync(full, text);
  }
  return root;
}

const skill = (description, body = "Body.\n", extra = "") =>
  `---\nname: mining-x\ndescription: ${description}\n${extra}---\n\n${body}`;

test("every skill in this repository passes the size and description gate", () => {
  assert.deepEqual(checkSkillShape(REPO), []);
});

test("a well-formed skill with a referenced sibling passes", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill("Use when testing.", "See format.md.\n"),
    "mining-x/format.md": "Format.\n",
  });
  assert.deepEqual(checkSkillShape(root), []);
});

test("a SKILL.md of 500 lines fails and one of 499 passes", () => {
  const header = skill("Use when testing.", "");
  const headerLines = header.split("\n").length - 1;
  const body = (n) => "x\n".repeat(n - headerLines);
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": header + body(500) })).length, 1);
  assert.deepEqual(checkSkillShape(fixture({ "mining-x/SKILL.md": header + body(499) })), []);
});

test("a description that summarizes steps instead of triggers fails", () => {
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": skill("Collects evidence, then clusters it.") })).length, 1);
});

test("a model-invocable description at 1,536 characters fails; 1,535 passes", () => {
  const text = (n) => `Use when ${"x".repeat(n - 9)}`;
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": skill(text(1536)) })).length, 1);
  assert.deepEqual(checkSkillShape(fixture({ "mining-x/SKILL.md": skill(text(1535)) })), []);
});

test("when_to_use counts toward the listing cap", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill(`Use when ${"x".repeat(1000)}`, "Body.\n", `when_to_use: ${"y".repeat(600)}\n`),
  });
  assert.equal(checkSkillShape(root).length, 1);
});

test("a disable-model-invocation skill is exempt from the listing cap", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill(`Use when ${"x".repeat(2000)}`, "Body.\n", "disable-model-invocation: true\n"),
  });
  assert.deepEqual(checkSkillShape(root), []);
});

test("a multi-line description fails loudly", () => {
  const root = fixture({ "mining-x/SKILL.md": "---\nname: mining-x\ndescription: >\n  Use when x.\n---\n" });
  assert.equal(checkSkillShape(root).length, 1);
});

test("an unreferenced sibling, a non-md sibling and a nested directory fail", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill("Use when testing."),
    "mining-x/orphan.md": "x\n",
    "mining-x/run.sh": "x\n",
    "mining-x/nested": "<dir>",
  });
  assert.equal(checkSkillShape(root).length, 3);
});
