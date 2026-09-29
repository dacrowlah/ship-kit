// A registry mapping every `templates/**/*.{yml,yaml}` file on disk to the
// values that fill in its `<<placeholder>>` tokens, one entry per variant
// the template supports (for `templates/callers/review.yml`: with and
// without a boot workflow). This exists so the repository's YAML gates (the
// "no expression in run:" tree walk, and the yq cross-check) can run against
// real, complete, rendered YAML for template files, the same way they do for
// `.github/workflows/*.yml`, instead of weakening to a line scan for the
// files whose entire purpose is to become a live `pull_request_target`
// workflow in an adopting repository -- exactly the files where a bypass
// (a quoted `run:` key, a flow-mapping step, an alias) carrying a forged
// `${{ }}` expression would matter most.
//
// The registry supplies values only. `renderedTemplateVariants` reads each
// registered path's own file and renders it, so a variant can never be text
// from a different template, and it refuses:
//   - a template on disk with no registry entry, and an entry whose file is
//     gone (`checkRegistryMatchesDisk`);
//   - values that do not match the template's placeholders (`render()`
//     throws on a missing or unused key, so values written for one template
//     cannot be registered against another);
//   - empty output, which would make every gate vacuous;
//   - a rendered variant that drops any placeholder-free line of the raw
//     template (`assertTemplateLinesRendered`), so a renderer that skips
//     part of the file cannot hide it from the gate;
//   - a placeholder that survives rendering (`assertFullyRendered`).
// Adding a `templates/**/*.yml` file therefore means adding its values here
// in the same PR, or the gate itself fails.

import { globSync, readFileSync } from "node:fs";
import { PLACEHOLDER, render } from "../../scripts/lib/render.mjs";
import { callerValues, loadFixture } from "../callers/render-caller.mjs";

export const TEMPLATE_YAML_GLOB = "templates/**/*.{yml,yaml}";

const callerVariant = (name, fixtureFile) => ({
  name,
  values: () => callerValues(loadFixture(new URL(`../fixtures/${fixtureFile}`, import.meta.url))),
});

/** @type {Record<string, { name: string, values: () => Record<string, string> }[]>} */
export const REGISTRY = {
  "templates/callers/review.yml": [
    callerVariant("oauth, no boot workflow", "caller-values.json"),
    callerVariant("api-key, boot workflow", "caller-values-boot.json"),
  ],
};

/**
 * @param {(pattern: string) => string[]} glob
 * @returns {string[]} every templates/**\/*.{yml,yaml} path on disk, sorted
 */
export function repoTemplateYamlFiles(glob = globSync) {
  return glob(TEMPLATE_YAML_GLOB).sort();
}

/**
 * @param {string[]} onDiskPaths
 * @param {Record<string, unknown[]>} registry
 * @throws {Error} when a template file on disk has no registered values,
 *   or a registered entry's template no longer exists on disk
 */
export function checkRegistryMatchesDisk(onDiskPaths, registry) {
  const onDisk = new Set(onDiskPaths);
  const registered = new Set(Object.keys(registry));

  const missing = [...onDisk].filter((path) => !registered.has(path));
  if (missing.length > 0) {
    throw new Error(`no values registered in tests/helpers/rendered-templates.mjs for: ${missing.join(", ")}`);
  }
  const stale = [...registered].filter((path) => !onDisk.has(path));
  if (stale.length > 0) {
    throw new Error(`tests/helpers/rendered-templates.mjs registers values for a template that no longer exists: ${stale.join(", ")}`);
  }
}

/**
 * @param {string} path
 * @param {string} variant
 * @param {string} text
 * @throws {Error} when any `<<key>>` placeholder survives rendering
 */
export function assertFullyRendered(path, variant, text) {
  const left = [...text.matchAll(PLACEHOLDER)].map((match) => match[0]);
  if (left.length > 0) {
    throw new Error(`${path} [${variant}] still holds unrendered placeholders: ${[...new Set(left)].join(", ")}`);
  }
}

/**
 * @param {string} path
 * @param {string} variant
 * @param {string} text
 * @throws {Error} when the rendered output is empty or only whitespace
 */
export function assertNotEmpty(path, variant, text) {
  if (text.trim() === "") {
    throw new Error(`${path} [${variant}] rendered to empty output, which would leave every gate vacuous`);
  }
}

/**
 * Every non-blank raw template line that holds no placeholder is copied
 * through rendering unchanged and in order, so it must appear in the output
 * in the same relative order. A renderer that drops or reorders part of the
 * file fails here rather than passing a gate that never saw that part.
 * @param {string} path
 * @param {string} variant
 * @param {string} template the raw template text
 * @param {string} text the rendered output
 * @throws {Error} naming the first raw lines missing from the output
 */
export function assertTemplateLinesRendered(path, variant, template, text) {
  const outputLines = text.split("\n");
  let cursor = 0;
  const missing = [];
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "" || new RegExp(PLACEHOLDER.source).test(line)) continue;
    const found = outputLines.indexOf(line, cursor);
    if (found === -1) {
      missing.push(line);
    } else {
      cursor = found + 1;
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${path} [${variant}] rendered output is missing ${missing.length} of the template's placeholder-free lines, first: ${JSON.stringify(missing[0])}`,
    );
  }
}

/**
 * @param {{
 *   glob?: (pattern: string) => string[],
 *   registry?: Record<string, { name: string, values: () => Record<string, string> }[]>,
 *   read?: (path: string) => string,
 *   renderTemplate?: (template: string, values: Record<string, string>) => string,
 * }} [deps] injectable for tests
 * @returns {{ path: string, variant: string, text: string }[]} one entry per
 *   registered variant, each a rendered, non-empty, placeholder-free YAML
 *   text produced from that path's own file
 * @throws {Error} on any refusal listed in this file's header
 */
export function renderedTemplateVariants({
  glob = globSync,
  registry = REGISTRY,
  read = (path) => readFileSync(path, "utf8"),
  renderTemplate = render,
} = {}) {
  checkRegistryMatchesDisk(repoTemplateYamlFiles(glob), registry);

  const results = [];
  for (const [path, variants] of Object.entries(registry)) {
    const template = read(path);
    for (const { name, values } of variants) {
      const text = renderTemplate(template, values());
      assertNotEmpty(path, name, text);
      assertTemplateLinesRendered(path, name, template, text);
      assertFullyRendered(path, name, text);
      results.push({ path, variant: name, text });
    }
  }
  return results;
}
