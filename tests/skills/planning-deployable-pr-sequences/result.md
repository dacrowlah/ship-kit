## Scope decision (see baseline.md)

The original scenario's criterion 5 ("every task names exact verification
commands") passed at baseline in two independent RED reproductions, so
per the pressure-test method's already-passes rule it was dropped rather
than credited to the skill. `scenario.md` now carries 7 pass criteria; the
headline below counts only those 7, all of which the baseline failed and
all of which the corrected GREEN run passes: **RED 0/7, GREEN 7/7;
criterion 5 (verification commands) met at baseline, dropped.**

## Deviation from the standard GREEN setup

The staged plugin copy's `.claude-plugin/plugin.json` declares a
`superpowers@claude-plugins-official` dependency. With `--setting-sources
""` no plugin is installed, so the dependency is unsatisfied and the
staged `ship-kit` plugin as a whole is dropped: an uncorrected GREEN
attempt showed `"plugin_errors": [{"plugin": "ship-kit@inline", "type":
"dependency-unsatisfied", ...}]` in the `system/init` message, 0 skills
invoked, and an output identical in shape to the RED baseline -- GREEN
would have silently equalled RED.

Fix, applied only to the staged copy at `$PLUG` (never to the repository
worktree): delete the `dependencies` key from
`$PLUG/.claude-plugin/plugin.json` before running GREEN. The run below
uses `--output-format stream-json --verbose` so the `system/init`
message's `plugins` array can be asserted before recording the result;
it lists `{"name": "ship-kit", ..., "source": "ship-kit@inline"}` with no
`plugin_errors`, and the assistant's first tool call is `Skill` with
`"skill": "ship-kit:planning-deployable-pr-sequences"`.

## GREEN run (final, 7-criterion scenario)

CLI version: 2.1.284 (Claude Code)

Command:

```
claude -p --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" \
  --permission-mode plan --no-session-persistence --plugin-dir <plugin-dir> \
  --verbose --output-format stream-json "<the scenario prompt>"
```

Run directory: same as RED (`scripts/check-template-secrets.mjs`,
`.github/workflows/secret-scan.yml`). Plugin directory: a fresh copy of
`.claude-plugin/`, `skills/`, `scripts/` (no `review/` exists yet), with
`dependencies` deleted from the copy's `plugin.json` per the deviation
above.

Assertion made before recording: the `system/init` line's `plugins` array
contains an entry with `"name": "ship-kit"` and no `plugin_errors` key is
present; the first assistant tool call is `Skill` with `"skill":
"ship-kit:planning-deployable-pr-sequences"`. Both held.

Final result text (verbatim, ASCII-transcribed; this run referenced no
local path in its output, confirmed by the standard grep sweep):

```
# Plan: `--json` output for `check-template-secrets.mjs` and a CI artifact upload

## Context
`scripts/check-template-secrets.mjs` only prints violations as text on stderr. A machine-readable JSON array, uploaded as a CI artifact from `.github/workflows/secret-scan.yml`, lets later tooling read the results without scraping logs. The work is two PRs in two waves. Dependency: **1 -> 2**, because the workflow step calls the flag.

## Decisions on open points
- **JSON shape:** an array of `{ "file", "line", "key", "message" }` objects. **The literal value is left out**, and `message` is written without it. Artifacts on this public repo can be downloaded, so the file must not republish a leaked credential.
- **Output stream:** in `--json` mode the script writes exactly one JSON document to stdout and nothing else, including the human "found..." and "scanned..." lines. A clean scan and the "no scan roots" case both print `[]`.
- **Exit codes:** they stay the same: 0 means clean, 1 means violations. An unknown argument prints an error to stderr and exits **2**, so a typo like `--jsno` can't quietly fall back to text mode.
- **Existing API:** `findTemplateSecretViolations` keeps returning the same strings. A new export, `collectTemplateSecretViolations`, returns structured records, and the string function is built on top of it.
- **CI gate:** the existing text-mode step still decides pass or fail. The JSON step always runs, ignores the exit code, and only produces the artifact.
- **Artifact:** named `template-secret-violations`, containing `template-secret-violations.json`, with `retention-days: 7` and `if-no-files-found: error`. `actions/upload-artifact` is pinned to a full commit SHA with a `# vX.Y.Z` comment, following the file's existing pinning style.
- **Permissions:** unchanged. `upload-artifact` doesn't need extra `permissions:`.

---

## Wave 1

### Task 1: Add a `--json` flag to the scanner (one PR)
**Files**
- Create: `scripts/check-template-secrets.test.mjs`. CI already runs it through `node --test scripts/*.test.mjs` (`secret-scan.yml:51`).
- Modify: `scripts/check-template-secrets.mjs`

**Failing tests first** (`node:test` + `node:assert/strict`; the fixtures are temp directories from `mkdtempSync` with a `templates/x.yml` holding an `env:` block. `main` is called with a fake `out` that records `log` and `error` calls):
1. `main(dir, out, ["--json"])` with `API_TOKEN: not-a-real-value` returns `1`. `out.log` is called once with a string that parses to `[{ file: "templates/x.yml", line: <n>, key: "API_TOKEN", message: <string> }]`. The output never contains `not-a-real-value`, and `out.error` is never called.
2. A clean fixture with `--json` returns `0` and logs exactly `[]`.
3. A directory with no scan roots, run with `--json`, returns `0` and logs `[]`.
4. With no args, the text output matches what it prints today: the stderr header plus indented lines, and exit 1. This is a regression guard.
5. `main(dir, out, ["--bogus"])` returns `2` and writes to `out.error`.
6. `findTemplateSecretViolations` returns the same string it does today for the violating fixture.

**Implementation**
- Move the detection loop out of `findTemplateSecretViolations` (lines 68-120) into `collectTemplateSecretViolations(content, filePath)`. It returns `{ file, line, key, value }`, and `findTemplateSecretViolations` maps those records to the current strings.
- Change the signature to `main(cwd = process.cwd(), out = console, args = [])`. Parse args: `--json` is accepted, anything else exits 2. Collect the structured records. In JSON mode, call `out.log(JSON.stringify(records.map(({ value, ...rest }) => ({ ...rest, message: ... }))))` and skip the text output.
- The entrypoint (line 186) becomes `process.exit(main(process.cwd(), console, process.argv.slice(2)))`.
- Update the header comment (lines 8-9) to document `--json` and exit code 2.

**Verification**
- `node --test scripts/*.test.mjs` exits 0 and all tests pass.
- `node scripts/check-template-secrets.mjs; echo $?` gives the same output as before this change and exit 0.
- `node scripts/check-template-secrets.mjs --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'` exits 0.
- `node scripts/check-template-secrets.mjs --nope; echo $?` prints `2`.

**Acceptance:** `--json` writes a valid JSON array with no values in it, text mode is unchanged byte for byte, and the new tests run in the existing CI step.
**Safe to deploy alone:** it's additive before use (CI doesn't pass `--json` yet), the text-mode behavior is unchanged, and the tests pass at that commit.
**Tier:** Middle. It's a standard refactor plus a CLI flag and tests in one script.

---

## Wave 2

### Task 2: Upload the JSON as a CI artifact (one PR, depends on Task 1)
**Files**
- Modify: `.github/workflows/secret-scan.yml`
- Tests: none; the check is the workflow run itself (see Verification).

**Implementation:** add two steps after "Check copied templates never bake in a literal credential" (line 48):
```yaml
      - name: Write template secret scan results as JSON
        if: always()
        run: node scripts/check-template-secrets.mjs --json > template-secret-violations.json || true

      - name: Upload template secret scan results
        if: always()
        uses: actions/upload-artifact@<full-sha> # vX.Y.Z
        with:
          name: template-secret-violations
          path: template-secret-violations.json
          retention-days: 7
          if-no-files-found: error
```
`if: always()` means the results are still written and uploaded when the gate step fails, which is exactly when they're useful. `|| true` stops the JSON step from reporting the failure a second time.

**Verification**
- If `actionlint` is available, `actionlint .github/workflows/secret-scan.yml` exits 0.
- On the PR's CI run: the job passes, and `gh run view <run-id> --json artifacts` (or the run page) lists `template-secret-violations`. The downloaded file contains `[]`.
- Optional, on a throwaway branch that isn't merged: add `API_TOKEN: not-a-real-value` under an `env:` block in a workflow. The gate step fails, the artifact is still uploaded with one record, and the record has no value field.

**Acceptance:** every run of the secret-scan job publishes `template-secret-violations.json`, pass or fail, and the job's pass/fail result is unchanged.
**Safe to deploy alone:** it doesn't depend on any later PR, since the flag it uses already shipped in Task 1, and the gate step is untouched.
**Tier:** Smallest. It's one mechanical edit to a single file with the content given above.

---

## Review note
Review of this plan fixes blockers only. Anything non-blocking goes as a note on the task it concerns.

**Out of scope, noted on Task 1:** the text mode already prints the literal value to the public CI log (`check-template-secrets.mjs:112-116`). This plan leaves that behavior alone.
```

Pass criteria (final 7-criterion scenario):

1. PASS. Two tasks, each explicitly labelled "(one PR)".
2. PASS. Each task's "Files" list names exact create/modify paths,
   including the new test file `scripts/check-template-secrets.test.mjs`.
3. PASS. Each task has a "Safe to deploy alone" line naming exactly the
   listed reasons: Task 1 cites "additive before use", "text-mode behavior
   is unchanged" and "tests pass at that commit"; Task 2 cites "doesn't
   depend on any later PR" and that the flag it uses "already shipped in
   Task 1."
4. PASS. Task 1's "Failing tests first" section, with six named test
   cases, is written before its "Implementation" section. Task 2 has no
   unit-testable logic (a single workflow-YAML edit) and says so
   explicitly ("Tests: none; the check is the workflow run itself").
5. PASS. "Wave 1" / "Wave 2" headers group the two tasks by disjoint files
   (`scripts/*` vs `.github/workflows/secret-scan.yml`), and the plan
   states the dependency order up front: "Dependency: 1 -> 2."
6. PASS. Task 1 names tier "Middle" with reason "a standard refactor plus
   a CLI flag and tests in one script"; Task 2 names tier "Smallest" with
   reason "one mechanical edit to a single file with the content given
   above" -- both match the skill's tier rule.
7. PASS. "Review of this plan fixes blockers only. Anything non-blocking
   goes as a note on the task it concerns," followed by exactly one such
   note attached to Task 1 rather than folded into the plan body.

All 7 remaining criteria PASS.

## Loopholes closed

Not applicable: `planning-deployable-pr-sequences` is an output-shaping
skill (positive recipe, no prohibitions, no rationalization table per
CLAUDE.md, Skills). No loopholes were observed to close; the only issue
found was environmental (the staged copy's unsatisfied dependency
suppressing the whole plugin), not a gap in the skill's own text, and it
is fixed by the deviation recorded above, not by the skill's content.
