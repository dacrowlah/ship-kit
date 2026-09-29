import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { loadConfig } from "../lib/config.mjs";
import { RenderError, render } from "../lib/render.mjs";
import { findManagedBlocks, readManagedFile, renderManagedBlock } from "../lib/stamp.mjs";
import { callerArgs, gateScriptText, loadFixture, renderCaller, templateText } from "../../tests/callers/render-caller.mjs";
import { checkHuntList } from "../../tests/hunt-lists/format.mjs";
import { REGISTRY, checkManifestMatchesDisk, templateFilesOnDisk } from "../../tests/helpers/rendered-templates.mjs";
import { yamlExpressionViolations } from "../../tests/helpers/run-bodies.mjs";
import { parseYaml } from "../../tests/helpers/yaml.mjs";
import {
  CALLER_TEMPLATE,
  RenderFilesError,
  SETTINGS_WITH_REF,
  TEMPLATE_MANIFEST,
  TEMPLATE_ROLES,
  callerValues,
  checkDefaultBranch,
  claudeMdBlock,
  isRenderableDefaultBranch,
  mergeSettings,
  readTemplate,
  renderCallerFile,
  renderInstall,
} from "./render-files.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PIN = { tag: "ship-kit--v0.2.0", sha: SHA_A, version: "0.2.0" };
const PIN_030 = { tag: "ship-kit--v0.3.0", sha: SHA_B, version: "0.3.0" };
const CODE_LIST = ".ship-kit/hunt-lists/code.md";
const DESIGN_LIST = ".ship-kit/hunt-lists/design.md";
const OPENER = "$" + "{{";

const fixture = (name) => loadFixture(new URL(`../../tests/fixtures/${name}`, import.meta.url));
const golden = (name) => readFileSync(join(REPO, "tests", "fixtures", "rendered-callers", name), "utf8");
const NO_BOOT = fixture("caller-values.json");
const BOOT = fixture("caller-values-boot.json");

/** The answers' config: no shipKit (setup sets it from the pin), everything else default. */
const answers = (extra = {}) => ({ schemaVersion: 1, ...extra });

/** A repo whose every file setup reads is absent, with the given files present. */
function repoOf(present = {}, { claudeIgnored = false, defaultBranch = "main" } = {}) {
  const files = new Map([
    ["CLAUDE.md", null],
    [".claude/settings.json", null],
    [CODE_LIST, null],
    [DESIGN_LIST, null],
    ...(claudeIgnored ? [[".gitignore", null]] : []),
  ]);
  for (const [path, text] of Object.entries(present)) files.set(path, text);
  return { defaultBranch, claudeIgnored, files };
}

const install = (over = {}) => renderInstall({ config: answers(), pin: PIN, repo: repoOf(), pluginRoot: REPO, ...over });
const content = (result, path) => result.get(path).content;

/** A copy of templates/ (the plugin root) with the given files replaced, removed by `done`. */
function withPluginRoot(replacements, body) {
  const root = mkdtempSync(join(tmpdir(), "ship-kit-plugin-"));
  try {
    cpSync(join(REPO, "templates"), join(root, "templates"), { recursive: true });
    for (const [path, text] of Object.entries(replacements)) writeFileSync(join(root, "templates", path), text);
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refused = (fn, pattern) => assert.throws(fn, (error) => error instanceof RenderFilesError && pattern.test(error.message), String(pattern));

// -- The manifest --------------------------------------------------------

test("every manifest entry names its file under templates/, one role of the allowed set, and appears once", () => {
  assert.ok(Object.isFrozen(TEMPLATE_MANIFEST));
  const seen = new Set();
  for (const item of TEMPLATE_MANIFEST) {
    assert.ok(Object.isFrozen(item));
    assert.equal(item.path, `templates/${item.template}`);
    assert.ok(TEMPLATE_ROLES.includes(item.role), `${item.template}: role ${item.role}`);
    assert.equal(seen.has(item.template), false, `${item.template} is listed twice`);
    seen.add(item.template);
  }
});

test("the manifest lists exactly the files under templates/", () => {
  checkManifestMatchesDisk(templateFilesOnDisk(), TEMPLATE_MANIFEST);
});

test("only workflow entries are destined for .github/, and every one is in the registry", () => {
  for (const item of TEMPLATE_MANIFEST) {
    const underGithub = item.destination !== null && item.destination.toLowerCase().startsWith(".github/");
    assert.equal(item.role === "workflow", underGithub, `${item.template}: role ${item.role}, destination ${item.destination}`);
    if (item.role === "workflow") {
      assert.ok(item.destination.startsWith(".github/workflows/"), item.template);
      assert.ok(Object.hasOwn(REGISTRY, item.path), `${item.path} is not in the registry`);
    }
  }
});

test("readTemplate reads a listed template and refuses a name the manifest does not hold", () => {
  assert.equal(readTemplate(REPO, "blocks/gate-step.sh"), gateScriptText());
  for (const name of ["callers/second.yml", "../package.json", "callers/../callers/review.yml", "/etc/passwd", "callers/Review.yml"]) {
    refused(() => readTemplate(REPO, name), /is not in the template manifest/);
  }
});

test("a template file with CRLF line endings is read as LF, so a Windows checkout renders the same files", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  const replacements = Object.fromEntries(
    TEMPLATE_MANIFEST.map((item) => [item.template, crlf(readFileSync(join(REPO, item.path), "utf8"))]),
  );
  withPluginRoot(replacements, (root) => {
    assert.equal(readTemplate(root, "blocks/gate-step.sh"), gateScriptText());
    const converted = install({ pluginRoot: root, repo: repoOf({}, { claudeIgnored: true }) });
    const original = install({ repo: repoOf({}, { claudeIgnored: true }) });
    assert.deepEqual([...converted], [...original]);
    for (const { content: text } of converted.values()) assert.equal(text.includes("\r"), false);
  });
});

test("a full install uses every manifest entry: no listed template is dead, and no output comes from an unlisted one", () => {
  const result = install({ config: answers({ render: { seats: ["general", "adversarial", "security", "test-integrity"] } }), repo: repoOf({}, { claudeIgnored: true }) });
  const used = new Set([...result.values()].map((item) => item.template).filter((template) => template !== null));
  const fragments = TEMPLATE_MANIFEST.filter((item) => item.role === "fragment").map((item) => item.template);
  assert.deepEqual([...used, ...fragments].sort(), TEMPLATE_MANIFEST.map((item) => item.template).sort());
  const workflowTemplates = new Set(TEMPLATE_MANIFEST.filter((item) => item.role === "workflow").map((item) => item.template));
  for (const [path, item] of result) {
    if (path.toLowerCase().startsWith(".github/")) assert.ok(workflowTemplates.has(item.template), `${path} is not rendered from a manifest workflow`);
  }
});

// -- The fixed live-record verdict ---------------------------------------

test("SETTINGS_WITH_REF follows the recorded live observation of whether extraKnownMarketplaces honours ref", () => {
  const record = readFileSync(join(REPO, "tests", "live", "extra-known-marketplaces.md"), "utf8");
  assert.equal(SETTINGS_WITH_REF, /F12 status: `Verified/.test(record));
});

// -- callerValues -------------------------------------------------------

const EXPECTED_NO_BOOT = {
  secret: "CLAUDE_CODE_OAUTH_TOKEN",
  auth_text: "OAuth token for Claude Code",
  seat: "general",
  default_branch: "main",
  boot_job: "",
  review_needs: "",
  ship_kit_sha: NO_BOOT.ship_kit_sha,
  ship_kit_version: "0.2.0",
  runners_json: '{"plan":["ubuntu-latest"],"seat":["ubuntu-latest"],"aggregate":["ubuntu-latest"]}',
  secret_input: "claude_code_oauth_token",
  check_name: "ship-kit general review",
  gate_needs: "review",
  gate_runner_json: '["ubuntu-latest"]',
};

test("callerValues for the oauth fixture holds exactly the template's keys with the expected values", () => {
  const values = callerValues(callerArgs(NO_BOOT));
  const { gate_script: gateScript, stamp_json: stamp, ...rest } = values;
  assert.deepEqual(rest, EXPECTED_NO_BOOT);
  assert.equal(gateScript, gateScriptText());
  assert.match(stamp, /^\{"template":"callers\/review\.yml","version":"0\.2\.0","sha":"a{40}","body":"0{64}"\}$/);
  // render() refuses a value the template does not use, so the key set is exactly the template's.
  assert.doesNotThrow(() => render(templateText(), values));
});

test("callerValues for the api-key fixture names the API key secret, its input, and a boot job with permissions and inherited secrets", () => {
  const values = callerValues(callerArgs(BOOT));
  assert.equal(values.secret, "ANTHROPIC_API_KEY");
  assert.equal(values.auth_text, "Anthropic API key");
  assert.equal(values.secret_input, "anthropic_api_key");
  assert.equal(values.check_name, "ship-kit adversarial review");
  assert.equal(values.gate_needs, "boot, review");
  assert.equal(values.review_needs, "    needs: [boot]");
  assert.equal(values.boot_job, "  boot:\n    uses: ./.github/workflows/boot.yml\n    permissions:\n      contents: read\n    secrets: inherit\n");
});

test("callerValues follows the config: boot path, runners, secret name and check name", () => {
  const args = callerArgs(NO_BOOT);
  args.config.render = {
    ...args.config.render,
    bootWorkflow: "./.github/workflows/start-runners.yaml",
    runners: { plan: ["self-hosted", "linux"], seat: ["big-runner"], aggregate: ["ubuntu-24.04"], gate: ["macos-latest"] },
    auth: { kind: "oauth", secret: "MY_TOKEN" },
    checks: { general: "Review (general)" },
  };
  const values = callerValues(args);
  assert.match(values.boot_job, /^ {4}uses: \.\/\.github\/workflows\/start-runners\.yaml$/m);
  assert.equal(values.runners_json, '{"plan":["self-hosted","linux"],"seat":["big-runner"],"aggregate":["ubuntu-24.04"]}');
  assert.equal(values.gate_runner_json, '["macos-latest"]');
  assert.equal(values.secret, "MY_TOKEN");
  assert.equal(values.check_name, "Review (general)");
});

test("callerValues takes the check name of the seat it renders", () => {
  const args = callerArgs({ ...NO_BOOT, seat: "test-integrity" });
  assert.equal(callerValues(args).check_name, "ship-kit test-integrity review");
});

test("callerValues refuses a pin that is not a release pin", () => {
  const args = callerArgs(NO_BOOT);
  for (const pin of [
    null,
    "0.2.0",
    { ...PIN, version: "0.2" },
    { ...PIN, version: 2 },
    { ...PIN, version: "00.2.0" },
    { ...PIN, tag: "ship-kit--v0.3.0" },
    { ...PIN, tag: "v0.2.0" },
    { ...PIN, tag: undefined },
    { ...PIN, sha: "a".repeat(39) },
    { ...PIN, sha: "A".repeat(40) },
    { ...PIN, sha: undefined },
  ]) {
    refused(() => callerValues({ ...args, pin }), /pin/);
  }
});

test("callerValues accepts a release candidate pin", () => {
  const pin = { tag: "ship-kit--v0.3.0-rc.1", sha: SHA_A, version: "0.3.0-rc.1" };
  const args = callerArgs({ ...NO_BOOT, ship_kit_version: "0.3.0-rc.1" });
  assert.equal(callerValues({ ...args, pin }).ship_kit_version, "0.3.0-rc.1");
});

test("callerValues refuses a config that names a different pin than the caller will", () => {
  const args = callerArgs(NO_BOOT);
  refused(() => callerValues({ ...args, pin: { ...PIN, sha: SHA_B } }), /config\.shipKit does not match the pin/);
  refused(() => callerValues({ ...args, pin: PIN_030 }), /config\.shipKit does not match the pin/);
});

test("callerValues refuses a config that does not validate, and one that cannot be serialized", () => {
  const args = callerArgs(NO_BOOT);
  refused(() => callerValues({ ...args, config: { ...args.config, render: { auth: { kind: "password" } } } }), /config is invalid/);
  refused(() => callerValues({ ...args, config: { ...args.config, render: { runners: { plan: ["a b"] } } } }), /config is invalid/);
  refused(() => callerValues({ ...args, config: undefined }), /config is invalid/);
  refused(() => callerValues({ ...args, config: { ...args.config, big: 1n } }), /cannot be serialized/);
});

test("callerValues refuses a seat the config does not render", () => {
  const args = callerArgs(NO_BOOT);
  for (const seat of ["adversarial", "security", "nobody", "", undefined, ["general"]]) {
    refused(() => callerValues({ ...args, seat }), /is not in render\.seats/);
  }
});

test("callerValues refuses a gate script that is empty or not text", () => {
  const args = callerArgs(NO_BOOT);
  for (const gateScript of ["", "  \n\n", undefined, null, 5]) {
    refused(() => callerValues({ ...args, gateScript }), /gateScript must be the gate fragment's text/);
  }
});

// The default branch reaches `branches: [<name>]`, a filter pattern where `+`,
// `?`, `*`, `[` and a leading `!` are syntax, inside a YAML flow sequence.
const REFUSED_BRANCHES = [
  "",
  "+dev",
  "a+b",
  "!main",
  "main!",
  "*",
  "feature/*",
  "**",
  "ma?n",
  "[abc]",
  "a]b",
  "a,b",
  "a b",
  "a\nb",
  "main\n",
  "#main",
  "a#b",
  "&anchor",
  "*alias",
  "{x}",
  "'quoted'",
  '"quoted"',
  "a:b",
  "a|b",
  "a>b",
  "a@{b}",
  "a`b`",
  "a$b",
  `x${OPENER} github.head_ref }}`,
  `${OPENER} github.head_ref }}`,
  "-main",
  "/main",
  ".hidden",
  "~x",
  "123",
  "1.x",
  "true",
  "False",
  "null",
  "NULL",
  "yes",
  "No",
  "on",
  "OFF",
  "y",
  "N",
  "caf\u00e9",
  undefined,
  null,
  5,
  ["main"],
];

for (const branch of REFUSED_BRANCHES) {
  test(`callerValues refuses the default branch ${JSON.stringify(branch)}`, () => {
    refused(() => callerValues({ ...callerArgs(NO_BOOT), defaultBranch: branch }), /default branch .* cannot be written into a branch filter/);
  });
}

const ACCEPTED_BRANCHES = ["main", "master", "trunk", "develop", "release/1.x", "v2", "feature_x-2", "a.b-c", "Release/2024.1", "users/ada/topic", "yesterday", "nullable", "no-op", "on/off"];

for (const branch of ACCEPTED_BRANCHES) {
  test(`the default branch ${JSON.stringify(branch)} renders into branches: unchanged, inside the YAML subset the gate parses`, () => {
    const rendered = renderCallerFile({ template: templateText(), ...callerArgs(NO_BOOT), defaultBranch: branch });
    assert.deepEqual(parseYaml(rendered).on.pull_request_target.branches, [branch]);
    assert.deepEqual(yamlExpressionViolations(rendered).filter((body) => body.text.includes(OPENER)), []);
  });
}

// The config schema admits exactly the check names the caller can write as a
// plain scalar; the renderer relies on it rather than repeating the rule.
test("callerValues refuses a check name that would not survive YAML as written", () => {
  for (const name of ["ship-kit review ", "1st review", "true", "No", "9", "y", "NULL"]) {
    const args = callerArgs(NO_BOOT);
    args.config.render.checks = { general: name };
    refused(() => callerValues(args), /config is invalid: .*\/render\/checks\/general must match pattern/);
  }
});

test("callerValues refuses a secret name that is an expression, not an identifier", () => {
  for (const secret of ["X || github.event.pull_request.title", "X || GITHUB.EVENT.PULL_REQUEST.TITLE", "X }}", "X Y", "GITHUB_TOKEN"]) {
    const args = callerArgs(NO_BOOT);
    args.config.render.auth = { kind: "oauth", secret };
    refused(() => callerValues(args), /config is invalid: .*\/render\/auth\/secret must match pattern/);
  }
});

// API-key auth must name its secret: the loader's default secret belongs to
// the OAuth kind, and pairing it with an API key sends the wrong credential.
test("api-key auth without a secret is refused, never rendered with the OAuth secret", () => {
  for (const auth of [{ kind: "api-key" }, { kind: "oauth" }, { secret: "ANTHROPIC_API_KEY" }]) {
    const args = callerArgs(NO_BOOT);
    args.config.render.auth = auth;
    refused(() => callerValues(args), /config is invalid: .*\/render\/auth\/(secret|kind) is required/);
    refused(() => install({ config: answers({ render: { auth } }) }), /config is invalid: .*\/render\/auth\/(secret|kind) is required/);
  }
});

test("api-key auth with its secret renders the API key input and secret, in the header and the call", () => {
  const config = answers({ render: { auth: { kind: "api-key", secret: "ANTHROPIC_API_KEY" }, seats: ["general"] } });
  const file = content(install({ config }), ".github/workflows/ship-kit-general.yml");
  assert.ok(file.includes("# Requires the repository secret ANTHROPIC_API_KEY (Anthropic API key).\n"));
  assert.ok(file.includes("      anthropic_api_key: $" + "{{ secrets.ANTHROPIC_API_KEY }}\n"));
  assert.equal(file.includes("CLAUDE_CODE_OAUTH_TOKEN"), false);
  assert.equal(file.includes("claude_code_oauth_token"), false);
});

test("the default auth is the OAuth kind with its own secret", () => {
  const file = content(install({ config: answers({ render: { seats: ["general"] } }) }), ".github/workflows/ship-kit-general.yml");
  assert.ok(file.includes("# Requires the repository secret CLAUDE_CODE_OAUTH_TOKEN (OAuth token for Claude Code).\n"));
  assert.ok(file.includes("      claude_code_oauth_token: $" + "{{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n"));
});

// -- the default branch check, exported for detection ------------------------

test("checkDefaultBranch returns an accepted name and throws the setup error for a refused one", () => {
  for (const branch of ACCEPTED_BRANCHES) assert.equal(checkDefaultBranch(branch), branch);
  for (const branch of REFUSED_BRANCHES) refused(() => checkDefaultBranch(branch), /default branch .* cannot be written into a branch filter/);
});

test("isRenderableDefaultBranch answers the same question without throwing", () => {
  for (const branch of ACCEPTED_BRANCHES) assert.equal(isRenderableDefaultBranch(branch), true, branch);
  for (const branch of REFUSED_BRANCHES) assert.equal(isRenderableDefaultBranch(branch), false, String(branch));
});

// -- renderCallerFile -----------------------------------------------------

test("a rendered caller equals the original render of its fixture byte for byte", () => {
  assert.equal(renderCaller(NO_BOOT), golden("ship-kit-general.yml"));
  assert.equal(renderCaller(BOOT), golden("ship-kit-adversarial.yml"));
});

test("a rendered caller reads as a current managed file stamped with its template, version and pin", () => {
  for (const [fixtureValues, pinSha] of [[NO_BOOT, NO_BOOT.ship_kit_sha], [BOOT, BOOT.ship_kit_sha]]) {
    const managed = readManagedFile(renderCaller(fixtureValues));
    assert.equal(managed.bodyMatches, true);
    assert.deepEqual({ ...managed.stamp, body: undefined }, { template: CALLER_TEMPLATE, version: "0.2.0", sha: pinSha, body: undefined });
  }
});

test("renderCallerFile refuses a template that does not open with its stamp line", () => {
  const args = callerArgs(NO_BOOT);
  const moved = `# extra\n${templateText()}`;
  refused(() => renderCallerFile({ template: moved, ...args }), /must open with its stamp line/);
  const lost = templateText().split("\n").slice(1).join("\n");
  assert.throws(
    () => renderCallerFile({ template: lost, ...args }),
    (error) => error instanceof RenderError && error.message.includes("<<stamp_json>>"),
  );
});

test("renderCallerFile refuses a gate script that carries an expression, however it is written", () => {
  const args = callerArgs(NO_BOOT);
  assert.throws(
    () => renderCallerFile({ template: templateText(), ...args, gateScript: `${gateScriptText()}echo ${OPENER} github.event.pull_request.title }}\n` }),
    (error) => error instanceof RenderError && error.message.includes("<<gate_script>>"),
  );
});

// -- renderInstall: the path set ------------------------------------------

test("a fresh install writes the config, one caller per seat, both seeds, the CLAUDE.md block and the settings, in that order", () => {
  const result = install();
  assert.deepEqual(
    [...result].map(([path, item]) => [path, item.kind, item.template]),
    [
      [".ship-kit/config.json", "user-owned", "files/config.json"],
      [".github/workflows/ship-kit-general.yml", "managed-file", "callers/review.yml"],
      [".github/workflows/ship-kit-adversarial.yml", "managed-file", "callers/review.yml"],
      [CODE_LIST, "user-owned", "files/hunt-list-code.md"],
      [DESIGN_LIST, "user-owned", "files/hunt-list-design.md"],
      ["CLAUDE.md", "managed-block", "blocks/claude-md-workflow.md"],
      [".claude/settings.json", "merge", null],
    ],
  );
});

test("a repository whose .claude/ is ignored also gets the .gitignore block, last", () => {
  const result = install({ repo: repoOf({}, { claudeIgnored: true }) });
  assert.deepEqual([...result.keys()].at(-1), ".gitignore");
  assert.deepEqual([result.get(".gitignore").kind, result.get(".gitignore").template], ["managed-block", "blocks/gitignore.txt"]);
  assert.equal(install().has(".gitignore"), false);
});

test("the seats setup renders follow render.seats", () => {
  const result = install({ config: answers({ render: { seats: ["security"] } }) });
  const callers = [...result.keys()].filter((path) => path.toLowerCase().startsWith(".github/"));
  assert.deepEqual(callers, [".github/workflows/ship-kit-security.yml"]);
  assert.equal(parseYaml(content(result, callers[0])).jobs.gate.name, "ship-kit security review");
});

test("each caller reads as a current managed file, and equals the original fixture render byte for byte", () => {
  for (const [fixtureValues, name] of [[NO_BOOT, "ship-kit-general.yml"], [BOOT, "ship-kit-adversarial.yml"]]) {
    const args = callerArgs(fixtureValues);
    const result = renderInstall({ config: args.config, pin: args.pin, repo: repoOf({}, { defaultBranch: fixtureValues.default_branch }), pluginRoot: REPO });
    const file = content(result, `.github/workflows/${name}`);
    assert.equal(file, golden(name));
    const managed = readManagedFile(file);
    assert.equal(managed.bodyMatches, true);
    assert.equal(managed.stamp.template, "callers/review.yml");
  }
});

test("the caller body the registry's values produce is the caller body setup writes", () => {
  const variants = REGISTRY["templates/callers/review.yml"];
  assert.deepEqual(variants.map((variant) => variant.name).length, 2);
  for (const [variant, fixtureValues] of [[variants[0], NO_BOOT], [variants[1], BOOT]]) {
    const args = callerArgs(fixtureValues);
    const written = content(
      renderInstall({ config: args.config, pin: args.pin, repo: repoOf({}, { defaultBranch: fixtureValues.default_branch }), pluginRoot: REPO }),
      `.github/workflows/ship-kit-${fixtureValues.seat}.yml`,
    );
    const gated = render(templateText(), variant.values());
    assert.equal(written.split("\n").slice(1).join("\n"), gated.split("\n").slice(1).join("\n"));
  }
});

test("every rendered caller parses in the YAML subset and holds no expression in a run body", () => {
  const result = install({ config: answers({ render: { seats: ["general", "adversarial", "security", "test-integrity"], bootWorkflow: "./.github/workflows/boot.yml" } }) });
  for (const [path, item] of result) {
    if (item.kind !== "managed-file") continue;
    assert.ok(parseYaml(item.content), path);
    assert.deepEqual(yamlExpressionViolations(item.content).filter((body) => body.text.includes(OPENER)), [], path);
  }
});

test("the install renders from the given pin: callers, config and settings all carry it", () => {
  const result = install({ pin: PIN_030 });
  for (const path of [".github/workflows/ship-kit-general.yml", ".github/workflows/ship-kit-adversarial.yml"]) {
    const file = content(result, path);
    assert.ok(file.includes(`review.yml@${SHA_B} # ship-kit--v0.3.0`));
    assert.equal(readManagedFile(file).stamp.version, "0.3.0");
  }
  assert.equal(JSON.parse(content(result, ".ship-kit/config.json")).shipKit.sha, SHA_B);
  assert.equal(JSON.parse(content(result, ".claude/settings.json")).extraKnownMarketplaces["ship-kit"].source.ref, "ship-kit--v0.3.0");
});

// -- renderInstall: the config -------------------------------------------

test("the config is the answers' config with shipKit set to the pin, and it validates with loadConfig", () => {
  const given = answers({
    shipKit: { version: "0.0.1", sha: SHA_B },
    render: { auth: { kind: "api-key", secret: "ANTHROPIC_API_KEY" }, seats: ["general"] },
    review: { specDirs: ["docs/specs/"], planDirs: ["docs/plans/"] },
  });
  const file = content(install({ config: given }), ".ship-kit/config.json");
  const parsed = JSON.parse(file);
  assert.deepEqual(parsed.shipKit, { version: "0.2.0", sha: SHA_A });
  assert.deepEqual(parsed.render, given.render);
  assert.deepEqual(parsed.review, given.review);
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "shipKit", "render", "review"]);
  assert.ok(file.endsWith("}\n"));
  const loaded = loadConfig(file);
  assert.equal(loaded.ok, true, loaded.reason);
});

test("the config carries no body stamp: it is user data", () => {
  const file = content(install(), ".ship-kit/config.json");
  assert.equal(readManagedFile(file), null);
  assert.deepEqual(findManagedBlocks(file), []);
});

test("an answers config without a schemaVersion still yields one, and a different one is refused", () => {
  assert.equal(JSON.parse(content(install({ config: {} }), ".ship-kit/config.json")).schemaVersion, 1);
  refused(() => install({ config: { schemaVersion: 2 } }), /config\.schemaVersion 2 is not 1/);
  refused(() => install({ config: { schemaVersion: "1" } }), /config\.schemaVersion "1" is not 1/);
});

test("a config that is not an object or does not validate is refused", () => {
  for (const config of [null, [], "x", 5]) refused(() => install({ config }), /config must be an object/);
  refused(() => install({ config: answers({ render: { auth: { kind: "password" } } }) }), /config is invalid/);
  refused(() => install({ config: answers({ nonsense: true }) }), /config is invalid/);
});

// Loose protection is the default: setup's strict question lives in the
// answers file, never the config, so the config schema is unchanged and the
// rendered config can neither carry the answer nor turn admin merge on.
test("the strict answer is not a config key: a config carrying it is refused, and defaults keep admin merge off", () => {
  refused(() => install({ config: answers({ strict: true }) }), /config is invalid/);
  refused(() => install({ config: answers({ agents: { strict: true } }) }), /config is invalid/);
  refused(() => install({ config: answers({ render: { strict: true } }) }), /config is invalid/);
  const file = content(install(), ".ship-kit/config.json");
  assert.equal(file.includes("strict"), false);
  assert.equal(file.includes("adminMerge"), false);
  assert.equal(loadConfig(file).config.agents.adminMerge, false);
});

test("the config is refused when the pin is not a release pin", () => {
  refused(() => install({ pin: { ...PIN, tag: "ship-kit--v9.9.9" } }), /pin\.tag/);
  refused(() => install({ pin: null }), /pin must be an object/);
});

// -- renderInstall: seeds ---------------------------------------------------

test("seeds are written when absent, follow the format checker, and point at the format", () => {
  const result = install();
  const code = content(result, CODE_LIST);
  const design = content(result, DESIGN_LIST);
  assert.deepEqual(checkHuntList(code, { prefix: "R", shared: false }), []);
  assert.deepEqual(checkHuntList(design, { prefix: "RD", shared: false }), []);
  for (const seed of [code, design]) {
    assert.ok(seed.includes("Format: see the ship-kit plugin's `skills/mining-defect-shapes/hunt-list-format.md`.\n"));
  }
});

test("a seed already present is not rendered, whatever it holds, and the other is still written", () => {
  for (const present of ["", "# mine\n", "x"]) {
    const noCode = install({ repo: repoOf({ [CODE_LIST]: present }) });
    assert.equal(noCode.has(CODE_LIST), false);
    assert.equal(noCode.has(DESIGN_LIST), true);
    const noDesign = install({ repo: repoOf({ [DESIGN_LIST]: present }) });
    assert.equal(noDesign.has(DESIGN_LIST), false);
    assert.equal(noDesign.has(CODE_LIST), true);
  }
  const neither = install({ repo: repoOf({ [CODE_LIST]: "a", [DESIGN_LIST]: "b" }) });
  assert.deepEqual([...neither.keys()].filter((path) => path.includes("hunt-lists")), []);
});

test("seeds are written to the hunt list paths the config names", () => {
  const config = answers({ review: { huntLists: { code: "tools/lists/code.md", design: "tools/lists/design.md" } } });
  const repo = repoOf();
  repo.files.set("tools/lists/code.md", null);
  repo.files.set("tools/lists/design.md", null);
  const result = install({ config, repo });
  assert.equal(result.has("tools/lists/code.md"), true);
  assert.equal(result.has("tools/lists/design.md"), true);
  assert.equal(result.has(CODE_LIST), false);
});

test("a hunt list path that would land on another installed file, or inside a directory setup manages, is refused", () => {
  const collide = (huntLists) => install({ config: answers({ review: { huntLists } }), repo: repoOf({ ".ship-kit/config.json": null, ...Object.fromEntries(Object.values(huntLists).map((path) => [path, null])) }) });
  for (const path of [".ship-kit/config.json", "CLAUDE.md", "claude.md", ".claude/settings.json", ".gitignore", ".github/workflows/ship-kit-general.yml"]) {
    assert.throws(() => collide({ code: path }), RenderFilesError, path);
  }
  refused(() => collide({ code: "same.md", design: "same.md" }), /share the path same\.md/);
  refused(() => collide({ code: "Same.md", design: "same.md" }), /share the path same\.md/);
  for (const path of [".git/hooks/pre-push", ".GIT/config", ".github/notes.md", ".githooks/list.md", ".claude/list.md", "docs/.git/list.md"]) {
    refused(() => collide({ code: path }), /is inside a directory setup manages/);
  }
});

// Windows drops a trailing dot from a path segment, so `.git./hooks/x` is
// `.git/hooks/x` there and `CLAUDE.md.` is `CLAUDE.md`.
test("a hunt list path with a segment ending in a dot is refused", () => {
  const collide = (path) => install({ config: answers({ review: { huntLists: { code: path } } }), repo: repoOf({ [path]: null }) });
  for (const path of [".git./hooks/pre-push", ".github./workflows/x.yml", ".claude./settings.json", ".githooks./x.md", "CLAUDE.md.", "docs./list.md", "a./b./c.md", ".ship-kit/config.json."]) {
    refused(() => collide(path), /has a path segment ending in "\."/);
  }
  assert.doesNotThrow(() => collide("docs/list.v1.md"));
});

test("a seed template that holds an unrendered placeholder is refused", () => {
  withPluginRoot({ "files/hunt-list-code.md": "# List\n\nFormat: <<format_path>>\n\n## Shapes\n\nNone yet.\n" }, (root) => {
    refused(() => install({ pluginRoot: root }), /unrendered placeholders: <<format_path>>/);
  });
  withPluginRoot({ "files/hunt-list-design.md": "<<title>>\n" }, (root) => {
    refused(() => install({ pluginRoot: root }), /unrendered placeholders: <<title>>/);
  });
});

// -- renderInstall: the repository's files -----------------------------------

test("a path setup needs that is missing from repo.files is refused, never read as absent", () => {
  for (const path of ["CLAUDE.md", ".claude/settings.json", CODE_LIST, DESIGN_LIST]) {
    const repo = repoOf();
    repo.files.delete(path);
    refused(() => install({ repo }), /repo\.files has no entry for/);
  }
  const ignored = repoOf({}, { claudeIgnored: true });
  ignored.files.delete(".gitignore");
  refused(() => install({ repo: ignored }), /repo\.files has no entry for \.gitignore/);
});

test("a repo.files entry that is neither text nor null is refused", () => {
  for (const value of [undefined, 5, {}, ["a"]]) {
    refused(() => install({ repo: repoOf({ "CLAUDE.md": value }) }), /must be a string or null/);
  }
});

test("a repo that is not shaped as documented is refused", () => {
  for (const repo of [null, {}, { files: {}, claudeIgnored: false }, { files: new Map(), claudeIgnored: "yes" }, { files: new Map() }]) {
    refused(() => install({ repo }), /repo must hold/);
  }
});

// -- CLAUDE.md and .gitignore blocks --------------------------------------

const BLOCK_TEMPLATE = "blocks/claude-md-workflow.md";
const claudeBlocks = (text) => findManagedBlocks(text).filter((block) => block.stamp.template === BLOCK_TEMPLATE);

test("a CLAUDE.md that does not exist becomes just the managed block, stamped in html syntax", () => {
  const file = content(install(), "CLAUDE.md");
  assert.ok(file.startsWith("<!-- ship-kit-managed-begin {"));
  assert.ok(file.endsWith("<!-- ship-kit-managed-end -->\n"));
  const [block] = claudeBlocks(file);
  assert.deepEqual([block.stamp.version, block.stamp.sha, block.bodyMatches], ["0.2.0", SHA_A, true]);
});

test("an empty CLAUDE.md becomes just the block", () => {
  assert.equal(content(install({ repo: repoOf({ "CLAUDE.md": "" }) }), "CLAUDE.md"), content(install(), "CLAUDE.md"));
});

test("the block is appended after the existing text and a blank line, whatever its ending", () => {
  const block = content(install(), "CLAUDE.md");
  for (const [existing, joined] of [
    ["# Project\n", "# Project\n\n"],
    ["# Project", "# Project\n\n"],
    ["# Project\n\n", "# Project\n\n\n"],
    ["\n", "\n"],
    ["   ", "   \n"],
  ]) {
    assert.equal(content(install({ repo: repoOf({ "CLAUDE.md": existing }) }), "CLAUDE.md"), joined + block, JSON.stringify(existing));
  }
});

test("an existing block is replaced in place and the text around it is kept", () => {
  const stale = renderManagedBlock("old line\n", { template: BLOCK_TEMPLATE, version: "0.1.0", sha: SHA_B }, "html");
  const existing = `# Project\n\nintro\n\n${stale}\nfooter\n`;
  const file = content(install({ repo: repoOf({ "CLAUDE.md": existing }) }), "CLAUDE.md");
  const fresh = content(install(), "CLAUDE.md");
  assert.equal(file, `# Project\n\nintro\n\n${fresh}\nfooter\n`);
  assert.equal(claudeBlocks(file).length, 1);
});

test("a block that ends the file without a newline is replaced and the file ends with one", () => {
  const stale = renderManagedBlock("old line\n", { template: BLOCK_TEMPLATE, version: "0.1.0", sha: SHA_B }, "html").slice(0, -1);
  const file = content(install({ repo: repoOf({ "CLAUDE.md": `top\n${stale}` }) }), "CLAUDE.md");
  assert.equal(file, `top\n${content(install(), "CLAUDE.md")}`);
});

test("rendering over its own output changes nothing: the CLAUDE.md and settings and .gitignore are stable", () => {
  const first = install({ repo: repoOf({}, { claudeIgnored: true }) });
  const again = install({
    repo: repoOf({ "CLAUDE.md": content(first, "CLAUDE.md"), ".claude/settings.json": content(first, ".claude/settings.json"), ".gitignore": content(first, ".gitignore") }, { claudeIgnored: true }),
  });
  for (const path of ["CLAUDE.md", ".claude/settings.json", ".gitignore"]) assert.equal(content(again, path), content(first, path), path);
});

test("an upgrade replaces the older block with the newer one and keeps the surrounding text", () => {
  const first = content(install(), "CLAUDE.md");
  const upgraded = content(install({ pin: PIN_030, repo: repoOf({ "CLAUDE.md": `# T\n\n${first}\nend\n` }) }), "CLAUDE.md");
  assert.ok(upgraded.startsWith("# T\n\n"));
  assert.ok(upgraded.endsWith("\nend\n"));
  const [block] = claudeBlocks(upgraded);
  assert.equal(block.stamp.version, "0.3.0");
  assert.ok(block.body.includes("/ship-kit:develop"));
});

test("a file with two of our blocks, a nested block, or an unterminated one is refused, not rewritten", () => {
  const one = content(install(), "CLAUDE.md");
  refused(() => install({ repo: repoOf({ "CLAUDE.md": `${one}\n${one}` }) }), /holds 2 blocks\/claude-md-workflow\.md blocks/);
  const begin = one.split("\n")[0];
  refused(() => install({ repo: repoOf({ "CLAUDE.md": `${begin}\nbody\n` }) }), /CLAUDE\.md: .* has no end/);
  refused(() => install({ repo: repoOf({ "CLAUDE.md": "<!-- ship-kit-managed-end -->\n" }) }), /CLAUDE\.md: .* without a begin/);
});

test("a block of another template in the file is left alone and ours is still added", () => {
  const other = renderManagedBlock("other\n", { template: "blocks/other.md", version: "0.2.0", sha: SHA_A }, "html");
  const file = content(install({ repo: repoOf({ "CLAUDE.md": other }) }), "CLAUDE.md");
  assert.ok(file.startsWith(other));
  assert.equal(findManagedBlocks(file).length, 2);
});

test("a CRLF file keeps CRLF line endings around and inside the block, and its block still reads as unmodified", () => {
  const crlf = "# Project\r\n\r\ntext\r\n";
  const appended = content(install({ repo: repoOf({ "CLAUDE.md": crlf }) }), "CLAUDE.md");
  assert.equal(appended.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(claudeBlocks(appended)[0].bodyMatches, true);
  const replaced = content(install({ pin: PIN_030, repo: repoOf({ "CLAUDE.md": appended }) }), "CLAUDE.md");
  assert.equal(replaced.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(claudeBlocks(replaced)[0].stamp.version, "0.3.0");
  assert.equal(claudeBlocks(replaced)[0].bodyMatches, true);
});

test("a CLAUDE.md template with an unrendered placeholder or a malformed marker is refused", () => {
  withPluginRoot({ "blocks/claude-md-workflow.md": "- Use <<tool>>.\n" }, (root) => {
    refused(() => install({ pluginRoot: root }), /unrendered placeholders: <<tool>>/);
  });
  withPluginRoot({ "blocks/claude-md-workflow.md": "- [since 0.3] Use it.\n" }, (root) => {
    refused(() => install({ pluginRoot: root }), /malformed \[since X\.Y\.Z\] marker/);
  });
  withPluginRoot({ "blocks/gitignore.txt": "<<line>>\n" }, (root) => {
    refused(() => install({ pluginRoot: root, repo: repoOf({}, { claudeIgnored: true }) }), /unrendered placeholders: <<line>>/);
  });
});

test("a caller template whose stamp line is missing or not first is refused by the install", () => {
  withPluginRoot({ "callers/review.yml": `# extra\n${templateText()}` }, (root) => {
    refused(() => install({ pluginRoot: root }), /must open with its stamp line/);
  });
  withPluginRoot({ "callers/review.yml": templateText().split("\n").slice(1).join("\n") }, (root) => {
    assert.throws(() => install({ pluginRoot: root }), RenderError);
  });
});

// -- claudeMdBlock ------------------------------------------------------------

const SINCE_LINES = [
  "- [since 0.3.0] Start every change with `/ship-kit:develop`.",
  "- [since 0.3.0] Run preflight before every push",
  "- [since 0.3.0] After cloning, run `git config core.hooksPath .githooks`",
];

test("the real template at 0.2.0 omits the three 0.3.0 lines and keeps the rest, markers stripped", () => {
  const template = readTemplate(REPO, BLOCK_TEMPLATE);
  const marked = template.split("\n").filter((line) => line.includes("[since 0.3.0] "));
  assert.equal(marked.length, 3);
  assert.ok(marked[0].startsWith("- [since 0.3.0] Start every change with `/ship-kit:develop`"));
  assert.ok(marked[1].startsWith("- [since 0.3.0] Run preflight before every push"));
  assert.ok(marked[2].startsWith("- [since 0.3.0] After cloning, run `git config core.hooksPath .githooks`"));

  const block = claudeMdBlock(template, "0.2.0");
  assert.equal(block.includes("[since"), false);
  assert.equal(block.includes("/ship-kit:develop"), false);
  assert.equal(block.includes("preflight"), false);
  assert.equal(block.includes("core.hooksPath"), false);
  const kept = template.split("\n").filter((line) => line !== "" && !line.includes("[since 0.3.0] "));
  assert.deepEqual(block.split("\n").filter((line) => line !== ""), kept);
});

test("the folder-trust note is unmarked, so every version renders it", () => {
  const template = readTemplate(REPO, BLOCK_TEMPLATE);
  const note = template.split("\n").find((line) => line.includes("trust this folder"));
  assert.ok(note && !note.includes("[since"));
  for (const version of ["0.1.0", "0.2.0", "0.3.0", "1.0.0"]) assert.ok(claudeMdBlock(template, version).includes(note), version);
});

test("the real template at 0.3.0 keeps all three lines with their markers removed", () => {
  const template = readTemplate(REPO, BLOCK_TEMPLATE);
  const block = claudeMdBlock(template, "0.3.0");
  assert.equal(block.includes("[since"), false);
  assert.ok(block.includes("- Start every change with `/ship-kit:develop`.\n"));
  assert.ok(block.includes("- Run preflight before every push"));
  assert.ok(block.includes("core.hooksPath .githooks"));
  assert.equal(block.split("\n").length, template.split("\n").length);
});

test("a release candidate of X.Y.Z renders the X.Y.Z lines, and a later version renders all earlier ones", () => {
  const template = "- always\n- [since 0.3.0] three\n- [since 0.10.0] ten\n- [since 1.0.0] one\n";
  assert.equal(claudeMdBlock(template, "0.3.0-rc.1"), "- always\n- three\n");
  assert.equal(claudeMdBlock(template, "0.2.9"), "- always\n");
  assert.equal(claudeMdBlock(template, "0.9.9"), "- always\n- three\n");
  assert.equal(claudeMdBlock(template, "0.10.0"), "- always\n- three\n- ten\n");
  assert.equal(claudeMdBlock(template, "1.0.0"), "- always\n- three\n- ten\n- one\n");
  assert.equal(claudeMdBlock(template, "10.0.0"), "- always\n- three\n- ten\n- one\n");
});

test("markers work after any list marker or none, and only at the start of a line", () => {
  const template = [
    "[since 0.3.0] bare",
    "* [since 0.3.0] star",
    "+ [since 0.3.0] plus",
    "1. [since 0.3.0] numbered",
    "  - [since 0.3.0] nested",
    "a note about the [since 0.3.0] marker stays as written",
    "",
  ].join("\n");
  assert.equal(claudeMdBlock(template, "0.3.0"), ["bare", "* star", "+ plus", "1. numbered", "  - nested", "a note about the [since 0.3.0] marker stays as written", ""].join("\n"));
  assert.equal(claudeMdBlock(template, "0.2.0"), "a note about the [since 0.3.0] marker stays as written\n");
});

test("a marker that is nearly right is refused rather than kept as text: case, spacing, tabs", () => {
  for (const line of ["- [Since 0.3.0] case", "[SINCE 0.3.0] case", "-  [since 0.3.0] two spaces", "-\t[since 0.3.0] tab", "1.  [since 0.3.0] numbered"]) {
    refused(() => claudeMdBlock(`ok\n${line}\n`, "0.3.0"), /line 2 has a malformed \[since X\.Y\.Z\] marker/);
    refused(() => claudeMdBlock(`ok\n${line}\n`, "0.2.0"), /line 2 has a malformed \[since X\.Y\.Z\] marker/);
  }
});

test("an indented marker without a list marker is a marker", () => {
  assert.equal(claudeMdBlock("  [since 0.3.0] indented\n", "0.3.0"), "  indented\n");
  assert.equal(claudeMdBlock("  [since 0.3.0] indented\n", "0.2.0"), "");
});

test("a malformed marker line is refused with its line number", () => {
  for (const line of ["- [since 0.3] short", "- [since v0.3.0] prefixed", "- [since 0.3.0]no space", "- [since 0.3.0]", "[since ] empty", "- [since 0.3.0-rc.1] prerelease"]) {
    refused(() => claudeMdBlock(`ok\n${line}\n`, "0.3.0"), /line 2 has a malformed \[since X\.Y\.Z\] marker/);
  }
});

test("claudeMdBlock normalizes CRLF, adds a final newline, and returns nothing when every line is dropped", () => {
  assert.equal(claudeMdBlock("- a\r\n- [since 0.3.0] b\r\n- c", "0.2.0"), "- a\n- c\n");
  assert.equal(claudeMdBlock("- [since 0.3.0] b\n", "0.2.0"), "");
  assert.equal(claudeMdBlock("", "0.2.0"), "");
});

test("claudeMdBlock refuses a version or template that is not text in the expected shape", () => {
  for (const version of ["0.2", "v0.2.0", "", undefined, 2, "0.2.0.1", "0.2.0-"]) {
    refused(() => claudeMdBlock("- a\n", version), /is not a ship-kit version/);
  }
  refused(() => claudeMdBlock(undefined, "0.2.0"), /must be a string/);
});

test("the installing version decides the block setup writes", () => {
  const at020 = claudeBlocks(content(install(), "CLAUDE.md"))[0].body;
  const at030 = claudeBlocks(content(install({ pin: PIN_030 }), "CLAUDE.md"))[0].body;
  for (const line of SINCE_LINES) {
    assert.equal(at020.includes(line.replace("[since 0.3.0] ", "").slice(0, 30)), false, line);
    assert.equal(at030.includes(line.replace("[since 0.3.0] ", "").slice(0, 30)), true, line);
  }
});

// -- mergeSettings --------------------------------------------------------------

const SHIP_KIT_SOURCE = { source: { source: "github", repo: "dacrowlah/ship-kit", ref: "ship-kit--v0.2.0" } };
const OFFICIAL_SOURCE = { source: { source: "github", repo: "anthropics/claude-plugins-official" } };

test("settings that do not exist become the two marketplaces and the enabled plugin", () => {
  for (const existing of [null, "", "  \n"]) {
    assert.deepEqual(JSON.parse(mergeSettings(existing, PIN, { withRef: true })), {
      extraKnownMarketplaces: { "ship-kit": SHIP_KIT_SOURCE, "claude-plugins-official": OFFICIAL_SOURCE },
      enabledPlugins: { "ship-kit@ship-kit": true },
    });
  }
  assert.ok(mergeSettings(null, PIN, { withRef: true }).endsWith("}\n"));
});

test("unrelated keys, marketplaces and plugins are kept, in their order", () => {
  const existing = JSON.stringify({
    model: "x",
    permissions: { allow: ["Bash(git status)"] },
    extraKnownMarketplaces: { mine: { source: { source: "github", repo: "me/mine" } } },
    enabledPlugins: { "mine@mine": true, "off@mine": false },
  });
  const merged = JSON.parse(mergeSettings(existing, PIN, { withRef: true }));
  assert.deepEqual(Object.keys(merged), ["model", "permissions", "extraKnownMarketplaces", "enabledPlugins"]);
  assert.deepEqual(merged.permissions, { allow: ["Bash(git status)"] });
  assert.deepEqual(Object.keys(merged.extraKnownMarketplaces), ["mine", "ship-kit", "claude-plugins-official"]);
  assert.deepEqual(merged.enabledPlugins, { "mine@mine": true, "off@mine": false, "ship-kit@ship-kit": true });
});

// The ship-kit entry is the pin setup owns; claude-plugins-official is only
// declared so the superpowers dependency resolves, so an entry the adopter
// already has (their own mirror, ref or sha) is theirs and stays as written.
test("an existing claude-plugins-official entry is left as the user wrote it, whatever its shape", () => {
  for (const entry of [
    { source: { source: "github", repo: "anthropics/claude-plugins-official", ref: "stable", sha: SHA_B }, autoUpdate: false },
    { source: { source: "git", url: "https://mirror.example.invalid/claude-plugins-official.git" } },
    "custom",
    null,
  ]) {
    const existing = JSON.stringify({ extraKnownMarketplaces: { "claude-plugins-official": entry } });
    const merged = JSON.parse(mergeSettings(existing, PIN, { withRef: true }));
    assert.deepEqual(merged.extraKnownMarketplaces["claude-plugins-official"], entry);
    assert.deepEqual(merged.extraKnownMarketplaces["ship-kit"], SHIP_KIT_SOURCE);
    assert.deepEqual(Object.keys(merged.extraKnownMarketplaces), ["claude-plugins-official", "ship-kit"]);
  }
});

test("an existing ship-kit entry is replaced whole, so no stale ref or sha lingers, and a disabled plugin is enabled", () => {
  const existing = JSON.stringify({
    extraKnownMarketplaces: { "ship-kit": { source: { source: "github", repo: "old/fork", ref: "old", sha: SHA_B }, autoUpdate: true } },
    enabledPlugins: { "ship-kit@ship-kit": false },
  });
  const merged = JSON.parse(mergeSettings(existing, PIN_030, { withRef: true }));
  assert.deepEqual(merged.extraKnownMarketplaces["ship-kit"], { source: { source: "github", repo: "dacrowlah/ship-kit", ref: "ship-kit--v0.3.0" } });
  assert.equal(merged.enabledPlugins["ship-kit@ship-kit"], true);
});

test("withRef false writes no ref, and removes one that was there", () => {
  assert.deepEqual(JSON.parse(mergeSettings(null, PIN, { withRef: false })).extraKnownMarketplaces["ship-kit"], {
    source: { source: "github", repo: "dacrowlah/ship-kit" },
  });
  const pinned = mergeSettings(null, PIN, { withRef: true });
  assert.equal(JSON.parse(mergeSettings(pinned, PIN, { withRef: false })).extraKnownMarketplaces["ship-kit"].source.ref, undefined);
  assert.equal(mergeSettings(null, PIN, { withRef: false }).includes("ref"), false);
});

test("merging twice gives the same file, and the install merges with the ref the live record allows", () => {
  const once = mergeSettings('{"a":1}', PIN, { withRef: true });
  assert.equal(mergeSettings(once, PIN, { withRef: true }), once);
  const installed = content(install(), ".claude/settings.json");
  assert.equal(installed, mergeSettings(null, PIN, { withRef: SETTINGS_WITH_REF }));
});

test("settings that are not valid JSON, not an object, or hold a section of the wrong type are refused, never overwritten", () => {
  for (const bad of ["{", "not json", "[]", "null", "5", '"text"', '{"extraKnownMarketplaces": []}', '{"extraKnownMarketplaces": "x"}', '{"enabledPlugins": []}', '{"enabledPlugins": 3}']) {
    refused(() => mergeSettings(bad, PIN, { withRef: true }), /\.claude\/settings\.json/);
  }
  refused(() => mergeSettings(5, PIN, { withRef: true }), /must be a string, or null/);
  refused(() => mergeSettings(undefined, PIN, { withRef: true }), /must be a string, or null/);
});

test("settings with a leading byte-order mark are read", () => {
  const merged = JSON.parse(mergeSettings('\uFEFF{"keep": true}', PIN, { withRef: true }));
  assert.equal(merged.keep, true);
});

test("a null section is treated as absent, and withRef must be a boolean", () => {
  const merged = JSON.parse(mergeSettings('{"enabledPlugins": null}', PIN, { withRef: true }));
  assert.deepEqual(merged.enabledPlugins, { "ship-kit@ship-kit": true });
  for (const withRef of [undefined, "true", 1, null]) refused(() => mergeSettings(null, PIN, { withRef }), /withRef must be a boolean/);
  refused(() => mergeSettings(null, { ...PIN, tag: "x" }, { withRef: true }), /pin\.tag/);
});

// -- .gitignore: git decides ----------------------------------------------------

function git(dir, args, extraConfig = []) {
  return spawnSync("git", [...extraConfig.flatMap((entry) => ["-c", entry]), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...isolatedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Exit 0 when git ignores `path`, 1 when it does not. */
function ignored(dir, path, config) {
  const result = git(dir, ["check-ignore", "-q", "--", path], config);
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
  return result.status === 0;
}

function withIgnoreFixture(gitignore, body) {
  const dir = mkdtempSync(join(tmpdir(), "ship-kit-ignore-"));
  try {
    assert.equal(git(dir, ["init", "-q"]).status, 0);
    const globalExcludes = join(dir, "..", `${dir.split("/").pop()}-excludes`);
    writeFileSync(globalExcludes, ".claude/\n");
    mkdirSync(join(dir, ".claude", "skills", "x"), { recursive: true });
    for (const file of [".claude/settings.json", ".claude/other", ".claude/skills/x/SKILL.md"]) writeFileSync(join(dir, file), "{}\n");
    if (gitignore !== null) writeFileSync(join(dir, ".gitignore"), gitignore);
    try {
      return body(dir, [`core.excludesFile=${globalExcludes}`]);
    } finally {
      rmSync(globalExcludes, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with .claude/ ignored by a global-style line, the applied block un-ignores settings.json only", () => {
  withIgnoreFixture(null, (dir, config) => {
    assert.equal(ignored(dir, ".claude/settings.json", config), true, "the fixture must start with settings.json ignored");
    const result = install({ repo: repoOf({}, { claudeIgnored: true }) });
    writeFileSync(join(dir, ".gitignore"), content(result, ".gitignore"));
    assert.equal(ignored(dir, ".claude/settings.json", config), false);
    assert.equal(ignored(dir, ".claude/other", config), true);
    assert.equal(ignored(dir, ".claude/skills/x/SKILL.md", config), true);
  });
});

test("with .claude/ ignored by the repository's own .gitignore, the block appended after it un-ignores settings.json only", () => {
  const existing = "node_modules/\n.claude/\ndist/\n";
  withIgnoreFixture(existing, (dir) => {
    assert.equal(ignored(dir, ".claude/settings.json"), true, "the fixture must start with settings.json ignored");
    const result = install({ repo: repoOf({ ".gitignore": existing }, { claudeIgnored: true }) });
    const file = content(result, ".gitignore");
    assert.ok(file.startsWith(existing));
    writeFileSync(join(dir, ".gitignore"), file);
    assert.equal(ignored(dir, ".claude/settings.json"), false);
    assert.equal(ignored(dir, ".claude/other"), true);
    assert.equal(ignored(dir, "node_modules/x.js"), true);
  });
});

test("the .gitignore block is a hash-syntax managed block holding the three negation lines, replaced in place on the next render", () => {
  const file = content(install({ repo: repoOf({ ".gitignore": "a\n" }, { claudeIgnored: true }) }), ".gitignore");
  const [block] = findManagedBlocks(file);
  assert.equal(block.stamp.template, "blocks/gitignore.txt");
  assert.equal(block.body, "!.claude/\n.claude/*\n!.claude/settings.json\n");
  assert.equal(block.bodyMatches, true);
  assert.ok(file.includes("# ship-kit-managed-begin {"));
  const later = content(install({ pin: PIN_030, repo: repoOf({ ".gitignore": `${file}b\n` }, { claudeIgnored: true }) }), ".gitignore");
  assert.equal(findManagedBlocks(later).length, 1);
  assert.equal(findManagedBlocks(later)[0].stamp.version, "0.3.0");
  assert.ok(later.startsWith("a\n\n# ship-kit-managed-begin"));
  assert.ok(later.endsWith("b\n"));
});
