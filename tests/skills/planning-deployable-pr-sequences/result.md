Shipped-text SHA-256: 719997444dbecb49c69b9750bb1c7cecea93611744d0ad54cecaadffbcd170ce
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3, 4, 5, 6, 7

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

## Corrected-method run

One GREEN run of the shipped text under the corrected pressure-test method (CLAUDE.md, Skills). CLI `2.1.284 (Claude Code)`; run directory `scripts/check-template-secrets.mjs` and `.github/workflows/secret-scan.yml`.

```bash
PLUG=$(node "$REPO/tests/helpers/pressure.mjs" stage --out "$(mktemp -d)")
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose)
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$PLUG" --add-dir="$PLUG" "$(cat "$SCRATCH/planning-deployable-pr-sequences-prompt.txt")" < /dev/null) > "$SCRATCH/planning-deployable-pr-sequences-green-1.jsonl"
node "$REPO/tests/helpers/pressure.mjs" check --skill planning-deployable-pr-sequences --stream "$SCRATCH/planning-deployable-pr-sequences-green-1.jsonl"
```

`check` exited 0. Its output, verbatim with the staged path as `<plugin-dir>`, the run directory as `<run-dir>`, and non-ASCII characters transcribed (ellipsis to `...`, en dash to `-`, arrow to `->`):

````text
Shipped-text SHA-256: 719997444dbecb49c69b9750bb1c7cecea93611744d0ad54cecaadffbcd170ce

# Plan: `--json` output for `check-template-secrets.mjs`, uploaded as a CI artifact

## Context
`scripts/check-template-secrets.mjs` prints violations as text to stderr. The goal is a machine-readable JSON array of violations, and a CI step in `.github/workflows/secret-scan.yml` that uploads it as an artifact.

The workflow says it "guards this public repo against ever publishing a secret". Today's text output puts the offending literal value in the message (`is assigned "${value}"`). An artifact on a public repo can be downloaded by others, so **the JSON must never contain the value**. This drives the record shape below.

## Rulings on open points
- **Record shape:** `{ "file": string, "line": number, "key": string }`. There is no `value` field and no free-text message, because the message embeds the secret.
- **Output channel:** with `--json`, stdout gets only the JSON array (pretty-printed, 2-space indent, trailing newline). Nothing else goes to stdout or stderr.
- **Exit codes:** they stay the same with `--json`: 0 means no violations, 1 means at least one. An unknown argument prints a usage error to stderr and exits 2.
- **No scan roots found:** `--json` prints `[]` and exits 0. The current "nothing to scan" log line is suppressed so the JSON stays valid.
- **Default output:** the text output without `--json` is byte-for-byte unchanged.
- **Refactor:** add an exported `findTemplateSecretViolationRecords(content, filePath)` that returns `{file, line, key, value}` objects. `findTemplateSecretViolations` becomes a thin formatter over it, with the same exported name, signature and strings. The JSON serializer picks only `file`, `line`, `key`.
- **Arguments:** `main(cwd = process.cwd(), out = console, argv = process.argv.slice(2))`. The entry point passes argv. `console.log` goes through `out.log`, so tests can capture it.
- **Artifact:** name `template-secret-violations`, file path `$RUNNER_TEMP/template-secret-violations.json`, `retention-days: 7`, `if-no-files-found: ignore`. The upload step runs `if: always()` so the artifact exists on failure too.
- **Action pinning:** `actions/upload-artifact` is pinned to a full commit SHA with a `# vX.Y.Z` comment, matching the checkout and setup-node steps. The implementer resolves the SHA of the latest release tag with `gh api repos/actions/upload-artifact/git/ref/tags/<tag>`.
- **Permissions:** no change. Uploading artifacts doesn't need `contents: write`.
- **Existing gap:** the workflow already runs `node --test scripts/*.test.mjs`, but this snapshot has no test file. Task 1 creates it, so that line will have something to run.

---

## Task 1: Add the `--json` flag (Wave 1)
**Files**
- Modify: `scripts/check-template-secrets.mjs`
- Create: `scripts/check-template-secrets.test.mjs` (`node:test` + `node:assert/strict`, with temporary directories from `fs.mkdtempSync(os.tmpdir())`)

**Failing tests first.** Write these before the implementation and confirm they fail against the current script:
1. **Violation case:** a temp dir with `.github/workflows/x.yml` containing `env:\n  API_TOKEN: hunter2`. `main(dir, out, ["--json"])` returns 1. The captured stdout parses to `[{file: ".github/workflows/x.yml", line: 2, key: "API_TOKEN"}]`, and the raw output does **not** contain `hunter2`.
2. **Clean case:** `API_TOKEN: ${{ secrets.X }}` prints `[]` and returns 0.
3. **No scan roots:** an empty dir prints exactly `[]\n` and returns 0.
4. **Unknown argument:** `["--bogus"]` returns 2, writes nothing to stdout, and writes a usage message to stderr.
5. **Regression:** without flags, the violation case produces the same stderr lines as today, `"<file>:<line>: credential-shaped key ..."`.
6. **Records function:** `findTemplateSecretViolationRecords` returns `{file, line, key, value}` for the violation fixture.

**Implementation**
- Add `findTemplateSecretViolationRecords`, and reimplement `findTemplateSecretViolations` as a formatter over it.
- Parse `argv` in `main`: accept `--json`, reject anything else with exit 2.
- In JSON mode, collect records and call `out.log(JSON.stringify(records.map(({file, line, key}) => ({file, line, key})), null, 2))`.
- Update the header comment (lines 8-9) to document `--json` and exit code 2.

**Verification**
- `node --test scripts/*.test.mjs` exits 0 with all tests passing.
- Temporarily revert the implementation and confirm the tests fail.
- `node scripts/check-template-secrets.mjs --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'` exits 0.
- `node scripts/check-template-secrets.mjs` still prints the scanned-N-files line and exits 0.

**Acceptance**
- `--json` prints a valid JSON array with no secret values.
- Exit codes are as ruled above.
- The default text output is unchanged.

**Safe to deploy alone:** the new behavior stays dark until someone passes `--json`. Tests pass at this commit, and nothing depends on a later PR.

**Model tier:** Middle. This is standard single-feature work with tests.

---

## Task 2: CI step to upload the JSON artifact (Wave 2)
**Files**
- Modify: `.github/workflows/secret-scan.yml`

**Change.** Replace the final step with:
- **Step "Check copied templates never bake in a literal credential":**
  ```bash
  set -euo pipefail
  node --test scripts/*.test.mjs
  status=0
  node scripts/check-template-secrets.mjs --json > "$RUNNER_TEMP/template-secret-violations.json" || status=$?
  node scripts/check-template-secrets.mjs   # human-readable log; fails step on violations
  exit "$status"
  ```
  Human-readable output is kept for the job log. JSON is written first, so the file exists before the step can fail. A status of 2 (a usage error) still fails the step through `exit "$status"`.
- **New step "Upload template secret scan results":**
  - `if: always()`
  - `uses: actions/upload-artifact@<sha> # vX.Y.Z`
  - `with: name: template-secret-violations`, `path: ${{ runner.temp }}/template-secret-violations.json`, `if-no-files-found: ignore`, `retention-days: 7`

  `ignore` handles the case where an earlier step (such as gitleaks) failed before the JSON was written.

**Test.** There's no unit-test harness for workflows. The "failing test first" for this task is the PR's own CI run: before this change, the run has no `template-secret-violations` artifact.

**Verification**
- If `actionlint` is available locally, `actionlint .github/workflows/secret-scan.yml` exits 0.
- On the PR's run, the job is green, and `gh run download <run-id> -n template-secret-violations` yields a file whose contents are `[]`.
- `gh run view <run-id> --log` still shows the "scanned N file(s)" line.

**Acceptance**
- Every run of the secret-scan workflow that reaches the check step publishes a `template-secret-violations` artifact containing a JSON array with no credential values.
- The job's pass/fail result is unchanged.

**Safe to deploy alone:** it depends only on Task 1, which is already merged. It has no dependency on a later PR, and CI passes at this commit.

**Model tier:** Smallest. This is a mechanical edit to one file with the content given above; the only lookup is the action's SHA.

---

## Waves and dependencies
- **Wave 1:** Task 1 (`scripts/check-template-secrets.mjs` and its test file).
- **Wave 2:** Task 2 (`.github/workflows/secret-scan.yml`).
- **Order:** 1 -> 2. Task 2 calls `--json`, which Task 1 adds.
- There's no release or version-bump step.

## Plan review policy
When this plan is reviewed, fix blockers only. Anything non-blocking gets recorded as a note on the task it concerns.
````

Criteria:

1. PASS. Two numbered tasks, each one PR ("## Task 1", "## Task 2").
2. PASS. Each task's "Files" list names exact paths, including the new test file `scripts/check-template-secrets.test.mjs`; Task 2 edits only the workflow, whose test is the PR's own CI run.
3. PASS. "Safe to deploy alone: the new behavior stays dark until someone passes `--json`. Tests pass at this commit, and nothing depends on a later PR." and, for Task 2, "It has no dependency on a later PR, and CI passes at this commit."
4. PASS. Task 1's "Failing tests first" section, six cases, precedes its "Implementation" section.
5. PASS. "Wave 1: Task 1 ... Wave 2: Task 2 ... Order: 1 -> 2. Task 2 calls `--json`, which Task 1 adds."
6. PASS. "Model tier: Middle. This is standard single-feature work with tests." and "Model tier: Smallest. This is a mechanical edit to one file with the content given above".
7. PASS. "When this plan is reviewed, fix blockers only."

## Pinned-model GREEN

One GREEN run of the shipped text under the pinned model, `claude-opus-5-5`, with CLI `2.1.284 (Claude Code)`, in a fresh run directory like the RED attempts' and with the staged plugin loaded. `node tests/helpers/pressure.mjs check` accepted the stream (exit 0): the init message reports the pinned model and lists `ship-kit:planning-deployable-pr-sequences`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines at the top of this file are the ones `check` printed; the hash equals `node tests/helpers/pressure.mjs hash --skill planning-deployable-pr-sequences`. The discriminating criteria are recomputed from the pinned RED attempts only (`baseline.md`, `## Pinned-model RED`).

Headline: 7 of 7 discriminating criteria pass.

An earlier GREEN attempt was discarded unscored: the CLI reported `Not logged in` and the stream ended in an error result with no model output, which `check` refuses. The run below is the rerun.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
PLUG=$(cd "$(mktemp -d)" && pwd -P)
STAGED=$(node tests/helpers/pressure.mjs stage --out "$PLUG")
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$STAGED" --add-dir="$STAGED" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green-N.jsonl"
node tests/helpers/pressure.mjs check --skill "$SKILL" --stream "$SCRATCH/$SKILL-green-N.jsonl" > "$SCRATCH/$SKILL-green-N.txt"
echo "check exit: $?"
```

Prompt:

```text
Write an implementation plan for this change in this repository: add a `--json` flag to `scripts/check-template-secrets.mjs` that prints violations as a JSON array, and a CI step in `.github/workflows/secret-scan.yml` that uploads that JSON as an artifact. Output only the plan.
```

Pinned GREEN output (the `check` text, verbatim, ASCII-transcribed, with the run directory as `<run>` and the staged plugin as `<staged>`):

````text
Shipped-text SHA-256: 719997444dbecb49c69b9750bb1c7cecea93611744d0ad54cecaadffbcd170ce
Model: claude-opus-5-5

# Plan: `--json` output for `check-template-secrets.mjs` and a CI artifact upload

## Context

`scripts/check-template-secrets.mjs` only prints violations as text on stderr. This change adds machine-readable output and has CI upload it as an artifact on every `secret-scan.yml` run. The change ships as two PRs. PR 1 adds the flag and doesn't change current behavior. PR 2 adds the CI step.

Things I found in the repo that affect the plan:
- `findTemplateSecretViolations()` (`scripts/check-template-secrets.mjs:68`) returns preformatted strings. JSON output needs structured fields, so the scan logic has to produce records first.
- `main(cwd, out)` (`:146`) can already be tested with an injected `out`. The entry point at `:187` calls `main()` without argv.
- No `scripts/*.test.mjs` exists yet, but CI already runs `node --test scripts/*.test.mjs` (`secret-scan.yml:51`). PR 1 adds the first file that glob matches.
- This is a public repo, and gitleaks runs with `--redact`. The current text message includes the offending value.

## Rulings on points the request leaves open

1. **JSON shape:** an array of objects `{ "file", "line", "key", "message" }`, where `line` is 1-based. Plain strings would force consumers to parse text again.
2. **Credential values stay out of the JSON.** Anyone can download artifacts from a public repo, and the scanner exists to stop secrets being published. `message` is built without the value. Text mode is unchanged. The fact that text mode prints the value in CI logs is out of scope and noted on Task 2.
3. **stdout is pure JSON in `--json` mode:** exactly one `out.log(JSON.stringify(violations, null, 2))` call and no `out.error` calls. When there are no violations, or no scan directories exist, it prints `[]`.
4. **Exit codes stay the same in both modes:** 0 means clean, 1 means violations. An unknown argument prints a usage line through `out.error` and returns **2**, so a mistyped flag can't quietly change the output format.
5. **Refactor without changing the API:** add an exported `findTemplateSecretViolationRecords(content, filePath)` that returns `{ file, line, key, value }[]`. `findTemplateSecretViolations` becomes a map over it with the same string format as today, so existing callers see identical output.
6. **CI keeps the existing text check as the gate.** A separate step writes the JSON and runs with `if: always()`, so the artifact is uploaded even when the gate fails. That step accepts exit codes 0 and 1. Any other exit code fails the step, so a crash can't pass as an empty report.
7. **Artifact details:** name `template-secret-violations`, file `template-secrets.json`, `retention-days: 7`, `if-no-files-found: error`.
8. **Action pinning:** `actions/upload-artifact` is pinned to a full commit SHA with a `# vX.Y.Z` comment, matching the existing `uses:` lines. The implementer resolves the SHA of the latest release tag with `gh api repos/actions/upload-artifact/git/ref/tags/<tag>`. No new `permissions:` are needed; artifact upload works with `contents: read`.

## Task 1: Add the `--json` flag to the script (one PR)

**Files**
- Create: `scripts/check-template-secrets.test.mjs`
- Modify: `scripts/check-template-secrets.mjs`

**Write the failing test first.** Use `node:test` and `node:assert/strict`. Each case builds a temp dir with `mkdtempSync(join(tmpdir(), ...))` and calls `main(dir, fakeOut, argv)`, where `fakeOut` records every `log` and `error` call. The test asserts:
1. **Violation, `--json`:** `templates/a.yml` contains `env:\n  API_TOKEN: hunter2-literal`. `main` returns 1. There is exactly one `log` call and no `error` calls. `JSON.parse` of that call deep-equals `[{ file: "templates/a.yml", line: 2, key: "API_TOKEN", message: <string> }]`, and the raw output doesn't contain `hunter2-literal`.
2. **Clean, `--json`:** `API_TOKEN: ${{ secrets.API_TOKEN }}` returns 0 and the output parses to `[]`.
3. **No scan directories, `--json`:** returns 0 and the output parses to `[]`.
4. **No flag (regression):** the case 1 fixture returns 1. The first `error` line is `check-template-secrets: found hardcoded credential values:` and the second line contains `templates/a.yml:2:` and `hunter2-literal`.
5. **Unknown argument `--jsn`:** returns 2.
6. **Records function:** `findTemplateSecretViolationRecords` returns `{ file, line, key, value }`, and `findTemplateSecretViolations` returns the same string it returns today.

Run the test before implementing. Cases 1-3, 5 and 6 must fail. Case 4 passes against the current code, which confirms it guards the existing behavior.

**Implementation**
- Move the loop body into `findTemplateSecretViolationRecords`, pushing records instead of strings. Add a `formatViolation(record)` helper that produces today's string, and have `findTemplateSecretViolations` return `records.map(formatViolation)`.
- Change the signature to `main(cwd = process.cwd(), out = console, argv = [])`. Parse `argv`: `--json` sets `json = true`, and anything else prints `check-template-secrets: unknown argument "<arg>"; usage: check-template-secrets.mjs [--json]` and returns 2.
- The no-files branch prints `[]` in JSON mode and the existing message otherwise.
- Collect records. In JSON mode, log `records.map(({ file, line, key }) => ({ file, line, key, message: \`credential-shaped key "${key}" is not an empty value or a \${{ secrets.X }} / \${{ inputs.X }} expression\` }))` and return `records.length > 0 ? 1 : 0`. Otherwise, keep the existing text path, formatting through `formatViolation`.
- Change the entry point to `process.exit(main(process.cwd(), console, process.argv.slice(2)))`.
- Update the header comment (`:8-9`) to document `--json` and exit code 2.

**Verification commands**
- `node --test scripts/*.test.mjs` exits 0 with all 6 tests passing.
- `node scripts/check-template-secrets.mjs; echo $?` gives the same text as before and exits 0 on the current repo.
- `node scripts/check-template-secrets.mjs --json | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!Array.isArray(a))process.exit(1)'; echo $?` prints 0.
- `node scripts/check-template-secrets.mjs --bogus; echo $?` prints 2.

**Acceptance criteria:** `--json` prints only a valid JSON array with no credential values. Output and exit codes without the flag are unchanged. The existing CI step stays green.

**Why it's safe to merge alone:** the change is additive before use (nothing passes `--json` yet), and tests pass at this commit. CI's existing step calls the script without arguments, which still behaves exactly as before.

**Model tier: Middle.** It's a standard refactor plus a flag with tests.

## Task 2: Upload the JSON as a CI artifact (one PR)

**Files**
- Modify: `.github/workflows/secret-scan.yml`
- No test file: the check is the workflow run itself (see the verification commands below).

**Change:** add these steps after the existing "Check copied templates..." step:

```yaml
      - name: Write template secret-scan results as JSON
        if: always()
        run: |
          set +e
          node scripts/check-template-secrets.mjs --json > template-secrets.json
          rc=$?
          # 0 = clean, 1 = violations (reported by the step above); anything else is a crash.
          [ "$rc" -le 1 ]

      - name: Upload template secret-scan results
        if: always()
        uses: actions/upload-artifact@<full-sha> # v<X.Y.Z>
        with:
          name: template-secret-violations
          path: template-secrets.json
          if-no-files-found: error
          retention-days: 7
```

**Verification commands**
- `actionlint .github/workflows/secret-scan.yml` exits 0, if `actionlint` is installed.
- On the PR, `gh pr checks --watch` shows `gitleaks` passing.
- Get the run ID with `gh run list --workflow secret-scan.yml --branch <branch> -L 1`, then run `gh run download <run-id> -n template-secret-violations -D /tmp/tsv && cat /tmp/tsv/template-secrets.json`. The file should contain `[]`.

**Acceptance criteria:** every run of `secret-scan.yml` uploads `template-secret-violations`, including runs where the gate step or gitleaks fails. The artifact is a JSON array with no credential values. The gate step still fails the job when there are violations.

**Why it's safe to merge alone:** it has no dependency on a later PR, it only uses the `--json` flag that Task 1 merged, and tests pass at this commit.

**Model tier: Smallest.** It's a single-file edit of the YAML given above; the only lookup is the SHA.

**Non-blocking note:** in text mode the script still writes the credential value to public CI logs. A follow-up could drop the value from `formatViolation`. That's out of scope here.

## Waves and dependency order

- **Wave 1:** Task 1 (`scripts/check-template-secrets.mjs`, `scripts/check-template-secrets.test.mjs`)
- **Wave 2:** Task 2 (`.github/workflows/secret-scan.yml`)
- **Dependency:** 1 -> 2. The file sets don't overlap; they're in separate waves only because Task 2 calls the flag Task 1 adds.
- There's no release or version-bump step; the repo has no `package.json`.

## Plan review policy

Reviews of this plan fix blockers only. Record anything non-blocking as a note on the task it concerns.
````

1. PASS. "Task 1: Add the `--json` flag to the script (one PR)" and "Task 2: Upload the JSON as a CI artifact (one PR)".
2. PASS. Each task has a Files list; Task 1 creates `scripts/check-template-secrets.test.mjs`, and Task 2 says it has no test file because the check is the workflow run itself.
3. PASS. Task 1: "additive before use" and "tests pass at this commit"; Task 2: "it has no dependency on a later PR".
4. PASS. "Write the failing test first" precedes Task 1's implementation.
5. PASS. Wave 1 and Wave 2 with disjoint files and "Dependency: 1 -> 2".
6. PASS. "Model tier: Middle" and "Model tier: Smallest", each with a one-line reason.
7. PASS. "Reviews of this plan fix blockers only."
