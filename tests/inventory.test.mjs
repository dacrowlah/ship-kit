import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills } from "./helpers/skills.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CATEGORIES = ["Skills", "Agents", "Hooks", "MCP servers", "LSP servers"];

/**
 * Parses the "Component inventory" block of `claude plugin details`.
 * @returns {Map<string, {count: number, names: string[]}>}
 */
export function parseInventory(output) {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Component inventory");
  if (start === -1) throw new Error("no Component inventory block in plugin details output");
  const inventory = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = line.match(/^\s+(.+?) \((\d+)\)(?:\s+(.+))?$/);
    if (!match) throw new Error(`unrecognised inventory line: ${JSON.stringify(line)}`);
    const names = match[3] ? match[3].split(", ").map((n) => n.trim()) : [];
    inventory.set(match[1], { count: Number(match[2]), names });
  }
  return inventory;
}

test("parseInventory reads counts and names and refuses an unknown shape", () => {
  const sample = "x\nComponent inventory\n  Skills (2)  a-skill, b-skill\n  Hooks (0)\n\nrest\n";
  assert.deepEqual([...parseInventory(sample)], [
    ["Skills", { count: 2, names: ["a-skill", "b-skill"] }],
    ["Hooks", { count: 0, names: [] }],
  ]);
  assert.throws(() => parseInventory("no block"), /no Component inventory/);
  assert.throws(() => parseInventory("Component inventory\n  Skills: 2\n"), /unrecognised/);
});

test("the plugin loads exactly the expected components and no bin/", () => {
  assert.equal(existsSync(join(REPO, "bin")), false, "a top-level bin/ must not exist");
  const output = execFileSync("claude", ["--plugin-dir", REPO, "plugin", "details", "ship-kit"], {
    cwd: REPO,
    encoding: "utf8",
  });
  const inventory = parseInventory(output);
  assert.deepEqual([...inventory.keys()], CATEGORIES);
  const skills = inventory.get("Skills");
  const expectedSkills = listSkills(REPO).map((s) => s.name);
  assert.deepEqual([...skills.names].sort(), expectedSkills);
  assert.equal(skills.count, expectedSkills.length);
  const expected = readFileSync(join(REPO, "tests", "expected-inventory.txt"), "utf8").trim().split("\n");
  const actual = CATEGORIES.filter((c) => c !== "Skills").map((c) => `${c} ${inventory.get(c).count}`);
  assert.deepEqual(actual, expected);
});
