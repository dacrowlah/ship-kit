// Builds the `<<key>>` values map for `templates/callers/review.yml` from a
// fixture shaped like `tests/fixtures/caller-values.json`, and renders it.
// The derived values are computed the same way setup (Task 25) will: this
// helper is the one place both this task's tests and a future setup
// implementation can compare against.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "../../scripts/lib/render.mjs";
import { formatStamp, stampFile } from "../../scripts/lib/stamp.mjs";

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/callers/review.yml", import.meta.url));
const GATE_SCRIPT_PATH = fileURLToPath(new URL("../../templates/blocks/gate-step.sh", import.meta.url));
export const TEMPLATE_META_PATH = "callers/review.yml";

const AUTH = {
  oauth: { secret: "CLAUDE_CODE_OAUTH_TOKEN", secretInput: "claude_code_oauth_token", text: "OAuth token for Claude Code" },
  "api-key": { secret: "ANTHROPIC_API_KEY", secretInput: "anthropic_api_key", text: "Anthropic API key" },
};

const BOOT_JOB = [
  "  boot:",
  "    uses: ./.github/workflows/boot.yml",
  "    permissions:",
  "      contents: read",
  "    secrets: inherit",
  "",
].join("\n");

/** @returns {string} */
export function gateScriptText() {
  return readFileSync(GATE_SCRIPT_PATH, "utf8");
}

/** @returns {string} */
export function templateText() {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

/**
 * @param {{auth: "oauth"|"api-key", boot: string|null, seat: string, default_branch: string, ship_kit_sha: string, ship_kit_version: string}} fixture
 * @returns {Record<string, string>} the full `<<key>>` values map, everything except `stamp_json`
 */
export function buildValues(fixture) {
  const auth = AUTH[fixture.auth];
  if (!auth) throw new Error(`unknown auth kind: ${fixture.auth}`);
  const hasBoot = fixture.boot !== null && fixture.boot !== undefined;
  if (hasBoot && fixture.boot !== "./.github/workflows/boot.yml") {
    throw new Error(`unsupported boot path in fixture: ${fixture.boot}`);
  }
  return {
    secret: auth.secret,
    auth_text: auth.text,
    seat: fixture.seat,
    default_branch: fixture.default_branch,
    boot_job: hasBoot ? BOOT_JOB : "",
    review_needs: hasBoot ? "    needs: [boot]" : "",
    ship_kit_sha: fixture.ship_kit_sha,
    ship_kit_version: fixture.ship_kit_version,
    runners_json: JSON.stringify({ plan: ["ubuntu-latest"], seat: ["ubuntu-latest"], aggregate: ["ubuntu-latest"] }),
    secret_input: auth.secretInput,
    check_name: `ship-kit ${fixture.seat} review`,
    gate_needs: hasBoot ? "boot, review" : "review",
    gate_runner_json: JSON.stringify(["ubuntu-latest"]),
    gate_script: gateScriptText(),
  };
}

/**
 * The complete `<<key>>` values map for a fixture, with `stamp_json` set to
 * a valid stub stamp. A stub is enough wherever the rendered text is only
 * inspected (a stamp line never holds a `run:`); `renderCaller` replaces it
 * with the real stamp.
 * @param {{auth: "oauth"|"api-key", boot: string|null, seat: string, default_branch: string, ship_kit_sha: string, ship_kit_version: string}} fixture
 * @returns {Record<string, string>}
 */
export function callerValues(fixture) {
  const stubStamp = formatStamp({
    template: TEMPLATE_META_PATH,
    version: fixture.ship_kit_version,
    sha: "0".repeat(40),
    body: "0".repeat(64),
  });
  return { ...buildValues(fixture), stamp_json: stubStamp };
}

/**
 * Renders the caller for a fixture, with a correctly stamped first line: the
 * template is rendered once with a stub `stamp_json`, then `stampFile`
 * recomputes the real stamp over the rendered body, exactly as
 * `stampFile`'s own contract requires (it recomputes its stub internally, so
 * the stub used for the first pass never appears in the result).
 * @param {{auth: "oauth"|"api-key", boot: string|null, seat: string, default_branch: string, ship_kit_sha: string, ship_kit_version: string}} fixture
 * @returns {string}
 */
export function renderCaller(fixture) {
  const stubRendered = render(templateText(), callerValues(fixture));
  const firstNewline = stubRendered.indexOf("\n");
  const body = stubRendered.slice(firstNewline + 1);
  const meta = { template: TEMPLATE_META_PATH, version: fixture.ship_kit_version, sha: fixture.ship_kit_sha };
  return stampFile(body, meta, "hash");
}

/**
 * @param {string} path a fixture file path
 * @returns {object}
 */
export function loadFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
