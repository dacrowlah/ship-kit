// `templates/callers/review.yml` (design 6.5) rendered against both
// fixtures: the trigger, permissions, pin comment, secrets and the boot
// variant's extra jobs, plus the stamp this file carries as a managed file
// and the `check-template-secrets` gate over the rendered output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main as checkTemplateSecrets } from "../../scripts/check-template-secrets.mjs";
import { readManagedFile } from "../../scripts/lib/stamp.mjs";
import { parseYaml } from "../helpers/yaml.mjs";
import { loadFixture, renderCaller } from "./render-caller.mjs";

const NO_BOOT = loadFixture(new URL("../fixtures/caller-values.json", import.meta.url));
const BOOT = loadFixture(new URL("../fixtures/caller-values-boot.json", import.meta.url));

function hasYq() {
  return spawnSync("yq", ["--version"], { encoding: "utf8" }).status === 0;
}

const REVIEW_PERMISSIONS = { contents: "read", "pull-requests": "write", issues: "read", actions: "read" };

test("both fixtures render to a document the YAML subset reader parses", () => {
  assert.ok(parseYaml(renderCaller(NO_BOOT)));
  assert.ok(parseYaml(renderCaller(BOOT)));
});

test("on: is only pull_request_target with the four types and the default branch", () => {
  const doc = parseYaml(renderCaller(NO_BOOT));
  assert.deepEqual(Object.keys(doc.on), ["pull_request_target"]);
  assert.deepEqual(doc.on.pull_request_target.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(doc.on.pull_request_target.branches, ["main"]);
});

test("a default branch with a slash renders into branches: unchanged", () => {
  const fixture = { ...NO_BOOT, default_branch: "release/1.x" };
  const doc = parseYaml(renderCaller(fixture));
  assert.deepEqual(doc.on.pull_request_target.branches, ["release/1.x"]);
});

test("top-level permissions is {}", () => {
  const doc = parseYaml(renderCaller(NO_BOOT));
  assert.deepEqual(doc.permissions, {});
});

test("review.permissions is exactly the four permissions of design 6.5", () => {
  const doc = parseYaml(renderCaller(NO_BOOT));
  assert.deepEqual(doc.jobs.review.permissions, REVIEW_PERMISSIONS);
});

test("review.uses pins ship-kit's review.yml by full commit SHA, and the raw line ends with the version tag comment", () => {
  const rendered = renderCaller(NO_BOOT);
  const doc = parseYaml(rendered);
  assert.equal(doc.jobs.review.uses, `dacrowlah/ship-kit/.github/workflows/review.yml@${NO_BOOT.ship_kit_sha}`);
  const usesLine = rendered.split("\n").find((line) => line.trim().startsWith("uses: dacrowlah/ship-kit/"));
  assert.equal(usesLine.trimEnd(), `    uses: dacrowlah/ship-kit/.github/workflows/review.yml@${NO_BOOT.ship_kit_sha} # ship-kit--v${NO_BOOT.ship_kit_version}`);
});

test("secrets names exactly one key and is never 'inherit' on the review job", () => {
  const doc = parseYaml(renderCaller(NO_BOOT));
  assert.deepEqual(Object.keys(doc.jobs.review.secrets), ["claude_code_oauth_token"]);
  assert.notEqual(doc.jobs.review.secrets, "inherit");

  const apiKeyDoc = parseYaml(renderCaller(BOOT));
  assert.deepEqual(Object.keys(apiKeyDoc.jobs.review.secrets), ["anthropic_api_key"]);
  assert.notEqual(apiKeyDoc.jobs.review.secrets, "inherit");
});

test("without a boot workflow: no boot job, review has no needs:, gate needs only review", () => {
  const doc = parseYaml(renderCaller(NO_BOOT));
  assert.deepEqual(Object.keys(doc.jobs), ["review", "gate"]);
  assert.equal(doc.jobs.review.needs, undefined);
  assert.deepEqual(doc.jobs.gate.needs, ["review"]);
});

test("with a boot workflow: boot job present, review needs: [boot], gate needs: [boot, review]", () => {
  const doc = parseYaml(renderCaller(BOOT));
  assert.deepEqual(Object.keys(doc.jobs), ["boot", "review", "gate"]);
  assert.deepEqual(doc.jobs.boot.uses, "./.github/workflows/boot.yml");
  assert.deepEqual(doc.jobs.boot.permissions, { contents: "read" });
  assert.equal(doc.jobs.boot.secrets, "inherit");
  assert.deepEqual(doc.jobs.review.needs, ["boot"]);
  assert.deepEqual(doc.jobs.gate.needs, ["boot", "review"]);
});

test("the stamp line is first and readManagedFile reads the rendered file as current (unmodified)", () => {
  for (const fixture of [NO_BOOT, BOOT]) {
    const rendered = renderCaller(fixture);
    assert.ok(rendered.startsWith("# ship-kit-managed: {"));
    const managed = readManagedFile(rendered);
    assert.ok(managed, "expected a managed-file stamp");
    assert.equal(managed.bodyMatches, true);
    assert.equal(managed.stamp.template, "callers/review.yml");
    assert.equal(managed.stamp.version, fixture.ship_kit_version);
    assert.equal(managed.stamp.sha, fixture.ship_kit_sha);
  }
});

test("a hand edit after rendering reads as modified (bodyMatches: false)", () => {
  const rendered = renderCaller(NO_BOOT);
  const tampered = rendered.replace("seat: general", "seat: tampered");
  const managed = readManagedFile(tampered);
  assert.equal(managed.bodyMatches, false);
});

test(
  "the rendered caller (placeholders filled in, real YAML) is cross-checked against yq",
  { skip: hasYq() ? false : "yq is not installed locally" },
  () => {
    if (!hasYq() && process.env.CI) assert.fail("yq is required in CI but is not installed");
    for (const fixture of [NO_BOOT, BOOT]) {
      const rendered = renderCaller(fixture);
      const dir = mkdtempSync(join(tmpdir(), "ship-kit-render-yq-"));
      try {
        const path = join(dir, "review.yml");
        writeFileSync(path, rendered);
        const yqResult = spawnSync("yq", ["-o=json", path], { encoding: "utf8" });
        assert.equal(yqResult.status, 0, `yq failed: ${yqResult.stderr}`);
        assert.deepEqual(parseYaml(rendered), JSON.parse(yqResult.stdout));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test("check-template-secrets exits 0 over a temporary copy holding the rendered callers under templates/", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-check-secrets-"));
  try {
    const callersDir = join(dir, "templates", "callers");
    mkdirSync(callersDir, { recursive: true });
    writeFileSync(join(callersDir, "review-no-boot.yml"), renderCaller(NO_BOOT));
    writeFileSync(join(callersDir, "review-boot.yml"), renderCaller(BOOT));
    const lines = [];
    const quiet = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
    const exitCode = checkTemplateSecrets(dir, quiet);
    assert.equal(exitCode, 0, lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
