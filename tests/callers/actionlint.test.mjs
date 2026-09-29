// Lints both rendered callers with a real `actionlint` (1.7.12): writes them
// into a temporary `.github/workflows/`, plus a stub `boot.yml` beside them
// (actionlint fails a local `uses: ./.github/workflows/boot.yml` whose file
// is absent), and runs `actionlint` there. When `actionlint` is not
// installed, the check is required in `CI` (fails closed there) and skipped
// elsewhere, since a contributor's machine may not have it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { loadFixture, renderCaller } from "./render-caller.mjs";

const NO_BOOT = loadFixture(new URL("../fixtures/caller-values.json", import.meta.url));
const BOOT = loadFixture(new URL("../fixtures/caller-values-boot.json", import.meta.url));

const BOOT_STUB = `name: boot
on: workflow_call
jobs:
  boot:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`;

function actionlintAvailable() {
  const result = spawnSync("actionlint", ["--version"], { env: isolatedEnv(), encoding: "utf8" });
  return result.status === 0;
}

const AVAILABLE = actionlintAvailable();
const skip = !AVAILABLE && !process.env.CI;

test("actionlint accepts both rendered callers", { skip: skip ? "actionlint is not installed" : false }, () => {
  if (!AVAILABLE && process.env.CI) {
    assert.fail("actionlint is required in CI but is not installed");
  }

  const dir = mkdtempSync(join(tmpdir(), "ship-kit-actionlint-"));
  try {
    // actionlint requires its target to sit inside a git repository.
    spawnSync("git", ["init", "-q"], { cwd: dir, env: isolatedEnv() });
    const workflowsDir = join(dir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "ship-kit-general.yml"), renderCaller(NO_BOOT));
    writeFileSync(join(workflowsDir, "ship-kit-adversarial.yml"), renderCaller(BOOT));
    writeFileSync(join(workflowsDir, "boot.yml"), BOOT_STUB);

    const result = spawnSync("actionlint", [], { cwd: dir, env: isolatedEnv(), encoding: "utf8" });
    assert.equal(result.status, 0, `actionlint findings:\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
