import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ARTIFACTS = ["scenario.md", "baseline.md", "result.md"];

/** Every skill carries its pressure-test record (design 21.5). @returns {string[]} */
export function checkSkillArtifacts(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    for (const file of ARTIFACTS) {
      const path = join(root, "tests", "skills", skill.name, file);
      if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
        violations.push(`tests/skills/${skill.name}/${file}: missing or empty`);
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
