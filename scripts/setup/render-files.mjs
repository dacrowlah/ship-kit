// Setup rendering (design 19.2, 19.3 step 5, 19.4, 19.6, 6.5, 9.3): turns the
// answers' config, the release pin and the repository's current files into
// the files setup would write. Nothing here touches the disk except reading
// templates from the plugin, and nothing is written until a later step shows
// the diff and the user approves it.
//
// Three rules keep what the tests gate identical to what setup writes:
//   - One caller value builder. `callerValues` is the only code that turns a
//     config into `<<key>>` values for the caller template; setup renders
//     through it and the test registry (tests/helpers/rendered-templates.mjs)
//     calls the very same function, so the values the gates judge are the
//     values setup writes.
//   - One manifest. `TEMPLATE_MANIFEST` lists every file under `templates/`
//     and setup reads a template only through `readTemplate`, which refuses a
//     name the manifest does not hold. The tests require the manifest to equal
//     the directory listing and every workflow entry to be in the registry, so
//     a template nobody listed cannot reach an adopter or slip past a gate.
//   - Every value passes through `render()`, which refuses an expression
//     opener, a control or line-break character, and any output with more
//     openers than its template. That keeps a value from adding an
//     expression of its own; it does not make a value safe in the template's
//     one expression position, `${{ secrets.<<secret>> }}`, where a value with
//     spaces or `||` would still be a live expression. There the config
//     schema is the guard (an upper-case identifier), and
//     tests/lib/config.test.mjs and this file's tests pin that.
// Values that land in YAML positions are checked before they are rendered.
// The config schema admits only check names, runner labels, secrets and boot
// paths that are plain scalars; the default branch is checked here, because
// it reaches a branch filter (where `+`, `!` and friends change the
// pattern's meaning) inside a flow sequence, so only names that are plain
// strings in both are accepted.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { PLACEHOLDER, render } from "../lib/render.mjs";
import { RELEASE_TAG } from "../lib/release-tags.mjs";
import { findManagedBlocks, formatStamp, renderManagedBlock, stampFile } from "../lib/stamp.mjs";

export class RenderFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderFilesError";
  }
}

export const CALLER_TEMPLATE = "callers/review.yml";
const GATE_TEMPLATE = "blocks/gate-step.sh";
const CONFIG_TEMPLATE = "files/config.json";
const CLAUDE_MD_TEMPLATE = "blocks/claude-md-workflow.md";
const GITIGNORE_TEMPLATE = "blocks/gitignore.txt";
const CODE_SEED_TEMPLATE = "files/hunt-list-code.md";
const DESIGN_SEED_TEMPLATE = "files/hunt-list-design.md";

export const CONFIG_PATH = ".ship-kit/config.json";
export const CLAUDE_MD_PATH = "CLAUDE.md";
export const GITIGNORE_PATH = ".gitignore";
export const SETTINGS_PATH = ".claude/settings.json";

/**
 * Whether the settings marketplace entry carries `ref`. The recorded live
 * observation (tests/live/extra-known-marketplaces.md) shows a github source's
 * `ref` is honoured: a missing ref fails to install and an existing one pins.
 * A test ties this constant to that record's verdict.
 */
export const SETTINGS_WITH_REF = true;

/**
 * How each template is used. `workflow` entries become GitHub Actions
 * workflows in an adopting repository and must be rendered and parsed by the
 * expression gate; `fragment` entries are pieces inserted into another
 * template; `block` entries become managed blocks inside a repository file;
 * `file` entries are rendered whole; `seed` entries are written only when the
 * destination does not exist.
 */
export const TEMPLATE_ROLES = Object.freeze(["workflow", "fragment", "block", "file", "seed"]);

const entry = (template, role, destination) =>
  Object.freeze({ template, path: `templates/${template}`, role, destination });

/** Every file under `templates/`, with what it becomes. */
export const TEMPLATE_MANIFEST = Object.freeze([
  entry(CALLER_TEMPLATE, "workflow", ".github/workflows/ship-kit-<seat>.yml"),
  entry(GATE_TEMPLATE, "fragment", null),
  entry(CLAUDE_MD_TEMPLATE, "block", CLAUDE_MD_PATH),
  entry(GITIGNORE_TEMPLATE, "block", GITIGNORE_PATH),
  entry(CONFIG_TEMPLATE, "file", CONFIG_PATH),
  entry(CODE_SEED_TEMPLATE, "seed", "review.huntLists.code"),
  entry(DESIGN_SEED_TEMPLATE, "seed", "review.huntLists.design"),
]);

const AUTH = Object.freeze({
  oauth: { input: "claude_code_oauth_token", text: "OAuth token for Claude Code" },
  "api-key": { input: "anthropic_api_key", text: "Anthropic API key" },
});

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;
// A default branch is written into `branches: [<name>]`: a branch filter,
// where `+`, `?`, `[`, `*` and a leading `!` are pattern syntax, inside a
// YAML flow sequence, where `,`, `]`, `#`, `&`, `*`, `!` and a leading digit
// or `-` change what the scalar is. Letters first, then the characters git
// branch names use most, keeps it a plain string in both.
const FILTER_SAFE_BRANCH = /^[A-Za-z][A-Za-z0-9._/-]*$/;
const YAML_WORD = /^(true|false|null|yes|no|on|off|y|n)$/i;
const RESERVED_ROOTS = new Set([".git", ".github", ".githooks", ".claude"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function show(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? JSON.stringify(value) : `a value of type ${typeof value}`;
}

/**
 * @param {unknown} pin
 * @returns {{tag: string, sha: string, version: string}} the validated pin
 */
function checkPin(pin) {
  if (!isPlainObject(pin)) throw new RenderFilesError("pin must be an object {tag, sha, version}");
  const { tag, sha, version } = pin;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new RenderFilesError(`pin.version ${show(version)} is not a release version`);
  }
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag) || tag !== `ship-kit--v${version}`) {
    throw new RenderFilesError(`pin.tag ${show(tag)} is not the release tag ship-kit--v${version}`);
  }
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw new RenderFilesError(`pin.sha ${show(sha)} is not a full commit SHA`);
  }
  return pin;
}

/**
 * Whether a default branch name can be written into the caller's branch
 * filter. Detection can ask this before it asks the user anything else.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isRenderableDefaultBranch(name) {
  return typeof name === "string" && FILTER_SAFE_BRANCH.test(name) && !YAML_WORD.test(name);
}

/**
 * @param {unknown} name
 * @returns {string} name, when it can be written into a branch filter
 * @throws {RenderFilesError} naming the rule, when it cannot
 */
export function checkDefaultBranch(name) {
  if (!isRenderableDefaultBranch(name)) {
    throw new RenderFilesError(
      `default branch ${show(name)} cannot be written into a branch filter: it must start with a letter, use only letters, digits, ".", "_", "-" and "/", and not read as a YAML keyword`,
    );
  }
  return name;
}

/**
 * @param {unknown} config
 * @returns {any} the config as `loadConfig` reads it (defaults filled)
 */
function validatedConfig(config) {
  let text;
  try {
    text = JSON.stringify(config);
  } catch (err) {
    throw new RenderFilesError(`config cannot be serialized: ${err.message}`);
  }
  const loaded = loadConfig(text);
  if (!loaded.ok) throw new RenderFilesError(`config is invalid: ${loaded.reason}`);
  return loaded.config;
}

/** @param {string} workflowPath @returns {string} the `boot` job block, ending in a blank line */
function bootJob(workflowPath) {
  return [
    "  boot:",
    `    uses: ${workflowPath}`,
    "    permissions:",
    "      contents: read",
    "    secrets: inherit",
    "",
  ].join("\n");
}

/**
 * The complete `<<key>>` values for `templates/callers/review.yml` (design
 * 6.5). The single place a config becomes caller values: setup and the test
 * registry both call it. `stamp_json` is a stub the file renderer replaces
 * with the real stamp.
 * @param {{config: object, seat: string, pin: {tag: string, sha: string, version: string}, defaultBranch: string, gateScript: string}} args
 *   `config` must validate and name `pin` as its `shipKit`; `seat` must be in
 *   `config.render.seats`
 * @returns {Record<string, string>}
 */
export function callerValues({ config, seat, pin, defaultBranch, gateScript }) {
  checkPin(pin);
  const loaded = validatedConfig(config);
  if (loaded.shipKit.version !== pin.version || loaded.shipKit.sha !== pin.sha) {
    throw new RenderFilesError("config.shipKit does not match the pin: a caller's pinned SHA must equal config.shipKit.sha");
  }
  if (!loaded.render.seats.includes(seat)) {
    throw new RenderFilesError(`seat ${show(seat)} is not in render.seats`);
  }
  checkDefaultBranch(defaultBranch);
  if (typeof gateScript !== "string" || gateScript.trim() === "") {
    throw new RenderFilesError("gateScript must be the gate fragment's text; an empty gate would pass everything");
  }
  const { auth, runners, bootWorkflow } = loaded.render;
  const hasBoot = bootWorkflow !== null;
  return {
    stamp_json: formatStamp({ template: CALLER_TEMPLATE, version: pin.version, sha: pin.sha, body: "0".repeat(64) }),
    secret: auth.secret,
    auth_text: AUTH[auth.kind].text,
    seat,
    default_branch: defaultBranch,
    boot_job: hasBoot ? bootJob(bootWorkflow) : "",
    review_needs: hasBoot ? "    needs: [boot]" : "",
    ship_kit_sha: pin.sha,
    ship_kit_version: pin.version,
    runners_json: JSON.stringify({ plan: runners.plan, seat: runners.seat, aggregate: runners.aggregate }),
    secret_input: AUTH[auth.kind].input,
    check_name: loaded.render.checks[seat],
    gate_needs: hasBoot ? "boot, review" : "review",
    gate_runner_json: JSON.stringify(runners.gate),
    gate_script: gateScript,
  };
}

/**
 * A caller rendered and stamped as a managed file (hash syntax).
 * @param {{template: string, config: object, seat: string, pin: {tag: string, sha: string, version: string}, defaultBranch: string, gateScript: string}} args
 *   `template` is the text of `templates/callers/review.yml`
 * @returns {string}
 */
export function renderCallerFile({ template, ...args }) {
  const values = callerValues(args);
  const rendered = render(template, values);
  const stampLine = `# ship-kit-managed: ${values.stamp_json}\n`;
  if (!rendered.startsWith(stampLine)) {
    throw new RenderFilesError("the caller template must open with its stamp line");
  }
  const meta = { template: CALLER_TEMPLATE, version: args.pin.version, sha: args.pin.sha };
  return stampFile(rendered.slice(stampLine.length), meta, "hash");
}

/**
 * Reads a template the manifest lists, with LF line endings whatever the
 * checkout did to them. Setup renders from the manifest only.
 * @param {string} pluginRoot directory holding `templates/`
 * @param {string} template a manifest entry's `template` name
 * @returns {string}
 */
export function readTemplate(pluginRoot, template) {
  const listed = TEMPLATE_MANIFEST.find((item) => item.template === template);
  if (listed === undefined) throw new RenderFilesError(`${template} is not in the template manifest`);
  return readFileSync(join(pluginRoot, listed.path), "utf8").replace(/\r\n/g, "\n");
}

/** @param {string} text @param {string} label */
function assertNoPlaceholders(text, label) {
  const left = [...text.matchAll(PLACEHOLDER)].map((match) => match[0]);
  if (left.length > 0) throw new RenderFilesError(`${label} holds unrendered placeholders: ${[...new Set(left)].join(", ")}`);
}

/**
 * @param {string} configTemplate the text of `templates/files/config.json`
 * @param {unknown} config the answers' config
 * @param {{sha: string, version: string}} pin
 * @returns {{text: string, config: any}} the file text and its validated form
 */
function renderConfig(configTemplate, config, pin) {
  if (!isPlainObject(config)) throw new RenderFilesError("config must be an object");
  const base = JSON.parse(render(configTemplate, { ship_kit_version: pin.version, ship_kit_sha: pin.sha }));
  const { schemaVersion, shipKit, ...rest } = config;
  if (schemaVersion !== undefined && schemaVersion !== base.schemaVersion) {
    throw new RenderFilesError(`config.schemaVersion ${show(schemaVersion)} is not ${base.schemaVersion}`);
  }
  const text = `${JSON.stringify({ schemaVersion: base.schemaVersion, shipKit: base.shipKit, ...rest }, null, 2)}\n`;
  const loaded = loadConfig(text);
  if (!loaded.ok) throw new RenderFilesError(`config is invalid: ${loaded.reason}`);
  return { text, config: loaded.config };
}

/**
 * Sets the ship-kit marketplace (replacing any entry of that name) and
 * enables the ship-kit plugin in a `.claude/settings.json`, declares the
 * claude-plugins-official marketplace unless the file already has an entry of
 * that name, and keeps every other key.
 * @param {string | null} existingText the current file, or null when absent
 * @param {{tag: string, sha: string, version: string}} pin
 * @param {{withRef: boolean}} options whether the ship-kit entry carries `ref`
 * @returns {string}
 */
export function mergeSettings(existingText, pin, { withRef }) {
  checkPin(pin);
  if (typeof withRef !== "boolean") throw new RenderFilesError("withRef must be a boolean");
  if (existingText !== null && typeof existingText !== "string") {
    throw new RenderFilesError("existing settings must be a string, or null when the file does not exist");
  }
  let settings = {};
  if (existingText !== null && existingText.trim() !== "") {
    try {
      settings = JSON.parse(existingText.startsWith("\uFEFF") ? existingText.slice(1) : existingText);
    } catch (err) {
      throw new RenderFilesError(`${SETTINGS_PATH} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(settings)) throw new RenderFilesError(`${SETTINGS_PATH} must hold a JSON object`);
  }
  const section = (key) => {
    const value = settings[key] ?? {};
    if (!isPlainObject(value)) throw new RenderFilesError(`${SETTINGS_PATH}: ${key} must be an object`);
    return value;
  };
  const marketplaces = section("extraKnownMarketplaces");
  const plugins = section("enabledPlugins");
  marketplaces["ship-kit"] = {
    source: { source: "github", repo: "dacrowlah/ship-kit", ...(withRef ? { ref: pin.tag } : {}) },
  };
  // Only declared so the superpowers dependency resolves; an entry the
  // adopter already has (a mirror, a ref, a sha) is theirs and stays.
  if (!Object.hasOwn(marketplaces, "claude-plugins-official")) {
    marketplaces["claude-plugins-official"] = {
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
    };
  }
  plugins["ship-kit@ship-kit"] = true;
  settings.extraKnownMarketplaces = marketplaces;
  settings.enabledPlugins = plugins;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// A line that looks like a marker (any case, any spacing after a list marker)
// must be exactly one, or the template is refused: a near miss kept as text
// would put a line of a later release into every older install.
const SINCE_START = /^\s*(?:(?:[-*+]|\d+\.)\s+)?\[since /i;
const SINCE_LINE = /^(\s*(?:(?:[-*+]|\d+\.) )?)\[since (\d+)\.(\d+)\.(\d+)\] (.*)$/;
const CORE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** @returns {number} negative, zero or positive as a is before, equal to or after b */
function compareCore(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The CLAUDE.md block body for an installing version (ruling 36). A line
 * marked `[since X.Y.Z] ` (after an optional list marker) is kept, marker
 * removed, only when the installing version is at least X.Y.Z; a release
 * candidate of X.Y.Z counts as X.Y.Z, since it carries that release's
 * features. Each marked line must stand alone on one line.
 * @param {string} templateText the text of `templates/blocks/claude-md-workflow.md`
 * @param {string} version the installing ship-kit version
 * @returns {string} the lines that belong between the block delimiters
 */
export function claudeMdBlock(templateText, version) {
  if (typeof templateText !== "string") throw new RenderFilesError("the claude-md template text must be a string");
  const parsed = typeof version === "string" ? CORE_VERSION.exec(version) : null;
  if (parsed === null) throw new RenderFilesError(`version ${show(version)} is not a ship-kit version`);
  const installing = parsed.slice(1, 4).map(Number);
  const kept = [];
  templateText.replace(/\r\n/g, "\n").split("\n").forEach((line, index) => {
    if (!SINCE_START.test(line)) {
      kept.push(line);
      return;
    }
    const marked = SINCE_LINE.exec(line);
    if (marked === null) throw new RenderFilesError(`claude-md template line ${index + 1} has a malformed [since X.Y.Z] marker`);
    const [, prefix, major, minor, patch, text] = marked;
    if (compareCore(installing, [major, minor, patch].map(Number)) >= 0) kept.push(`${prefix}${text}`);
  });
  const body = kept.join("\n");
  return body === "" || body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Puts a managed block into a file's text: replaces this template's block
 * when the file has one, otherwise appends it after a blank line.
 * @param {string | null} existing the file's current text, or null when absent
 * @param {string} block a rendered block (LF line endings, each line ending in a newline)
 * @param {string} template the block's template name, as stamped
 * @param {string} label the file's path, for messages
 * @returns {string}
 */
function withManagedBlock(existing, block, template, label) {
  if (existing === null || existing === "") return block;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const text = eol === "\n" ? block : block.replace(/\n/g, eol);
  let ours;
  try {
    ours = findManagedBlocks(existing).filter((found) => found.stamp.template === template);
  } catch (err) {
    throw new RenderFilesError(`${label}: ${err.message}`);
  }
  if (ours.length > 1) throw new RenderFilesError(`${label} holds ${ours.length} ${template} blocks; keep one`);
  if (ours.length === 1) {
    const lines = existing.split("\n");
    const before = lines.slice(0, ours[0].beginLine - 1).map((line) => `${line}\n`).join("");
    return before + text + lines.slice(ours[0].endLine).join("\n");
  }
  const separator = existing.endsWith("\n") ? "" : eol;
  return `${existing}${separator}${existing.trim() === "" ? "" : eol}${text}`;
}

/** @param {{files: Map<string, string | null>}} repo @param {string} path @returns {string | null} */
function currentFile(repo, path) {
  if (!repo.files.has(path)) {
    throw new RenderFilesError(`repo.files has no entry for ${path}; pass null for a file that does not exist`);
  }
  const value = repo.files.get(path);
  if (value !== null && typeof value !== "string") throw new RenderFilesError(`repo.files entry for ${path} must be a string or null`);
  return value;
}

/** @param {string} path @returns {string} path, when a seed may be written there */
function checkSeedPath(path) {
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => segment.endsWith("."))) {
    throw new RenderFilesError(`hunt list path ${show(path)} has a path segment ending in ".", which Windows reads as the segment without it`);
  }
  if (RESERVED_ROOTS.has(segments[0]) || segments.includes(".git")) {
    throw new RenderFilesError(`hunt list path ${show(path)} is inside a directory setup manages`);
  }
  return path;
}

/** @param {string[]} paths every path the install would write */
function assertDistinct(paths) {
  const seen = new Set();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) throw new RenderFilesError(`two installed files share the path ${path}`);
    seen.add(key);
  }
}

/**
 * Everything setup writes for an install.
 * @param {{config: object, pin: {tag: string, sha: string, version: string}, repo: {defaultBranch: string, claudeIgnored: boolean, files: Map<string, string | null>}, pluginRoot: string}} args
 *   `config` is the answers' config (its `shipKit` is replaced by the pin);
 *   `repo.files` maps each path setup needs to read (CLAUDE.md,
 *   .claude/settings.json, both hunt list paths, and .gitignore when
 *   `claudeIgnored`) to its current text, or null when it does not exist.
 *   `claudeIgnored` must be true whenever `.claude/` needs the block, and
 *   also when the file already holds our block: once the block is applied,
 *   `git check-ignore .claude/settings.json` reports "not ignored", so a
 *   caller that recomputes it that way must OR in "block present". A
 *   path missing from the map is refused, never read as absent. An existing
 *   managed block is replaced whatever its state: deciding whether a modified
 *   block may be replaced belongs to the caller.
 * @returns {Map<string, {content: string, kind: "managed-file" | "managed-block" | "user-owned" | "merge", template: string | null}>}
 */
export function renderInstall({ config, pin, repo, pluginRoot }) {
  checkPin(pin);
  if (!isPlainObject(repo) || !(repo.files instanceof Map) || typeof repo.claudeIgnored !== "boolean") {
    throw new RenderFilesError("repo must hold defaultBranch, claudeIgnored (boolean) and files (Map)");
  }
  const rendered = renderConfig(readTemplate(pluginRoot, CONFIG_TEMPLATE), config, pin);
  const loaded = rendered.config;
  const { code, design } = loaded.review.huntLists;
  const callerPaths = loaded.render.seats.map((seat) => `.github/workflows/ship-kit-${seat}.yml`);
  assertDistinct([
    CONFIG_PATH,
    ...callerPaths,
    checkSeedPath(code),
    checkSeedPath(design),
    CLAUDE_MD_PATH,
    SETTINGS_PATH,
    GITIGNORE_PATH,
  ]);

  const out = new Map();
  out.set(CONFIG_PATH, { content: rendered.text, kind: "user-owned", template: CONFIG_TEMPLATE });

  const callerTemplate = readTemplate(pluginRoot, CALLER_TEMPLATE);
  const gateScript = readTemplate(pluginRoot, GATE_TEMPLATE);
  loaded.render.seats.forEach((seat, index) => {
    const content = renderCallerFile({ template: callerTemplate, config: loaded, seat, pin, defaultBranch: repo.defaultBranch, gateScript });
    out.set(callerPaths[index], { content, kind: "managed-file", template: CALLER_TEMPLATE });
  });

  for (const [path, template] of [[code, CODE_SEED_TEMPLATE], [design, DESIGN_SEED_TEMPLATE]]) {
    if (currentFile(repo, path) !== null) continue;
    const content = readTemplate(pluginRoot, template);
    assertNoPlaceholders(content, template);
    out.set(path, { content, kind: "user-owned", template });
  }

  const meta = (template) => ({ template, version: pin.version, sha: pin.sha });
  const claudeMdBody = claudeMdBlock(readTemplate(pluginRoot, CLAUDE_MD_TEMPLATE), pin.version);
  assertNoPlaceholders(claudeMdBody, CLAUDE_MD_TEMPLATE);
  out.set(CLAUDE_MD_PATH, {
    content: withManagedBlock(currentFile(repo, CLAUDE_MD_PATH), renderManagedBlock(claudeMdBody, meta(CLAUDE_MD_TEMPLATE), "html"), CLAUDE_MD_TEMPLATE, CLAUDE_MD_PATH),
    kind: "managed-block",
    template: CLAUDE_MD_TEMPLATE,
  });

  out.set(SETTINGS_PATH, {
    content: mergeSettings(currentFile(repo, SETTINGS_PATH), pin, { withRef: SETTINGS_WITH_REF }),
    kind: "merge",
    template: null,
  });

  if (repo.claudeIgnored) {
    const body = readTemplate(pluginRoot, GITIGNORE_TEMPLATE);
    assertNoPlaceholders(body, GITIGNORE_TEMPLATE);
    out.set(GITIGNORE_PATH, {
      content: withManagedBlock(currentFile(repo, GITIGNORE_PATH), renderManagedBlock(body, meta(GITIGNORE_TEMPLATE), "hash"), GITIGNORE_TEMPLATE, GITIGNORE_PATH),
      kind: "managed-block",
      template: GITIGNORE_TEMPLATE,
    });
  }
  return out;
}
