import assert from "node:assert/strict";
import test from "node:test";
import { assertFullyRendered, checkRegistryMatchesDisk, renderedTemplateVariants, repoTemplateYamlFiles } from "./rendered-templates.mjs";

test("repoTemplateYamlFiles finds the real caller template", () => {
  const files = repoTemplateYamlFiles();
  assert.ok(files.includes("templates/callers/review.yml"));
});

test("renderedTemplateVariants returns both registered variants, fully rendered (no placeholders left)", () => {
  const variants = renderedTemplateVariants();
  assert.equal(variants.length, 2);
  for (const { path, variant, text } of variants) {
    assert.equal(path, "templates/callers/review.yml");
    assert.ok(typeof variant === "string" && variant.length > 0);
    assert.ok(!text.includes("<<"), `rendered variant "${variant}" still has an unrendered placeholder`);
  }
});

test("checkRegistryMatchesDisk refuses a template file on disk with no registered renderer", () => {
  assert.throws(
    () => checkRegistryMatchesDisk(["templates/callers/review.yml", "templates/blocks/new-thing.yml"], { "templates/callers/review.yml": [] }),
    /no renderer registered .* templates\/blocks\/new-thing\.yml/,
  );
});

test("checkRegistryMatchesDisk refuses a registered renderer whose template no longer exists", () => {
  assert.throws(
    () => checkRegistryMatchesDisk(["templates/callers/review.yml"], { "templates/callers/review.yml": [], "templates/callers/gone.yml": [] }),
    /registers a renderer for a template that no longer exists.*templates\/callers\/gone\.yml/,
  );
});

test("checkRegistryMatchesDisk accepts a matching registry and disk listing", () => {
  checkRegistryMatchesDisk(["templates/callers/review.yml"], { "templates/callers/review.yml": [] });
});

test("renderedTemplateVariants refuses when glob() finds a file the registry does not know", () => {
  const fakeGlob = () => ["templates/callers/review.yml", "templates/unknown.yml"];
  assert.throws(() => renderedTemplateVariants(fakeGlob), /no renderer registered/);
});

test("assertFullyRendered refuses text that still holds a placeholder, and names it", () => {
  assert.throws(() => assertFullyRendered("t.yml", "v", "jobs:\n<<boot_job>>\n"), /unrendered placeholders: <<boot_job>>/);
});

test("assertFullyRendered accepts text with no placeholder", () => {
  assertFullyRendered("t.yml", "v", "jobs: {}\n");
});

test("renderedTemplateVariants refuses a registered variant whose output still holds a placeholder", () => {
  const registry = { "templates/t.yml": [{ name: "leaky", render: () => "jobs:\n<<boot_job>>\n" }] };
  assert.throws(() => renderedTemplateVariants(() => ["templates/t.yml"], registry), /unrendered placeholders/);
});

test("renderedTemplateVariants renders every variant of an injected registry, in order", () => {
  const registry = {
    "templates/t.yml": [
      { name: "one", render: () => "a: 1\n" },
      { name: "two", render: () => "a: 2\n" },
    ],
  };
  assert.deepEqual(renderedTemplateVariants(() => ["templates/t.yml"], registry), [
    { path: "templates/t.yml", variant: "one", text: "a: 1\n" },
    { path: "templates/t.yml", variant: "two", text: "a: 2\n" },
  ]);
});
