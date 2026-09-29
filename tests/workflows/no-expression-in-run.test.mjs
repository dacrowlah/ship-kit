// The gate for design 6.3's "Expressions never reach a shell": no `run:`
// (or `actions/github-script` `script:`) body anywhere in the repository
// may contain `${{`, because a value substituted through an expression
// there is interpreted text, and an expression can carry attacker-controlled
// content (a PR title, a branch name, a comment body). This file is the
// gate itself: `node --test` over the repository fails it whenever a
// tracked workflow or template regresses.

import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import { runBodies, scriptBodies } from "../helpers/run-bodies.mjs";

const EXPRESSION = "${{";

/**
 * @param {{ line: number, text: string }[]} bodies
 * @returns {{ line: number, text: string }[]} the entries containing an expression
 */
function withExpression(bodies) {
  return bodies.filter((body) => body.text.includes(EXPRESSION));
}

test("an inline run: body with an expression is caught", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - run: echo ${{ x }}"].join("\n");
  assert.equal(withExpression(runBodies(text)).length, 1);
});

test("a block run: | body with the expression on its third line is caught", () => {
  const text = [
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: |",
    "          echo one",
    "          echo two",
    "          echo ${{ x }}",
  ].join("\n");
  const hits = withExpression(runBodies(text));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text.trim(), "echo ${{ x }}");
});

test("a block run: | body with a blank line before the expression is still caught", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - run: |", "          echo one", "", "          echo ${{ x }}"].join("\n");
  const hits = withExpression(runBodies(text));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text.trim(), "echo ${{ x }}");
});

test("a `- run:` item form with an expression is caught", () => {
  const text = ["steps:", "  - run: echo ${{ x }}"].join("\n");
  assert.equal(withExpression(runBodies(text)).length, 1);
});

test("an expression in env: is not a run body and is allowed", () => {
  const text = ["jobs:", "  x:", "    env:", "      X: ${{ github.event.pull_request.title }}", "    steps:", "      - run: echo hi"].join(
    "\n",
  );
  assert.equal(withExpression(runBodies(text)).length, 0);
});

test("a run: body without an expression is not flagged", () => {
  const text = ["steps:", "  - run: echo hi"].join("\n");
  assert.equal(withExpression(runBodies(text)).length, 0);
});

test("a script: body with an expression is caught the same way as run:", () => {
  const text = ["- uses: actions/github-script", "  with:", "    script: |", "      console.log(${{ x }})"].join("\n");
  assert.equal(withExpression(scriptBodies(text)).length, 1);
});

const REPO_WORKFLOW_GLOBS = [".github/workflows/*.yml", "templates/**/*.yml", "templates/**/*.yaml"];
const REPO_SHELL_GLOB = "templates/**/*.sh";

function repoWorkflowFiles() {
  return REPO_WORKFLOW_GLOBS.flatMap((pattern) => globSync(pattern)).sort();
}

function repoShellFiles() {
  return globSync(REPO_SHELL_GLOB).sort();
}

test("no run: or script: body in a tracked workflow or template contains an expression", () => {
  const violations = [];
  for (const path of repoWorkflowFiles()) {
    const text = readFileSync(path, "utf8");
    for (const hit of withExpression(runBodies(text))) {
      violations.push(`${path}:${hit.line}: run: body contains an expression`);
    }
    for (const hit of withExpression(scriptBodies(text))) {
      violations.push(`${path}:${hit.line}: script: body contains an expression`);
    }
  }
  // Every line of a shell template is itself a run body once copied into a
  // `run: |` step, so the whole file is scanned the same way.
  for (const path of repoShellFiles()) {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r\n|\r|\n/);
    lines.forEach((line, index) => {
      if (line.includes(EXPRESSION)) violations.push(`${path}:${index + 1}: shell template line contains an expression`);
    });
  }
  assert.deepEqual(violations, []);
});

test("the repository has at least one workflow to scan", () => {
  assert.ok(repoWorkflowFiles().length > 0);
});
