// Design 6.5's gate fragment (`templates/blocks/gate-step.sh`), extracted
// from a rendered caller and executed with `bash`: exit 0 exactly when the
// review ran to `pass` or `override` (with every dependency succeeding), or
// the seat is a shadow seat (`ENFORCED` is `false`). Design 6.5 names
// eighteen combinations of `ALL_SUCCEEDED` in {true,false}, `STATUS` in
// {pass,fail-findings,override}, `ENFORCED` in {true,false,empty}; this
// suite covers the fuller cross product the brief specifies -- every
// `STATUS` value the gate can see, including one it should never receive
// (`empty`, an absent run) -- which supersedes the design's eighteen as the
// binding contract (63 = 3 x 7 x 3).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { parseYaml } from "../helpers/yaml.mjs";
import { gateScriptText, loadFixture, renderCaller } from "./render-caller.mjs";

const ALL_SUCCEEDED_VALUES = ["true", "false", ""];
const STATUS_VALUES = ["pass", "override", "fail-findings", "fail-coverage", "fail-config", "needs-maintainer", ""];
const ENFORCED_VALUES = ["true", "false", ""];

/**
 * @param {{ALL_SUCCEEDED: string, STATUS: string, ENFORCED: string}} env
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runGate(script, env) {
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      env: { ...isolatedEnv(), ...env },
      encoding: "utf8",
      timeout: 5000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function expectedExit(allSucceeded, status, enforced) {
  if (allSucceeded === "true" && (status === "pass" || status === "override")) return 0;
  if (enforced === "false") return 0;
  return 1;
}

test("the rendered gate's run: block equals the fragment file byte for byte", () => {
  const fixture = loadFixture(new URL("../fixtures/caller-values.json", import.meta.url));
  const rendered = renderCaller(fixture);
  const doc = parseYaml(rendered);
  const runBody = doc.jobs.gate.steps[0].run;
  assert.equal(runBody, gateScriptText());
});

test("the boot variant's rendered gate's run: block also equals the fragment file byte for byte", () => {
  const fixture = loadFixture(new URL("../fixtures/caller-values-boot.json", import.meta.url));
  const rendered = renderCaller(fixture);
  const doc = parseYaml(rendered);
  const runBody = doc.jobs.gate.steps[0].run;
  assert.equal(runBody, gateScriptText());
});

const SCRIPT = gateScriptText();

for (const ALL_SUCCEEDED of ALL_SUCCEEDED_VALUES) {
  for (const STATUS of STATUS_VALUES) {
    for (const ENFORCED of ENFORCED_VALUES) {
      const expected = expectedExit(ALL_SUCCEEDED, STATUS, ENFORCED);
      test(`ALL_SUCCEEDED=${JSON.stringify(ALL_SUCCEEDED)} STATUS=${JSON.stringify(STATUS)} ENFORCED=${JSON.stringify(ENFORCED)} exits ${expected}`, () => {
        const result = runGate(SCRIPT, { ALL_SUCCEEDED, STATUS, ENFORCED });
        assert.equal(result.status, expected);

        const statusText = STATUS === "" ? "none" : STATUS;
        const enforcedText = ENFORCED === "" ? "unknown" : ENFORCED;
        assert.ok(
          result.stdout.includes(`needs succeeded: ${ALL_SUCCEEDED}; status: ${statusText}; enforced: ${enforcedText}`),
          `expected the announce line in stdout, got: ${result.stdout}`,
        );

        if (expected === 0) {
          if (ALL_SUCCEEDED === "true" && (STATUS === "pass" || STATUS === "override")) {
            assert.ok(!result.stdout.includes("::warning::"), "a genuine pass must not also warn");
          } else {
            assert.ok(
              result.stdout.includes(`::warning::This check is in shadow mode. It would have failed with status '${statusText}'.`),
              `expected the shadow-mode warning, got: ${result.stdout}`,
            );
          }
        } else {
          assert.ok(
            result.stdout.includes(`::error::The check did not run to a pass (status '${statusText}')`),
            `expected the failure error line, got: ${result.stdout}`,
          );
          assert.ok(result.stdout.includes("gh run rerun <run-id>, without --failed"));
        }
      });
    }
  }
}

test("63 combinations were exercised", () => {
  assert.equal(ALL_SUCCEEDED_VALUES.length * STATUS_VALUES.length * ENFORCED_VALUES.length, 63);
});
