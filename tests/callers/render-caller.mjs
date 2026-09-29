// Renders `templates/callers/review.yml` for a fixture shaped like
// `tests/fixtures/caller-values.json`. There is no value-building logic
// here: the fixture is turned into the arguments setup itself passes
// (`callerArgs`) and rendering is `scripts/setup/render-files.mjs`, the one
// source of caller values, so the tests in this directory judge exactly what
// setup writes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCallerFile } from "../../scripts/setup/render-files.mjs";

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/callers/review.yml", import.meta.url));
const GATE_SCRIPT_PATH = fileURLToPath(new URL("../../templates/blocks/gate-step.sh", import.meta.url));

const AUTH_SECRET = { oauth: "CLAUDE_CODE_OAUTH_TOKEN", "api-key": "ANTHROPIC_API_KEY" };

/** @returns {string} */
export function gateScriptText() {
  return readFileSync(GATE_SCRIPT_PATH, "utf8");
}

/** @returns {string} */
export function templateText() {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

/**
 * The arguments of `callerValues` and `renderCallerFile` for a fixture: a
 * config that names only what the fixture sets (everything else takes the
 * schema's defaults), the pin it implies, the default branch and the gate
 * fragment's text.
 * @param {{auth: "oauth"|"api-key", boot: string|null, seat: string, default_branch: string, ship_kit_sha: string, ship_kit_version: string}} fixture
 * @returns {{config: object, seat: string, pin: {tag: string, sha: string, version: string}, defaultBranch: string, gateScript: string}}
 */
export function callerArgs(fixture) {
  const pin = { tag: `ship-kit--v${fixture.ship_kit_version}`, sha: fixture.ship_kit_sha, version: fixture.ship_kit_version };
  return {
    config: {
      schemaVersion: 1,
      shipKit: { version: pin.version, sha: pin.sha },
      render: {
        auth: { kind: fixture.auth, secret: AUTH_SECRET[fixture.auth] },
        bootWorkflow: fixture.boot ?? null,
        seats: [fixture.seat],
      },
    },
    seat: fixture.seat,
    pin,
    defaultBranch: fixture.default_branch,
    gateScript: gateScriptText(),
  };
}

/**
 * Renders the caller for a fixture with its real stamp, through the same
 * function setup uses.
 * @param {Parameters<typeof callerArgs>[0]} fixture
 * @returns {string}
 */
export function renderCaller(fixture) {
  return renderCallerFile({ template: templateText(), ...callerArgs(fixture) });
}

/**
 * @param {string | URL} path a fixture file path
 * @returns {object}
 */
export function loadFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
