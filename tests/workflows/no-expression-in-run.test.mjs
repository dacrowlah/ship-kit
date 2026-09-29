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
import { renderedTemplateVariants } from "../helpers/rendered-templates.mjs";

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

// Real workflow files are always complete, standalone YAML: scanned as text
// straight off disk.
const REPO_WORKFLOW_YAML_GLOB = ".github/workflows/*.yml";
const REPO_SHELL_GLOB = "templates/**/*.sh";

function repoWorkflowFiles() {
  return globSync(REPO_WORKFLOW_YAML_GLOB).sort();
}

function repoShellFiles() {
  return globSync(REPO_SHELL_GLOB).sort();
}

/**
 * Runs the same tree-walk gate (`yamlExpressionViolations`) a parsed YAML
 * document gets, refusing (not silently missing) anything the reader cannot
 * represent, and records each hit or refusal as a violation string.
 * @param {string} label identifies the text in a violation message
 * @param {string} text
 * @param {string[]} violations appended to in place
 */
function gateYamlText(label, text, violations) {
  try {
    for (const hit of withExpression(yamlExpressionViolations(text))) {
      violations.push(`${label}:${hit.line}: run:/script: value contains an expression`);
    }
  } catch (err) {
    if (!(err instanceof YamlSubsetError)) throw err;
    violations.push(`${label}: refused (cannot be fully parsed by the supported YAML subset): ${err.message}`);
  }
}

/**
 * Gates every rendered template variant. A template with no registered
 * renderer, a registered renderer for a template that is gone, or a variant
 * that still holds a placeholder is itself a violation (fail closed): the
 * next template can never fall back to an unscanned state.
 * @param {() => { path: string, variant: string, text: string }[]} variantsOf
 * @param {string[]} violations appended to in place
 */
function gateRenderedTemplates(variantsOf, violations) {
  let variants;
  try {
    variants = variantsOf();
  } catch (err) {
    violations.push(`templates: cannot be rendered for the gate (${err.message})`);
    return;
  }
  for (const { path, variant, text } of variants) {
    gateYamlText(`${path} [${variant}]`, text, violations);
  }
}

test("no run: or script: value in a tracked workflow, or a rendered template, contains an expression", () => {
  const violations = [];
  for (const path of repoWorkflowFiles()) {
    gateYamlText(path, readFileSync(path, "utf8"), violations);
  }
  // A template under templates/**/*.yml holds `<<placeholder>>` tokens and
  // is not standalone YAML in its raw form (for example
  // `templates/callers/review.yml`'s column-0 `<<boot_job>>`, which stands
  // in for an entire job before rendering). Rather than weaken the gate to
  // a line scan for exactly the files whose whole purpose is to become a
  // live `pull_request_target` workflow in an adopting repository, every
  // registered variant is rendered first (placeholder-free, real YAML;
  // `render()` itself refuses an unreplaced placeholder) and then walked by
  // the identical tree-walk gate real workflow files get.
  gateRenderedTemplates(renderedTemplateVariants, violations);
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


// -- Bypass forms: every shape the tree-walk gate must catch (found) or
// refuse (cannot be fully parsed, hence never silently clean), planted in a
// minimal template-shaped document with no placeholders of its own. These
// are the same forms Task 6 built `yamlExpressionViolations` to catch
// instead of a line scan (`run-bodies.mjs`'s own header: a line scan
// "cannot tell a run: key line from an equivalent flow mapping, quoted key,
// or alias, and a construct outside what the scan recognizes is silently
// treated as if it held no run:/script: value at all"), and are the exact
// forms `renderedTemplateVariants` must expose to `yamlExpressionViolations`
// once a template is rendered, not a form a line scan over the raw template
// text could ever be trusted to find.

const EXPR = "${{ github.event.pull_request.title }}";

function planted(label, text) {
  const violations = [];
  gateYamlText(label, text, violations);
  return violations;
}

test("a double-quoted run: key carrying an expression is found", () => {
  const text = ["jobs:", "  evil:", `    "run": "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-double-quoted-key", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /run:\/script: value contains an expression/);
});

test("a single-quoted run: key carrying an expression is found", () => {
  const text = ["jobs:", "  evil:", `    'run': "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-single-quoted-key", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /run:\/script: value contains an expression/);
});

test("a run key with a space before the colon (run :) carrying an expression is found", () => {
  const text = ["jobs:", "  evil:", `    run : "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-space-before-colon", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /run:\/script: value contains an expression/);
});

test("a flow-mapping step holding run: with an expression is refused", () => {
  const text = ["jobs:", "  evil:", `    steps: [{run: "echo ${EXPR}"}]`].join("\n");
  const violations = planted("bypass-flow-mapping", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /refused \(cannot be fully parsed/);
});

test("run: *alias referencing an anchor carrying an expression is refused", () => {
  const text = [`x: &body "echo ${EXPR}"`, "jobs:", "  evil:", "    steps:", "      - run: *body"].join("\n");
  const violations = planted("bypass-alias", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /refused \(cannot be fully parsed/);
});

test("an explicit-key (? run / : value) mapping entry is refused", () => {
  const text = ["jobs:", "  evil:", "    ? run", `    : "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-explicit-key", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /refused \(cannot be fully parsed/);
});

test("a double-quoted key with a hex escape spelling run (\"ru\\x6e\") is refused", () => {
  const text = ["jobs:", "  evil:", `    "ru\\x6e": "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-escaped-key", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /refused \(cannot be fully parsed/);
});

test("the control case (a plain run: with an expression) is found, confirming the harness itself works", () => {
  const text = ["jobs:", "  evil:", `    run: "echo ${EXPR}"`].join("\n");
  const violations = planted("bypass-control", text);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /run:\/script: value contains an expression/);
});

test("every currently rendered template variant is clean: none of the bypass forms are present", () => {
  const violations = [];
  gateRenderedTemplates(renderedTemplateVariants, violations);
  assert.deepEqual(violations, []);
});

// -- The whole pipeline (registry -> render -> tree walk), not just the
// walk: each bypass form planted as a registered template variant, and the
// fail-closed cases for a template the registry cannot render. ----------

const BYPASS_TEMPLATES = {
  "double-quoted key": ["jobs:", "  evil:", `    "run": "echo ${EXPR}"`].join("\n"),
  "single-quoted key": ["jobs:", "  evil:", `    'run': "echo ${EXPR}"`].join("\n"),
  "space before colon": ["jobs:", "  evil:", `    run : "echo ${EXPR}"`].join("\n"),
  "flow mapping": ["jobs:", "  evil:", `    steps: [{run: "echo ${EXPR}"}]`].join("\n"),
  alias: [`x: &body "echo ${EXPR}"`, "jobs:", "  evil:", "    steps:", "      - run: *body"].join("\n"),
  "explicit key": ["jobs:", "  evil:", "    ? run", `    : "echo ${EXPR}"`].join("\n"),
  "escaped key": ["jobs:", "  evil:", `    "ru\\x6e": "echo ${EXPR}"`].join("\n"),
  "control (plain key)": ["jobs:", "  evil:", `    run: "echo ${EXPR}"`].join("\n"),
};

/** Renders one in-memory template the way the real pipeline would. */
function gateInMemoryTemplate(path, template, variants, violations) {
  gateRenderedTemplates(
    () =>
      renderedTemplateVariants({
        glob: () => [path],
        registry: { [path]: variants },
        read: (requested) => {
          if (requested !== path) throw new Error(`read of an unexpected path: ${requested}`);
          return template;
        },
      }),
    violations,
  );
}

for (const [form, text] of Object.entries(BYPASS_TEMPLATES)) {
  test(`a registered template using a ${form} is reported by the rendered-template gate`, () => {
    const violations = [];
    gateInMemoryTemplate("templates/evil.yml", `${text}\n`, [{ name: form, values: () => ({}) }], violations);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0], /^templates\/evil\.yml \[/);
  });
}

test("a placeholder-bearing template using a quoted run key is gated once rendered with its own values", () => {
  const template = `jobs:\n<<job>>\n`;
  const values = () => ({ job: `  evil:\n    "run": "echo ${EXPR}"` });
  const violations = [];
  gateInMemoryTemplate("templates/evil.yml", template, [{ name: "with job", values }], violations);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0], /run:\/script: value contains an expression/);
});

test("a template file with no registered values is a violation, not a silent skip", () => {
  const violations = [];
  gateRenderedTemplates(() => renderedTemplateVariants({ glob: () => ["templates/new.yml"], registry: {} }), violations);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no values registered/);
});

test("a template that renders to empty output is a violation, not a vacuous pass", () => {
  const violations = [];
  gateInMemoryTemplate("templates/t.yml", "<<body>>\n", [{ name: "blank", values: () => ({ body: "" }) }], violations);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rendered to empty output/);
});

test("values for one template registered against a different template's file are a violation", () => {
  const violations = [];
  gateInMemoryTemplate("templates/evil.yml", "jobs: {}\n<<only_in_evil>>\n", [{ name: "wrong values", values: () => ({ seat: "general" }) }], violations);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /cannot be rendered for the gate/);
});

test("a rendered variant that still holds a placeholder is a violation", () => {
  const violations = [];
  gateRenderedTemplates(
    () =>
      renderedTemplateVariants({
        glob: () => ["templates/t.yml"],
        registry: { "templates/t.yml": [{ name: "leaky", values: () => ({}) }] },
        read: () => "a: 1\n",
        renderTemplate: () => "a: 1\n<<boot_job>>\n",
      }),
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /unrendered placeholders/);
});
