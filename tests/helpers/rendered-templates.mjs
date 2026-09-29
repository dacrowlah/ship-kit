// A registry mapping every workflow template that setup renders to the values
// that fill in its `<<placeholder>>` tokens, one entry per variant the
// template supports (for `templates/callers/review.yml`: with and without a
// boot workflow). This exists so the repository's YAML gates (the "no
// expression in run:" tree walk, and the yq cross-check) can run against
// real, complete, rendered YAML for template files, the same way they do for
// `.github/workflows/*.yml`, instead of weakening to a line scan for the
// files whose entire purpose is to become a live `pull_request_target`
// workflow in an adopting repository -- exactly the files where a bypass
// (a quoted `run:` key, a flow-mapping step, an alias) carrying a forged
// `${{ }}` expression would matter most.
//
// What is a template, and which are workflows, is decided by the manifest
// setup renders from (`TEMPLATE_MANIFEST` in scripts/setup/render-files.mjs),
// never by a filename glob: a glob misses dot directories, other extensions
// and, on a case-sensitive filesystem, other letter cases. The gate refuses:
//   - a file under templates/ the manifest does not list, and a manifest
//     entry with no file (`checkManifestMatchesDisk`);
//   - a workflow entry with no registered values, and registered values for
//     anything but a workflow entry (`checkRegistryMatchesManifest`);
//   - values that do not match the template's placeholders (`render()`
//     throws on a missing or unused key, so values written for one template
//     cannot be registered against another);
//   - empty output, which would make every gate vacuous;
//   - a rendered variant that drops any placeholder-free line of the raw
//     template (`assertTemplateLinesRendered`), so a renderer that skips
//     part of the file cannot hide it from the gate;
//   - a placeholder that survives rendering (`assertFullyRendered`).
// The registry supplies values only, and its caller values come from
// `callerValues`, the function setup renders with, so the text the gates
// judge is the text setup writes. Every other manifest role is text setup
// copies or embeds; `templateExpressionViolations` scans it line by line.
// Adding a template therefore means listing it in the manifest and, for a
// workflow, registering its values here in the same PR, or the gate fails.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { PLACEHOLDER, render } from "../../scripts/lib/render.mjs";
import { TEMPLATE_MANIFEST, callerValues } from "../../scripts/setup/render-files.mjs";
import { callerArgs, loadFixture } from "../callers/render-caller.mjs";

const TEMPLATES_ROOT = "templates";

const callerVariant = (name, fixtureFile) => ({
  name,
  values: () => callerValues(callerArgs(loadFixture(new URL(`../fixtures/${fixtureFile}`, import.meta.url)))),
});

/** @type {Record<string, { name: string, values: () => Record<string, string> }[]>} */
export const REGISTRY = {
  "templates/callers/review.yml": [
    callerVariant("oauth, no boot workflow", "caller-values.json"),
    callerVariant("api-key, boot workflow", "caller-values-boot.json"),
  ],
};

/**
 * Every file under `root`, including dot entries, as repo-relative POSIX
 * paths, sorted. A directory tree is walked with `lstat`, so a symlink or any
 * other non-regular entry is refused rather than followed or skipped.
 * @param {string} [root]
 * @returns {string[]}
 * @throws {Error} on an entry that is neither a regular file nor a directory,
 *   or when `root` is not itself a real directory
 */
export function templateFilesOnDisk(root = TEMPLATES_ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`${path} is neither a regular file nor a directory; templates must be plain files`);
    }
  };
  if (!lstatSync(root).isDirectory()) throw new Error(`${root} is not a directory (a symlink to one does not count); templates must be plain files`);
  walk(root);
  return files.sort();
}

/**
 * @param {string[]} onDiskPaths
 * @param {readonly { path: string }[]} manifest
 * @throws {Error} when a file under templates/ is not listed in the manifest,
 *   or a listed file is not on disk
 */
export function checkManifestMatchesDisk(onDiskPaths, manifest) {
  const onDisk = new Set(onDiskPaths);
  const listed = new Set(manifest.map((item) => item.path));

  const unlisted = [...onDisk].filter((path) => !listed.has(path));
  if (unlisted.length > 0) {
    throw new Error(`templates/ holds files that TEMPLATE_MANIFEST (scripts/setup/render-files.mjs) does not list: ${unlisted.join(", ")}`);
  }
  const missing = [...listed].filter((path) => !onDisk.has(path));
  if (missing.length > 0) {
    throw new Error(`TEMPLATE_MANIFEST lists files that are not on disk: ${missing.join(", ")}`);
  }
}

/**
 * @param {readonly { path: string, role: string }[]} manifest
 * @param {Record<string, unknown[]>} registry
 * @throws {Error} when a workflow entry of the manifest has no registered
 *   values, or values are registered for a path that is not a workflow entry
 */
export function checkRegistryMatchesManifest(manifest, registry) {
  const workflows = new Set(manifest.filter((item) => item.role === "workflow").map((item) => item.path));
  const registered = new Set(Object.keys(registry));

  const missing = [...workflows].filter((path) => !registered.has(path));
  if (missing.length > 0) {
    throw new Error(`no values registered in tests/helpers/rendered-templates.mjs for: ${missing.join(", ")}`);
  }
  const stray = [...registered].filter((path) => !workflows.has(path));
  if (stray.length > 0) {
    throw new Error(`tests/helpers/rendered-templates.mjs registers values for a path the manifest does not list as a workflow: ${stray.join(", ")}`);
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
 * Every non-workflow manifest entry is text setup copies or embeds, never a
 * workflow to parse; a line holding an expression opener is a violation
 * (a shell fragment is a run body once inserted into a `run: |` step, and
 * nothing else has a reason to hold one).
 * @param {{
 *   manifest?: readonly { path: string, role: string }[],
 *   read?: (path: string) => string,
 * }} [deps] injectable for tests
 * @returns {string[]} one message per offending line
 */
export function templateExpressionViolations({
  manifest = TEMPLATE_MANIFEST,
  read = (path) => readFileSync(path, "utf8"),
} = {}) {
  const violations = [];
  for (const { path, role } of manifest) {
    if (role === "workflow") continue;
    read(path)
      .split(/\r\n|\r|\n/)
      .forEach((line, index) => {
        if (line.includes("${{")) violations.push(`${path}:${index + 1}: ${role} template line contains an expression`);
      });
  }
  return violations;
}

/**
 * @param {{
 *   manifest?: readonly { path: string, role: string }[],
 *   listFiles?: () => string[],
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
  manifest = TEMPLATE_MANIFEST,
  listFiles = templateFilesOnDisk,
  registry = REGISTRY,
  read = (path) => readFileSync(path, "utf8"),
  renderTemplate = render,
} = {}) {
  checkManifestMatchesDisk(listFiles(), manifest);
  checkRegistryMatchesManifest(manifest, registry);

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
