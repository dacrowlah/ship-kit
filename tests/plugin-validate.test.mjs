import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// The maintainer manual at the repository root is the plugin root's
// CLAUDE.md by design; the validator warns that it is not loaded for
// consumers. That one warning is expected; any other warning or error fails.
export function isExpectedWarning(file, warning) {
  return file.endsWith("/CLAUDE.md") && warning.path === "root" && /CLAUDE\.md at the plugin root/.test(warning.message);
}

/** @returns {string[]} */
export function unexpectedFindings(report) {
  const findings = [];
  for (const entry of [report.manifest, ...(report.contents ?? [])].filter(Boolean)) {
    for (const error of entry.errors ?? []) findings.push(`${entry.file}: error: ${error.message}`);
    for (const warning of entry.warnings ?? []) {
      if (!isExpectedWarning(entry.file, warning)) findings.push(`${entry.file}: warning: ${warning.message}`);
    }
  }
  return findings;
}

test("unexpectedFindings allows only the root CLAUDE.md warning", () => {
  const rootWarning = { path: "root", message: "CLAUDE.md at the plugin root is not loaded as project context." };
  const report = {
    manifest: { file: "/r/.claude-plugin/plugin.json", errors: [], warnings: [] },
    contents: [
      { file: "/r/CLAUDE.md", errors: [], warnings: [rootWarning] },
      { file: "/r/skills/x/SKILL.md", errors: [], warnings: [{ path: "description", message: "No description" }] },
      { file: "/r/skills/y/CLAUDE.md", errors: [{ message: "bad" }], warnings: [] },
    ],
  };
  assert.deepEqual(unexpectedFindings(report), [
    "/r/skills/x/SKILL.md: warning: No description",
    "/r/skills/y/CLAUDE.md: error: bad",
  ]);
});

test("the marketplace passes claude plugin validate --strict", () => {
  const r = spawnSync("claude", ["plugin", "validate", "--strict", "."], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the plugin validates with no findings beyond the root CLAUDE.md warning", () => {
  const r = spawnSync("claude", ["plugin", "validate", "--json", ".claude-plugin/plugin.json"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(unexpectedFindings(JSON.parse(r.stdout)), []);
});
