## Scope decision: criterion 5 dropped before scoring

The original scenario carried an eighth pass criterion, "every task names
exact verification commands." Two independent RED generations (this
attempt, and an adversarial-review reproduction of it) both passed that
criterion at baseline: the model volunteers concrete verification commands
unprompted, with no skill loaded at all. Per the pressure-test method's
already-passes rule ("If a criterion still passes in every attempt ...
drop or narrow that criterion in scenario.md; never claim GREEN on a
criterion the baseline already met"), the criterion is dropped rather than
strengthened: the prompt already asks for an implementation plan for a
concrete, mechanical change, and volunteering verification steps for such
a plan is a generic capability, not behavior this skill needs to install.
No further RED attempt was spent chasing a harder phrasing of it, since
doing so would test general plan-writing quality, not the PR-sequencing
behavior this skill teaches. `scenario.md` was updated to 7 pass criteria
before this record was written; the run below is against that final
7-criterion scenario.

## Attempt 1 (final scenario, 7 criteria)

CLI version: 2.1.284 (Claude Code)

Command:

```
claude -p --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" \
  --permission-mode plan --no-session-persistence "<the scenario prompt>"
```

Run directory held only `scripts/check-template-secrets.mjs` and
`.github/workflows/secret-scan.yml`.

Output (verbatim, ASCII-transcribed):

````
# Plan: `--json` output for `check-template-secrets.mjs` and a CI artifact upload

## Context
`scripts/check-template-secrets.mjs` currently reports violations only as human-readable lines on stderr. The goal is a machine-readable report: a `--json` flag that prints violations as a JSON array, and a step in `.github/workflows/secret-scan.yml` that uploads that JSON as a build artifact. This makes the results available to tooling and to reviewers without reading the logs.

**Constraint:** this repo is public, and artifacts can be downloaded by anyone with read access. Each violation is, by definition, a possible literal credential, so **the JSON must not contain the offending value**. It should only say where the violation is and which key it is.

## Files to change
- `scripts/check-template-secrets.mjs`
- `.github/workflows/secret-scan.yml`
- `scripts/check-template-secrets.test.mjs`: CI runs `node --test scripts/*.test.mjs`, but no test file is in this checkout. Extend it if it exists, otherwise create it.

## 1. Script changes (`scripts/check-template-secrets.mjs`)

**a. Split detection from formatting, keeping the existing export.**
- Move the scanning loop from `findTemplateSecretViolations` (lines 68-120) into a new exported `findTemplateSecretViolationRecords(content, filePath)`. It returns objects shaped `{ file, line, key, value }`.
- Rewrite `findTemplateSecretViolations` as a thin wrapper that maps records to the same message strings it produces today. Its signature and output stay the same, so existing callers and tests keep working.

**b. Add argv handling to `main`.**
- Change the signature to `main(cwd = process.cwd(), out = console, argv = process.argv.slice(2))`. This follows the existing injectable-parameters pattern used for testing.
- Set `const json = argv.includes("--json");`.
- Collect records (via `findTemplateSecretViolationRecords`) instead of strings. Keep all other behaviour the same.

**c. Output in `--json` mode.**
- Write exactly one thing to stdout: `JSON.stringify(violations, null, 2)` via `out.log`. Print nothing else to stdout, so `> file.json` always gives valid JSON.
- Each element has the form `{ "file": "templates/x.yml", "line": 12, "key": "API_TOKEN", "message": "credential-shaped key \"API_TOKEN\" is assigned a literal value, not an empty value or a ${{ secrets.X }} / ${{ inputs.X }} expression" }`. It deliberately leaves out `value`.
- If there are no violations, including the "no scan roots found" early return at line 149, print `[]`.
- Exit codes stay as they are: 0 for clean, 1 for violations. CI still fails the build.

**d. Non-JSON mode stays byte-for-byte the same.**

**e. Update the header comment (lines 8-9)** to document `--json` and say that the JSON leaves out the values.

## 2. Workflow changes (`.github/workflows/secret-scan.yml`)
Replace the last step (lines 48-52) with three steps:

```yaml
      - name: Test secret-scan scripts
        run: node --test scripts/*.test.mjs

      - name: Check copied templates never bake in a literal credential
        id: template-secrets
        run: |
          set -uo pipefail
          status=0
          node scripts/check-template-secrets.mjs --json > template-secret-violations.json || status=$?
          cat template-secret-violations.json
          exit "$status"

      - name: Upload template secret scan results
        if: ${{ !cancelled() && steps.template-secrets.outcome != 'skipped' }}
        uses: actions/upload-artifact@<full-commit-sha> # v4.x.y
        with:
          name: template-secret-violations
          path: template-secret-violations.json
          if-no-files-found: error
          retention-days: 14
```

Why it's written this way:
- **Tests in their own step:** a test failure is reported separately and doesn't hide the scan step.
- **Captured exit status:** the JSON is always written and printed to the log, and the step still fails when there are violations. The build gate is kept.
- **Upload condition:** the upload runs when the check fails. It is skipped when the check never ran (for example, gitleaks failed earlier), which avoids a "file not found" error on top of the real failure.
- **Pinning:** pin `actions/upload-artifact` to a full commit SHA with a version comment, matching how `checkout` and `setup-node` are pinned. Look up the current release's SHA when implementing; don't guess it.
- **Permissions:** no change needed. Artifact upload uses the runtime token, and `contents: read` is enough.

## 3. Tests (`scripts/check-template-secrets.test.mjs`)
Use `node:test` with a temp directory holding `.github/workflows/*.yml` fixtures. Pass a stub `out` object that collects `log` and `error` calls. Cover these cases:
1. **`findTemplateSecretViolationRecords`:** returns correct `file`, `line` and `key` for a hardcoded `API_TOKEN: abc`, and nothing for `${{ secrets.X }}` or empty values.
2. **`findTemplateSecretViolations`:** still returns the original string format (regression check).
3. **`main(dir, out, ["--json"])` with a violation:** returns 1. It makes exactly one `log` call, which `JSON.parse`s to a one-element array with the expected fields and **no `value` field**. The serialised output doesn't contain the literal secret. There are no `error` calls.
4. **`main(dir, out, ["--json"])` on a clean directory:** returns 0 and logs `[]`.
5. **`main(emptyDir, out, ["--json"])` with no scan roots:** returns 0 and logs `[]`.
6. **`main(dir, out, [])`:** gives the same text output as before.

## Verification
1. Run `node --test scripts/*.test.mjs` and check that all tests pass.
2. Run `node scripts/check-template-secrets.mjs --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'` on the repo and check it outputs `[]` and exits 0.
3. Add a temporary fixture `.github/workflows/tmp.yml` with `env:\n  API_TOKEN: hunter2`, then:
   - Run `--json` and check the exit code is 1, the output is valid JSON with one entry, and `hunter2` does not appear anywhere in the output.
   - Run without the flag and check the text output is unchanged.
   - Delete the fixture.
4. Open a PR and check the three steps run.
   - On a clean branch, the artifact `template-secret-violations` contains `[]`.
   - Push a throwaway commit with a violating fixture to a draft PR. The check step should fail, the artifact should still upload with the entry, and the job should end red. Drop the commit afterwards.

## Out of scope (worth a follow-up)
The existing text output (line 113) already prints the literal value into public CI logs. Consider redacting it there too, in a separate change, since that would change the current behaviour.
````

Pass criteria (final 7-criterion scenario):

1. FAIL. Organized as "Files to change" then numbered sections "1.", "2.",
   "3." by file/topic, never as a sequence of PR-scoped tasks. No task
   boundary anywhere reads as "this is one mergeable PR."
2. FAIL. Files are named, but grouped by file/topic across the whole
   change rather than partitioned per independently mergeable task.
3. FAIL. No line anywhere states a reason a part of this change is safe
   to merge alone; none of the four reason-phrases appear.
4. FAIL. Section "3. Tests" comes after "1. Script changes" and
   "2. Workflow changes" -- implementation is written before tests, and
   there is no task split for a tests-first order to apply within.
5. FAIL. No "wave" language, no disjoint-file grouping, no dependency
   ordering between parts of the plan.
6. FAIL. No model tier (smallest/middle/largest) is named anywhere.
7. FAIL. The plan never states that its own review fixes blockers only.

0 of 7 remaining criteria pass. As with the original 8-criterion baseline,
the model produces a competent, security-aware plan but not one shaped as
a sequence of independently deployable PRs -- the exact gap
`planning-deployable-pr-sequences` exists to close. One attempt is enough;
every remaining criterion already fails, so there is no need to strengthen
the scenario further.

## Rationalizations

Not applicable: `planning-deployable-pr-sequences` is an output-shaping
skill (positive recipe, no prohibitions), so there is no adversarial
pressure for the model to rationalize past. The baseline's gap is a
missing output shape, not a disciplinary lapse.
