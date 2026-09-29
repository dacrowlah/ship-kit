// The gate for design 6.3's "Expressions never reach a shell": no `run:`
// (or `actions/github-script` `script:`) value anywhere in a YAML document
// may contain `${{`, because a value substituted through an expression
// there is interpreted text, and an expression can carry attacker-controlled
// content (a PR title, a branch name, a comment body). For a real YAML
// file the gate walks the parsed tree (`yamlExpressionViolations`, built on
// `yaml.mjs`), not a line scan: a line scan cannot tell a `run:` key line
// from an equivalent flow mapping (`- {run: "..."}`), a quoted key
// (`"run": ...`), or an alias (`run: *body`) whose anchor carries the
// expression -- all constructs a real YAML parser (confirmed against `yq`)
// resolves to a `run:`/`script:` value, which GitHub Actions itself would
// then evaluate. A document holding a construct the reader cannot
// represent (an anchor, alias, tag, folded scalar, non-empty flow mapping,
// second document, duplicate key, or a tab in indentation) is refused
// outright, fail-closed, rather than silently walked around: a document
// this scan cannot fully see is never reported clean. A `.sh` template has
// no YAML structure to walk, so it is still scanned line by line
// (`runBodies`), since every line of it is a run body once copied into a
// `run: |` step.
//
// This file is the gate itself: `node --test` over the repository fails it
// whenever a tracked workflow or template regresses.

import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import { runBodies, scriptBodies, yamlExpressionViolations } from "../helpers/run-bodies.mjs";
import { YamlSubsetError } from "../helpers/yaml.mjs";

const EXPRESSION = "${{";

/**
 * @param {{ line: number, text: string }[]} bodies
 * @returns {{ line: number, text: string }[]} the entries containing an expression
 */
function withExpression(bodies) {
  return bodies.filter((body) => body.text.includes(EXPRESSION));
}

// -- runBodies / scriptBodies: the line scanner used for non-YAML text (a
// shell template) only. ------------------------------------------------

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

// -- yamlExpressionViolations: the actual gate over a real YAML document,
// walking the parsed tree instead of scanning lines. --------------------

/**
 * @param {string} text
 * @returns {"found" | "refused"} whether the gate catches the expression by
 *   finding it in a run/script value, or by refusing the whole document
 *   because it holds a construct outside the supported subset
 */
function gateOutcome(text) {
  try {
    return withExpression(yamlExpressionViolations(text)).length > 0 ? "found" : "clean";
  } catch (err) {
    if (err instanceof YamlSubsetError) return "refused";
    throw err;
  }
}

test("a plain run: value with an expression is found", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - run: echo ${{ x }}"].join("\n");
  assert.equal(gateOutcome(text), "found");
});

test("a plain run: value without an expression is clean", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - run: echo hi"].join("\n");
  assert.equal(gateOutcome(text), "clean");
});

test("a flow-mapping step holding run: with an expression is refused, not silently missed", () => {
  const text = ["jobs:", "  x:", "    steps:", '      - {run: "echo ${{ x }}"}'].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

test("a double-quoted run key with an expression is found", () => {
  const text = ["jobs:", "  x:", "    steps:", '      - "run": echo ${{ x }}'].join("\n");
  assert.equal(gateOutcome(text), "found");
});

test("a single-quoted run key with an expression is found", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - 'run': echo ${{ x }}"].join("\n");
  assert.equal(gateOutcome(text), "found");
});

test("run: *alias referencing an anchor that carries an expression is refused, not silently missed", () => {
  const text = ['x: &body "echo ${{ x }}"', "jobs:", "  y:", "    steps:", "      - run: *body"].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

test("an anchor anywhere in the document is refused even when it is nowhere near a run: value", () => {
  const text = ["env:", "  X: &foo bar", "jobs:", "  x:", "    steps:", "      - run: echo hi"].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

test("a merge key (<<: *anchor) is refused", () => {
  const text = ["defaults: &defaults", "  run: echo hi", "steps:", "  - <<: *defaults"].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

test("a tag on a run: value is refused", () => {
  const text = ["jobs:", "  x:", "    steps:", "      - run: !!str echo hi"].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

test("a second YAML document in the same file is refused", () => {
  const text = ["run: echo hi", "---", "run: echo ${{ x }}"].join("\n");
  assert.equal(gateOutcome(text), "refused");
});

// -- The real repository: every tracked workflow and template. ----------

// Real workflow files are always complete, standalone YAML, so the tree
// walk (`yamlExpressionViolations`) is the gate for them: it sees a
// run:/script: value regardless of which supported spelling produced it,
// and refuses a document it cannot fully represent.
const REPO_WORKFLOW_YAML_GLOB = ".github/workflows/*.yml";
// A file under templates/ is rendered by `render.mjs` before it is ever a
// real workflow: it may hold `<<placeholder>>` tokens (for example a
// column-0 whole-line placeholder standing in for an entire job, as
// `templates/callers/review.yml` uses for `<<boot_job>>`), which are not
// valid YAML on their own and would make the tree walk refuse a template
// that is actually clean. These are scanned the same line-based way as a
// `.sh` template (`runBodies`/`scriptBodies`, built for exactly this case);
// the rendered output itself is checked by `tests/callers/gate.test.mjs`
// and `tests/callers/render.test.mjs`, which parse it as real YAML once its
// placeholders are filled in.
const REPO_TEMPLATE_YAML_GLOB = "templates/**/*.{yml,yaml}";
const REPO_SHELL_GLOB = "templates/**/*.sh";

function repoWorkflowFiles() {
  return globSync(REPO_WORKFLOW_YAML_GLOB).sort();
}

function repoTemplateYamlFiles() {
  return globSync(REPO_TEMPLATE_YAML_GLOB).sort();
}

function repoShellFiles() {
  return globSync(REPO_SHELL_GLOB).sort();
}

test("no run: or script: value in a tracked workflow or template contains an expression", () => {
  const violations = [];
  for (const path of repoWorkflowFiles()) {
    const text = readFileSync(path, "utf8");
    try {
      for (const hit of withExpression(yamlExpressionViolations(text))) {
        violations.push(`${path}:${hit.line}: run:/script: value contains an expression`);
      }
    } catch (err) {
      if (!(err instanceof YamlSubsetError)) throw err;
      violations.push(`${path}: refused (cannot be fully parsed by the supported YAML subset): ${err.message}`);
    }
  }
  // A template YAML file may hold `<<placeholders>>` outside any run:/
  // script: value too (for example `<<default_branch>>` in `branches:
  // [...]`), so it is scanned key-by-key with the same line-based reader a
  // shell template's whole body uses, not a blind whole-file line scan: an
  // expression legitimately living in `env:` or `concurrency:` must not be
  // flagged just because the file cannot be tree-walked.
  for (const path of repoTemplateYamlFiles()) {
    const text = readFileSync(path, "utf8");
    for (const hit of [...withExpression(runBodies(text)), ...withExpression(scriptBodies(text))]) {
      violations.push(`${path}:${hit.line}: run:/script: value contains an expression`);
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
