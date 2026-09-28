import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findTemplateSecretViolations, main } from "./check-template-secrets.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./check-template-secrets.mjs", import.meta.url),
);

// --- Unit tests against findTemplateSecretViolations --------------------

test("passing fixture: secrets.X expression under with: produces no violations", () => {
  const content = [
    "jobs:",
    "  scan:",
    "    steps:",
    "      - uses: some/action@sha",
    "        with:",
    "          API_TOKEN: ${{ secrets.API_TOKEN }}",
    "          NAME: not-a-credential-key",
  ].join("\n");

  assert.deepEqual(findTemplateSecretViolations(content, "fixture.yml"), []);
});

test("passing fixture: inputs.X expression under env: produces no violations", () => {
  const content = [
    "env:",
    "  DEPLOY_KEY: ${{ inputs.DEPLOY_KEY }}",
    "  GH_PAT: ${{ secrets.GH_PAT }}",
  ].join("\n");

  assert.deepEqual(findTemplateSecretViolations(content, "fixture.yml"), []);
});

test("passing fixture: empty value under with: produces no violations", () => {
  const content = ["with:", '  API_TOKEN: ""', "  SECRET_KEY:"].join("\n");

  assert.deepEqual(findTemplateSecretViolations(content, "fixture.yml"), []);
});

test("passing fixture: non-credential key with a literal value is untouched", () => {
  const content = ["with:", "  NAME: my-template", "  VERSION: 1.2.3"].join(
    "\n",
  );

  assert.deepEqual(findTemplateSecretViolations(content, "fixture.yml"), []);
});

// --- Failing fixtures: one per credential-name keyword, each proven red -

const CREDENTIAL_KEYWORDS = [
  "TOKEN",
  "KEY",
  "SECRET",
  "PASSWORD",
  "PAT",
  "CREDENTIAL",
];

for (const keyword of CREDENTIAL_KEYWORDS) {
  test(`failing fixture: a literal value on an API_${keyword}-shaped key under with: is flagged`, () => {
    const content = ["with:", `  API_${keyword}: "literal-value-not-an-expression"`].join(
      "\n",
    );

    const violations = findTemplateSecretViolations(content, "fixture.yml");
    assert.equal(violations.length, 1);
    assert.match(violations[0], new RegExp(`API_${keyword}`));
  });
}

test("failing fixture: a literal value under env: is flagged", () => {
  const content = ["env:", "  DB_PASSWORD: hunter2"].join("\n");

  const violations = findTemplateSecretViolations(content, "fixture.yml");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /DB_PASSWORD/);
});

test("mutate-to-prove-red: a rule that would otherwise pass fails once the value is hardcoded", () => {
  const passing = ["with:", "  API_TOKEN: ${{ secrets.API_TOKEN }}"].join(
    "\n",
  );
  assert.deepEqual(findTemplateSecretViolations(passing, "fixture.yml"), []);

  // Mutate: swap the safe expression for a hardcoded-looking value.
  const mutated = ["with:", "  API_TOKEN: sk-ant-api03-not-a-real-key"].join(
    "\n",
  );
  const violations = findTemplateSecretViolations(mutated, "fixture.yml");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /API_TOKEN/);
});

test("a credential-shaped key outside a with:/env: block is not scanned", () => {
  const content = ["jobs:", "  scan:", "    API_TOKEN: literal-value"].join(
    "\n",
  );

  assert.deepEqual(findTemplateSecretViolations(content, "fixture.yml"), []);
});

test("a with: block ends when indentation returns to the block header's level", () => {
  const content = [
    "steps:",
    "  - with:",
    "      API_TOKEN: ${{ secrets.API_TOKEN }}",
    "  - run: echo hi",
    "    env:",
    "      OTHER_TOKEN: literal-value",
  ].join("\n");

  const violations = findTemplateSecretViolations(content, "fixture.yml");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /OTHER_TOKEN/);
});

// --- CLI-level (end-to-end) tests over real directories ------------------

// Runs main in this process so its coverage is measured here, in the one
// process that loads the module; see the spawned test below for why.
function runCli(cwd) {
  const stdout = [];
  const stderr = [];
  const status = main(cwd, {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  });
  return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

// The one test that runs the script as a command, to prove the entry point
// calls main and exits with its code. Its environment drops NODE_V8_COVERAGE
// so the child adds no coverage of its own: Node merges coverage from
// several processes in directory-listing order, and merging this module's
// coverage from two processes made its branch percentage vary run to run.
test("CLI: the command runs main and exits with its code", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-template-secrets-cmd-"));
  try {
    const { NODE_V8_COVERAGE, ...env } = process.env;
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to scan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exits 0 and skips scanning when no templates/workflows/.github/workflows dirs exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-template-secrets-none-"));
  try {
    const result = runCli(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /nothing to scan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exits 0 for a passing templates/ fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-template-secrets-pass-"));
  try {
    const templatesDir = join(dir, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      join(templatesDir, "caller.yml"),
      [
        "jobs:",
        "  call:",
        "    uses: dacrowlah/ship-kit/.github/workflows/example.yml@sha",
        "    with:",
        "      API_TOKEN: ${{ secrets.API_TOKEN }}",
        "    secrets:",
        "      inherit: true",
        "",
      ].join("\n"),
    );

    const result = runCli(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no hardcoded credentials found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exits 1 for a failing .github/workflows/ fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-template-secrets-fail-"));
  try {
    const workflowsDir = join(dir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, "bad.yml"),
      [
        "jobs:",
        "  deploy:",
        "    steps:",
        "      - uses: some/action@sha",
        "        with:",
        '          DEPLOY_TOKEN: "sk-live-hardcoded-value"',
        "",
      ].join("\n"),
    );

    const result = runCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEPLOY_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
