// A registry mapping every `templates/**/*.{yml,yaml}` file on disk to the
// renderer(s) that fill in its `<<placeholder>>` tokens with representative
// values, one entry per variant the renderer supports (for
// `templates/callers/review.yml`: with and without a boot workflow). This
// exists so the repository's YAML gates (the "no expression in run:" tree
// walk, and the yq cross-check) can run against real, complete, rendered
// YAML for template files, the same way they already do for
// `.github/workflows/*.yml`, instead of weakening to a line scan for the
// files whose entire purpose is to become a live `pull_request_target`
// workflow in an adopting repository -- exactly the files where a bypass
// (a quoted `run:` key, a flow-mapping step, an alias) carrying a forged
// `${{ }}` expression would matter most.
//
// A template file found on disk with no registered renderer is refused
// (`renderedTemplateVariants` throws) rather than silently skipped: adding a
// new `templates/**/*.yml` file means adding its renderer here in the same
// PR, or the gate itself fails. `render()` (design 6.5, `scripts/lib/
// render.mjs`) already refuses an unreplaced placeholder, so every variant
// this module returns is placeholder-free, real YAML.

import { globSync } from "node:fs";
import { PLACEHOLDER } from "../../scripts/lib/render.mjs";
import { loadFixture, renderCaller } from "../callers/render-caller.mjs";

export const TEMPLATE_YAML_GLOB = "templates/**/*.{yml,yaml}";

const callerVariant = (name, fixtureFile) => ({
  name,
  render: () => renderCaller(loadFixture(new URL(`../fixtures/${fixtureFile}`, import.meta.url))),
});

/** @type {Record<string, { name: string, render: () => string }[]>} */
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
 * @throws {Error} when a template file on disk has no registered renderer,
 *   or a registered renderer's template no longer exists on disk
 */
export function checkRegistryMatchesDisk(onDiskPaths, registry) {
  const onDisk = new Set(onDiskPaths);
  const registered = new Set(Object.keys(registry));

  const missing = [...onDisk].filter((path) => !registered.has(path));
  if (missing.length > 0) {
    throw new Error(`no renderer registered in tests/helpers/rendered-templates.mjs for: ${missing.join(", ")}`);
  }
  const stale = [...registered].filter((path) => !onDisk.has(path));
  if (stale.length > 0) {
    throw new Error(`tests/helpers/rendered-templates.mjs registers a renderer for a template that no longer exists: ${stale.join(", ")}`);
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
 * @param {(pattern: string) => string[]} glob
 * @param {Record<string, { name: string, render: () => string }[]>} registry
 * @returns {{ path: string, variant: string, text: string }[]} one entry per
 *   registered variant, each a fully rendered (placeholder-free) YAML text
 * @throws {Error} when a template file on disk has no registered renderer,
 *   a registered renderer's template no longer exists on disk, or a rendered
 *   variant still holds a placeholder
 */
export function renderedTemplateVariants(glob = globSync, registry = REGISTRY) {
  checkRegistryMatchesDisk(repoTemplateYamlFiles(glob), registry);

  const results = [];
  for (const [path, variants] of Object.entries(registry)) {
    for (const { name, render } of variants) {
      const text = render();
      assertFullyRendered(path, name, text);
      results.push({ path, variant: name, text });
    }
  }
  return results;
}
