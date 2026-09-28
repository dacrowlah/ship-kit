import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills, parseFrontmatter } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// The command skills keep imperative names; every other skill is named in
// gerund form (CLAUDE.md, Skills).
export const COMMAND_SKILLS = ["setup", "develop", "ship", "ci-watch", "merge"];

/** @returns {string[]} violations */
export function checkSkillNames(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    if (skill.text === null) {
      violations.push(`skills/${skill.name}: no SKILL.md`);
      continue;
    }
    let fields;
    try {
      fields = parseFrontmatter(skill.text);
    } catch (error) {
      violations.push(`skills/${skill.name}: ${error.message}`);
      continue;
    }
    if (fields.name !== skill.name) {
      violations.push(`skills/${skill.name}: frontmatter name ${JSON.stringify(fields.name)} differs from its directory`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
      violations.push(`skills/${skill.name}: use lowercase letters, numbers and single hyphens only`);
    }
    const firstWord = skill.name.split("-")[0];
    if (!COMMAND_SKILLS.includes(skill.name) && !firstWord.endsWith("ing")) {
      violations.push(`skills/${skill.name}: not a command skill, so its name must start with a gerund`);
    }
  }
  return violations;
}

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), "naming-"));
  for (const [dir, text] of Object.entries(skills)) {
    mkdirSync(join(root, "skills", dir), { recursive: true });
    if (text !== null) writeFileSync(join(root, "skills", dir, "SKILL.md"), text);
  }
  return root;
}

const skillText = (name) => `---\nname: ${name}\ndescription: Use when testing.\n---\n\nBody.\n`;

test("every skill in this repository passes the naming gate", () => {
  assert.deepEqual(checkSkillNames(REPO), []);
});

test("a gerund-named skill and each command skill pass", () => {
  const skills = { "mining-defect-shapes": skillText("mining-defect-shapes") };
  for (const name of COMMAND_SKILLS) skills[name] = skillText(name);
  assert.deepEqual(checkSkillNames(fixture(skills)), []);
});

test("a non-gerund, non-command skill fails", () => {
  assert.equal(checkSkillNames(fixture({ "defect-miner": skillText("defect-miner") })).length, 1);
});

test("a name that only resembles a command skill fails", () => {
  assert.equal(checkSkillNames(fixture({ "ship-it": skillText("ship-it") })).length, 1);
});

test("a frontmatter name that differs from the directory fails", () => {
  assert.equal(checkSkillNames(fixture({ "mining-x": skillText("mining-y") })).length, 1);
});

test("uppercase or underscores fail the character rule", () => {
  for (const name of ["Mining-x", "mining_x-ing"]) {
    const violations = checkSkillNames(fixture({ [name]: skillText(name) }));
    assert.ok(violations.some((v) => v.includes("lowercase letters")), name);
  }
});

test("a skill directory with no SKILL.md fails", () => {
  assert.equal(checkSkillNames(fixture({ "mining-x": null })).length, 1);
});
