import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLACEHOLDER } from "../../scripts/lib/render.mjs";
import { callerValues, loadFixture } from "../callers/render-caller.mjs";
import {
  REGISTRY,
  assertFullyRendered,
  assertNotEmpty,
  assertTemplateLinesRendered,
  checkRegistryMatchesDisk,
  renderedTemplateVariants,
  repoTemplateYamlFiles,
} from "./rendered-templates.mjs";

const REVIEW = "templates/callers/review.yml";
const CALLER_VALUES = () => callerValues(loadFixture(new URL("../fixtures/caller-values.json", import.meta.url)));

/**
 * A registry + reader for one fake template that exists only in memory. The
 * reader serves that text for that path only and throws for any other, so a
 * pipeline that read some other path would fail here.
 */
function fake(path, template, variants) {
  return {
    glob: () => [path],
    registry: { [path]: variants },
    read: (requested) => {
      if (requested !== path) throw new Error(`read of an unexpected path: ${requested}`);
      return template;
    },
  };
}

test("repoTemplateYamlFiles finds the real caller template", () => {
  assert.ok(repoTemplateYamlFiles().includes(REVIEW));
});

test("renderedTemplateVariants returns both registered variants of the real template, rendered from its own file", () => {
  const variants = renderedTemplateVariants();
  assert.equal(variants.length, 2);
  for (const { path, variant, text } of variants) {
    assert.equal(path, REVIEW);
    assert.ok(typeof variant === "string" && variant.length > 0);
    assert.equal([...text.matchAll(PLACEHOLDER)].length, 0, `rendered variant "${variant}" still has a placeholder`);
  }
  const [noBoot, boot] = variants;
  assert.ok(!noBoot.text.includes("  boot:"));
  assert.ok(boot.text.includes("  boot:\n    uses: ./.github/workflows/boot.yml"));
});

test("the registry supplies values only: no entry carries a free-form render function", () => {
  for (const [path, variants] of Object.entries(REGISTRY)) {
    for (const variant of variants) {
      assert.deepEqual(Object.keys(variant).sort(), ["name", "values"], path);
    }
  }
});

test("checkRegistryMatchesDisk refuses a template file on disk with no registered values", () => {
  assert.throws(
    () => checkRegistryMatchesDisk([REVIEW, "templates/blocks/new-thing.yml"], { [REVIEW]: [] }),
    /no values registered .* templates\/blocks\/new-thing\.yml/,
  );
});

test("checkRegistryMatchesDisk refuses registered values whose template no longer exists", () => {
  assert.throws(
    () => checkRegistryMatchesDisk([REVIEW], { [REVIEW]: [], "templates/callers/gone.yml": [] }),
    /registers values for a template that no longer exists.*templates\/callers\/gone\.yml/,
  );
});

test("checkRegistryMatchesDisk accepts a matching registry and disk listing", () => {
  checkRegistryMatchesDisk([REVIEW], { [REVIEW]: [] });
});

test("renderedTemplateVariants refuses when the glob finds a file the registry does not know", () => {
  assert.throws(() => renderedTemplateVariants({ glob: () => [REVIEW, "templates/unknown.yml"] }), /no values registered/);
});

test("values written for the caller template cannot be registered against a different template", () => {
  // The registry cannot point a path at another template's text: the file
  // read for the path is what gets rendered, so the caller's values do not
  // fit a template with different placeholders.
  const evil = "on: pull_request_target\njobs:\n  x:\n    steps:\n      - \"run\": echo hi\n<<other_key>>\n";
  const deps = fake("templates/evil.yml", evil, [{ name: "evil", values: CALLER_VALUES }]);
  assert.throws(() => renderedTemplateVariants(deps), /has no value|is not used by the template/);
});

test("renderedTemplateVariants renders the file it reads for the path, not a fixed template", () => {
  const deps = fake("templates/other.yml", "name: <<n>>\nkeep: this\n", [{ name: "v", values: () => ({ n: "x" }) }]);
  assert.deepEqual(renderedTemplateVariants(deps), [{ path: "templates/other.yml", variant: "v", text: "name: x\nkeep: this\n" }]);
});

test("an empty template renders to empty output and is refused", () => {
  const deps = fake("templates/t.yml", "", [{ name: "empty", values: () => ({}) }]);
  assert.throws(() => renderedTemplateVariants(deps), /rendered to empty output/);
});

test("a template whose only content is an empty placeholder renders to empty output and is refused", () => {
  const deps = fake("templates/t.yml", "<<body>>\n", [{ name: "blank", values: () => ({ body: "" }) }]);
  assert.throws(() => renderedTemplateVariants(deps), /rendered to empty output/);
});

test("a renderer that drops part of the template is refused, naming the first missing line", () => {
  const deps = {
    ...fake("templates/t.yml", "a: 1\nb: <<x>>\nc: 3\n", [{ name: "v", values: () => ({ x: "2" }) }]),
    renderTemplate: () => "a: 1\nb: 2\n",
  };
  assert.throws(() => renderedTemplateVariants(deps), /missing 1 of the template's placeholder-free lines, first: "c: 3"/);
});

test("a renderer that reorders the template is refused", () => {
  const deps = {
    ...fake("templates/t.yml", "a: 1\nc: 3\n", [{ name: "v", values: () => ({}) }]),
    renderTemplate: () => "c: 3\na: 1\n",
  };
  assert.throws(() => renderedTemplateVariants(deps), /missing 1 of the template's placeholder-free lines/);
});

test("a rendered variant that still holds a placeholder is refused", () => {
  const deps = {
    ...fake("templates/t.yml", "a: 1\n", [{ name: "leaky", values: () => ({}) }]),
    renderTemplate: () => "a: 1\n<<boot_job>>\n",
  };
  assert.throws(() => renderedTemplateVariants(deps), /unrendered placeholders: <<boot_job>>/);
});

test("renderedTemplateVariants renders every variant of an injected registry, in order", () => {
  const deps = fake("templates/t.yml", "a: <<n>>\n", [
    { name: "one", values: () => ({ n: "1" }) },
    { name: "two", values: () => ({ n: "2" }) },
  ]);
  assert.deepEqual(renderedTemplateVariants(deps), [
    { path: "templates/t.yml", variant: "one", text: "a: 1\n" },
    { path: "templates/t.yml", variant: "two", text: "a: 2\n" },
  ]);
});

test("assertFullyRendered refuses text that still holds a placeholder, and names it", () => {
  assert.throws(() => assertFullyRendered("t.yml", "v", "jobs:\n<<boot_job>>\n"), /unrendered placeholders: <<boot_job>>/);
});

test("assertFullyRendered accepts text with no placeholder, including a heredoc-style <<EOF", () => {
  assertFullyRendered("t.yml", "v", "jobs: {}\ncat <<EOF\nEOF\n");
});

test("assertNotEmpty refuses empty and whitespace-only output and accepts real output", () => {
  assert.throws(() => assertNotEmpty("t.yml", "v", ""), /rendered to empty output/);
  assert.throws(() => assertNotEmpty("t.yml", "v", "\n  \n"), /rendered to empty output/);
  assertNotEmpty("t.yml", "v", "a: 1\n");
});

test("assertTemplateLinesRendered accepts the real caller template rendered by the real renderer", () => {
  const template = readFileSync(REVIEW, "utf8");
  for (const { text } of renderedTemplateVariants()) {
    assertTemplateLinesRendered(REVIEW, "real", template, text);
  }
});

test("assertTemplateLinesRendered ignores blank lines and lines that hold a placeholder", () => {
  assertTemplateLinesRendered("t.yml", "v", "a: <<x>>\n\nb: 2\n", "a: 1\nb: 2\n");
});
