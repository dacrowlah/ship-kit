// Reads the plugin's skills for the repository gates. Frontmatter is a
// deliberately small subset of YAML: `key: value` lines with single-line
// scalar values, optionally quoted. Anything else throws, so a skill that
// uses a construct the gates cannot read fails loudly instead of passing.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @param {string} text @returns {Record<string, string>} */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md must start with a --- frontmatter line");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("frontmatter has no closing --- line");
  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const match = line.match(/^([a-z][a-z0-9_-]*):[ ]+(.+)$/);
    if (!match) throw new Error(`unsupported frontmatter line: ${JSON.stringify(line)}`);
    let value = match[2].trim();
    if (/^[>|]/.test(value)) throw new Error(`multi-line value for ${match[1]} is not supported`);
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (match[1] in fields) throw new Error(`duplicate frontmatter key: ${match[1]}`);
    fields[match[1]] = value;
  }
  return fields;
}

/**
 * @param {string} root plugin root
 * @returns {{name: string, dir: string, files: string[], text: string}[]}
 */
export function listSkills(root) {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(skillsDir, name);
      const skillFile = join(dir, "SKILL.md");
      return {
        name,
        dir,
        files: readdirSync(dir).sort(),
        text: existsSync(skillFile) ? readFileSync(skillFile, "utf8") : null,
      };
    });
}
