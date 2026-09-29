import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PLACEHOLDER } from "../../scripts/lib/render.mjs";
import { TEMPLATE_MANIFEST, callerValues } from "../../scripts/setup/render-files.mjs";
import { callerArgs, loadFixture } from "../callers/render-caller.mjs";
import {
  REGISTRY,
  assertFullyRendered,
  assertNotEmpty,
  assertTemplateLinesRendered,
  checkManifestMatchesDisk,
  checkRegistryMatchesManifest,
  renderedTemplateVariants,
  templateExpressionViolations,
  templateFilesOnDisk,
} from "./rendered-templates.mjs";

const REVIEW = "templates/callers/review.yml";
const CALLER_VALUES = () => callerValues(callerArgs(loadFixture(new URL("../fixtures/caller-values.json", import.meta.url))));
const workflow = (path) => ({ path, role: "workflow" });

/**
 * A manifest + registry + reader for one fake template that exists only in
 * memory. The reader serves that text for that path only and throws for any
 * other, so a pipeline that read some other path would fail here.
 */
function fake(path, template, variants) {
  return {
    manifest: [workflow(path)],
    listFiles: () => [path],
    registry: { [path]: variants },
    read: (requested) => {
      if (requested !== path) throw new Error(`read of an unexpected path: ${requested}`);
      return template;
    },
  };
}

/** A scratch directory holding the given files (path -> text), removed by the callback's caller. */
function withTree(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-templates-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("templateFilesOnDisk finds the real caller template", () => {
  assert.ok(templateFilesOnDisk().includes(REVIEW));
});

test("templateFilesOnDisk lists dot directories, dot files, other extensions and other letter cases", () => {
  withTree(
    {
      "templates/callers/a.yml": "a: 1\n",
      "templates/.github/workflows/evil.yml": "a: 1\n",
      "templates/callers/.hidden.yml": "a: 1\n",
      "templates/callers/Loud.YML": "a: 1\n",
      "templates/files/thing.yml.tmpl": "a: 1\n",
      "templates/files/no-extension": "a: 1\n",
    },
    (dir) => {
      assert.deepEqual(templateFilesOnDisk(join(dir, "templates")).map((path) => path.slice(dir.length + 1)), [
        "templates/.github/workflows/evil.yml",
        "templates/callers/.hidden.yml",
        "templates/callers/Loud.YML",
        "templates/callers/a.yml",
        "templates/files/no-extension",
        "templates/files/thing.yml.tmpl",
      ]);
    },
  );
});

test("templateFilesOnDisk refuses a root that is itself a symlink or is not a directory", () => {
  withTree({ "real/callers/a.yml": "a: 1\n", "plain.txt": "x\n" }, (dir) => {
    symlinkSync(join(dir, "real"), join(dir, "templates"));
    assert.throws(() => templateFilesOnDisk(join(dir, "templates")), /is not a directory/);
    assert.throws(() => templateFilesOnDisk(join(dir, "plain.txt")), /is not a directory/);
  });
});

test("templateFilesOnDisk refuses a symlink instead of following or skipping it", () => {
  withTree({ "templates/callers/a.yml": "a: 1\n", "outside.yml": "run: ${{ x }}\n" }, (dir) => {
    symlinkSync(join(dir, "outside.yml"), join(dir, "templates", "callers", "link.yml"));
    assert.throws(() => templateFilesOnDisk(join(dir, "templates")), /link\.yml is neither a regular file nor a directory/);
  });
});

test("the real templates/ directory and TEMPLATE_MANIFEST list the same files", () => {
  checkManifestMatchesDisk(templateFilesOnDisk(), TEMPLATE_MANIFEST);
});

test("checkManifestMatchesDisk refuses a file the manifest does not list, whatever its name", () => {
  for (const unlisted of [
    "templates/callers/second.yml",
    "templates/.github/workflows/evil.yml",
    "templates/callers/.evil.yml",
    "templates/callers/Review.YML",
    "templates/files/evil.yml.tmpl",
    "templates/files/no-extension",
  ]) {
    assert.throws(() => checkManifestMatchesDisk([REVIEW, unlisted], [{ path: REVIEW }]), new RegExp(`does not list: ${unlisted.replaceAll(".", "\\.")}`), unlisted);
  }
});

test("checkManifestMatchesDisk refuses a manifest entry whose file is not on disk", () => {
  assert.throws(() => checkManifestMatchesDisk([REVIEW], [{ path: REVIEW }, { path: "templates/callers/gone.yml" }]), /not on disk: templates\/callers\/gone\.yml/);
});

test("checkManifestMatchesDisk compares exact spelling: a different letter case is a different file", () => {
  assert.throws(() => checkManifestMatchesDisk(["templates/callers/Review.yml"], [{ path: REVIEW }]), /does not list: templates\/callers\/Review\.yml/);
});

test("checkManifestMatchesDisk accepts a matching listing", () => {
  checkManifestMatchesDisk([REVIEW], [{ path: REVIEW }]);
});

test("the registry supplies values only: no entry carries a free-form render function", () => {
  for (const [path, variants] of Object.entries(REGISTRY)) {
    for (const variant of variants) {
      assert.deepEqual(Object.keys(variant).sort(), ["name", "values"], path);
    }
  }
});

test("the registry covers every workflow entry of the real manifest, and nothing else", () => {
  checkRegistryMatchesManifest(TEMPLATE_MANIFEST, REGISTRY);
  assert.deepEqual(
    Object.keys(REGISTRY).sort(),
    TEMPLATE_MANIFEST.filter((item) => item.role === "workflow").map((item) => item.path).sort(),
  );
});

test("checkRegistryMatchesManifest refuses a workflow entry with no registered values", () => {
  assert.throws(
    () => checkRegistryMatchesManifest([workflow(REVIEW), workflow("templates/callers/second.yml")], { [REVIEW]: [] }),
    /no values registered .* templates\/callers\/second\.yml/,
  );
});

test("checkRegistryMatchesManifest refuses values for a path the manifest does not list as a workflow", () => {
  assert.throws(
    () => checkRegistryMatchesManifest([workflow(REVIEW)], { [REVIEW]: [], "templates/callers/gone.yml": [] }),
    /registers values for a path the manifest does not list as a workflow: templates\/callers\/gone\.yml/,
  );
  assert.throws(
    () => checkRegistryMatchesManifest([workflow(REVIEW), { path: "templates/files/config.json", role: "file" }], { [REVIEW]: [], "templates/files/config.json": [] }),
    /does not list as a workflow: templates\/files\/config\.json/,
  );
});

test("checkRegistryMatchesManifest accepts a matching registry", () => {
  checkRegistryMatchesManifest([workflow(REVIEW), { path: "templates/blocks/gate-step.sh", role: "fragment" }], { [REVIEW]: [] });
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

test("renderedTemplateVariants refuses when the disk holds a template the manifest does not list", () => {
  assert.throws(() => renderedTemplateVariants({ listFiles: () => [REVIEW, "templates/unknown.yml"] }), /does not list: templates\/unknown\.yml/);
});

test("renderedTemplateVariants refuses a manifest workflow entry the registry does not know", () => {
  const manifest = [...TEMPLATE_MANIFEST, workflow("templates/callers/second.yml")];
  assert.throws(
    () => renderedTemplateVariants({ manifest, listFiles: () => manifest.map((item) => item.path) }),
    /no values registered .* templates\/callers\/second\.yml/,
  );
});

test("templateExpressionViolations is clean for the real manifest", () => {
  assert.deepEqual(templateExpressionViolations(), []);
});

test("templateExpressionViolations flags an expression opener in a fragment, block, file or seed, by line, and skips workflows", () => {
  const texts = {
    "templates/blocks/f.sh": "echo ok\necho ${{ github.event.pull_request.title }}\n",
    "templates/blocks/b.md": "text ${{ x }}\n",
    "templates/files/c.json": "{}\n",
    "templates/files/s.md": "x\r\n${{ y }}\r\n",
    "templates/callers/w.yml": "run: ${{ z }}\n",
  };
  const manifest = [
    { path: "templates/blocks/f.sh", role: "fragment" },
    { path: "templates/blocks/b.md", role: "block" },
    { path: "templates/files/c.json", role: "file" },
    { path: "templates/files/s.md", role: "seed" },
    { path: "templates/callers/w.yml", role: "workflow" },
  ];
  assert.deepEqual(templateExpressionViolations({ manifest, read: (path) => texts[path] }), [
    "templates/blocks/f.sh:2: fragment template line contains an expression",
    "templates/blocks/b.md:1: block template line contains an expression",
    "templates/files/s.md:2: seed template line contains an expression",
  ]);
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

test("assertTemplateLinesRendered accepts every registered variant checked against its own path's template", () => {
  const variants = renderedTemplateVariants();
  assert.ok(variants.length > 0);
  for (const { path, variant, text } of variants) {
    assertTemplateLinesRendered(path, variant, readFileSync(path, "utf8"), text);
  }
});

test("the registered variants are checked against their own templates, so a second registered template does not fail the first's check", () => {
  const second = "templates/callers/second.yml";
  const secondText = "name: second\non: workflow_dispatch\njobs: {}\n";
  const manifest = [...TEMPLATE_MANIFEST, workflow(second)];
  const variants = renderedTemplateVariants({
    manifest,
    listFiles: () => manifest.map((item) => item.path),
    registry: { ...REGISTRY, [second]: [{ name: "only", values: () => ({}) }] },
    read: (path) => (path === second ? secondText : readFileSync(path, "utf8")),
  });
  assert.deepEqual(variants.map((item) => item.path), [REVIEW, REVIEW, second]);
  for (const { path, variant, text } of variants) {
    assertTemplateLinesRendered(path, variant, path === second ? secondText : readFileSync(path, "utf8"), text);
  }
  assert.throws(() => assertTemplateLinesRendered(REVIEW, "wrong", secondText, variants[0].text), /missing/);
});

test("assertTemplateLinesRendered ignores blank lines and lines that hold a placeholder", () => {
  assertTemplateLinesRendered("t.yml", "v", "a: <<x>>\n\nb: 2\n", "a: 1\nb: 2\n");
});
