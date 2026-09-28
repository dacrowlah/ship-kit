## Deviation from the standard GREEN setup

The staged plugin copy's `.claude-plugin/plugin.json` declares a
`superpowers@claude-plugins-official` dependency. With `--setting-sources
""` no plugin is installed, so the dependency is unsatisfied and the
staged `ship-kit` plugin as a whole is dropped: a first GREEN attempt
(command and full transcript kept as
`planning-deployable-pr-sequences-green.txt` /
`-green-stream.jsonl` in the session scratchpad, not committed) showed
`"plugin_errors": [{"plugin": "ship-kit@inline", "type":
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

## GREEN run

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

Final result text (verbatim, ASCII-transcribed; this run made no
filesystem writes and referenced no local path, so no redaction was
needed beyond the checks below):

```
# Plan: `--json` output for `check-template-secrets.mjs`, uploaded as a CI artifact

## Context
`scripts/check-template-secrets.mjs` only prints violations as human-readable text through `out.error`. The goal is a machine-readable JSON array of violations that CI keeps as a downloadable artifact, without changing how the existing check passes or fails.

The plan is two PRs, merged in order. Plan review fixes blockers only. Non-blocking remarks go as notes on the task they concern.

## Decisions (open points, one ruling each)
- **Shape of each JSON entry:** `{ "file": string, "line": number, "key": string, "message": string }`. `file` is relative to the working directory and uses the same `relPath` as today.
- **No raw value in the JSON:** the literal credential value is left out of the JSON and its `message`. The artifact is downloadable from a public repo, so it must not store a leaked secret a second time. `message` reads: `credential-shaped key "<key>" is not an empty value or a ${{ secrets.X }} / ${{ inputs.X }} expression`.
- **Output channel:** in `--json` mode the script makes exactly one `out.log` call with `JSON.stringify(violations, null, 2)`. Nothing is written through `out.error`, so stdout is valid JSON and nothing else.
- **Empty cases:** with no violations, or with no scan roots at all, `--json` prints `[]`.
- **Exit codes:** unchanged in `--json` mode (0 means clean, 1 means violations).
- **Existing export stays the same:** `findTemplateSecretViolations(content, filePath)` keeps returning the same strings. A new exported `findTemplateSecretViolationRecords(content, filePath)` returns the objects, and the old function becomes a `.map` over it that rebuilds today's message, including the value.
- **Parsing the flag:** `main(cwd, out, argv = [])` checks `argv.includes("--json")`. The CLI guard passes `process.argv.slice(2)`. Unknown arguments are ignored, as they are today. No argument-parsing library.
- **What fails CI:** the existing text-mode step still decides pass or fail. The JSON step never fails the job; it only produces the report.
- **Artifact:** named `template-secrets-report`, file `template-secrets-report.json`, `retention-days: 14`, `if-no-files-found: error`.
- **Upload action:** `actions/upload-artifact` pinned to the full commit SHA of its latest release, with a `# vX.Y.Z` comment, to match the pinning style already in `secret-scan.yml`. Look the SHA up at implementation time with `gh api repos/actions/upload-artifact/releases/latest --jq .tag_name`, then `gh api repos/actions/upload-artifact/git/ref/tags/<tag> --jq .object.sha`.
- **Permissions:** no change. `contents: read` is enough for uploading artifacts.

---

## Task 1: Add `--json` mode to the script (PR 1)
**Wave 1. Model tier: Middle.** Standard feature work in one module plus its tests.

**Files**
- Create `scripts/check-template-secrets.test.mjs`. This is the first test file in `scripts/`. It is also the first file matched by the `node --test scripts/*.test.mjs` line that CI already runs.
- Modify `scripts/check-template-secrets.mjs`.

**Tests first.** Write these with `node:test` and `node:assert/strict` before changing the script, and confirm they fail. Each fixture is a temp directory created with `mkdtempSync(join(tmpdir(), ...))` containing `.github/workflows/x.yml`. The fixture includes an `env:` block with `API_TOKEN: hunter2` and `GH_PAT: ${{ secrets.GH_PAT }}`. Output is captured with a fake `out = { log: [], error: [] }` recorder.
1. `main(dir, out, ["--json"])` returns `1`. `out.log` receives exactly one entry, which parses to `[{ file: ".github/workflows/x.yml", line: <n>, key: "API_TOKEN", message: <string> }]`. `out.error` is empty. The string `hunter2` appears nowhere in the output.
2. A clean fixture (only the `secrets.` line) returns `0` and logs exactly `[]`.
3. An empty temp directory (no scan roots) returns `0` and logs exactly `[]`.
4. Text mode doesn't change: `main(dir, out)` returns `1`, and `out.error` contains the current header line plus the current message, including `"hunter2"`.
5. `findTemplateSecretViolations` still returns the same strings as before, as a regression guard for the export.
6. CLI: `spawnSync(process.execPath, [scriptPath, "--json"], { cwd: dir })` gives `status === 1` and stdout that parses to a one-element array.

**Implementation**
- Move the detection loop into `findTemplateSecretViolationRecords`, which pushes `{ file, line, key, value }` internally. Have `findTemplateSecretViolations` map those records to today's strings.
- In `main`, collect records. When `--json` is set, log the array (with `value` removed and `message` added) and return `records.length ? 1 : 0`. The `files.length === 0` early return logs `[]` in JSON mode.
- Update the header comment to document `--json`.

**Verification**
- `node --test scripts/*.test.mjs` passes with 0 failures.
- `node scripts/check-template-secrets.mjs --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' && echo ok` prints `ok`, with the script exiting 0 on the current repo.
- `node scripts/check-template-secrets.mjs; echo $?` prints the same text as before and `0`.

**Acceptance criteria:** with `--json`, stdout is only a JSON array matching the shape above. Text mode output and exit codes are unchanged. All six tests pass.

**Safe to merge alone:** the new behavior is off until the flag is passed, and nothing calls `--json` yet. Tests pass at this commit. It depends on nothing from a later PR.

---

## Task 2: Upload the JSON report in CI (PR 2)
**Wave 2. Model tier: Smallest.** It's a single-file edit that transcribes the steps given below.

**Files**
- Modify `.github/workflows/secret-scan.yml`. There's no unit test for workflow YAML. The test for this change is the CI run on the PR itself.

**Change.** Insert two steps between "Run gitleaks" and "Check copied templates never bake in a literal credential":
```yaml
      - name: Write template-secrets JSON report
        if: ${{ !cancelled() }}
        run: node scripts/check-template-secrets.mjs --json > template-secrets-report.json || true

      - name: Upload template-secrets JSON report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@<full-sha> # vX.Y.Z
        with:
          name: template-secrets-report
          path: template-secrets-report.json
          if-no-files-found: error
          retention-days: 14
```
- `|| true` keeps this step from failing the job. The existing gating step, left unchanged, still fails the job on violations.
- `!cancelled()` means the report is still produced and uploaded when gitleaks fails, which is when it's most useful.

**Verification**
- `actionlint .github/workflows/secret-scan.yml` exits 0, if actionlint is installed.
- On the PR's run, `gh run view <run-id> --json conclusion` shows `success`.
- `gh run download <run-id> -n template-secrets-report && cat template-secrets-report.json` prints `[]`.
- Negative check, done on a throwaway branch and never merged: add a literal `API_TOKEN: abc` under an `env:` block. The job fails in the gating step, and the downloaded artifact contains one entry for that line, without `abc` in it.

**Acceptance criteria:** every run of Secret scan that isn't cancelled produces a `template-secrets-report` artifact containing a valid JSON array. Pass/fail behavior is the same as before.

**Safe to merge alone:** it depends only on Task 1, which is already merged. Nothing references a later PR, and CI passes at this commit.

---

## Dependency order
- `1 -> 2`
- Wave 1: Task 1 (`scripts/check-template-secrets.mjs`, `scripts/check-template-secrets.test.mjs`)
- Wave 2: Task 2 (`.github/workflows/secret-scan.yml`)
- There is no release or version-bump step.

## Notes (non-blocking)
- **Task 1:** in text mode, the script already prints the literal credential value to public CI logs. That's out of scope here, but worth a separate follow-up to redact it.
- **Task 1:** today no `scripts/*.test.mjs` files exist, so the CI line `node --test scripts/*.test.mjs` currently has nothing to match. Task 1 gives it a file. When implementing, check whether that line is failing on `main` right now, and mention it in the PR description if so.
```

Pass criteria:

1. PASS. Two numbered tasks, each explicitly labelled "(PR 1)" / "(PR 2)".
2. PASS. Each task's "Files" list names exact create/modify paths, including
   the new test file `scripts/check-template-secrets.test.mjs`.
3. PASS. Each task has a "Safe to merge alone" line naming exactly the
   listed reasons: Task 1 cites "new behavior is off until the flag is
   passed" (dark until switched on), "Tests pass at this commit" and "no
   dependency on a later PR"; Task 2 cites "depends only on Task 1, which
   is already merged" and "CI passes at this commit".
4. PASS. Task 1's "Tests first" section, with six named test cases, is
   written before its "Implementation" section. Task 2 has no unit-testable
   logic (a single workflow-YAML edit) and says so explicitly, naming the
   PR's own CI run as its verification instead of fabricating a unit test.
5. PASS. Both tasks have a "Verification" section with exact commands
   (`node --test scripts/*.test.mjs`, the piped `JSON.parse` check,
   `actionlint`, `gh run view` / `gh run download`) and expected results.
6. PASS. "Wave 1" / "Wave 2" are stated per task, each wave's files are
   disjoint (`scripts/*` vs `.github/workflows/secret-scan.yml`), and a
   "Dependency order" section states `1 -> 2`.
7. PASS. Task 1 names tier "Middle" with reason "Standard feature work in
   one module plus its tests"; Task 2 names tier "Smallest" with reason
   "single-file edit that transcribes the steps given below" -- both match
   the skill's tier rule.
8. PASS. "The plan is two PRs, merged in order. Plan review fixes blockers
   only. Non-blocking remarks go as notes on the task they concern," plus
   a concluding "Notes (non-blocking)" section that puts two non-blocking
   remarks on Task 1 rather than rewriting the plan.

All eight criteria PASS.

## Loopholes closed

Not applicable: `planning-deployable-pr-sequences` is an output-shaping
skill (positive recipe, no prohibitions, no rationalization table per
CLAUDE.md, Skills). No loopholes were observed to close; the only issue
found was environmental (the staged copy's unsatisfied dependency
suppressing the whole plugin), not a gap in the skill's own text, and it
is fixed by the deviation recorded above, not by the skill's content.
