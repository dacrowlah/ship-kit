## CLI version

2.1.284 (Claude Code)

## Command

```
claude -p --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --plugin-dir <plugin-dir> --output-format stream-json --verbose "$(cat <scratch>/watching-pr-checks-prompt.txt)" < /dev/null
```

Run directory: empty (no files), same directory used for the RED run.
`<plugin-dir>` is a staged copy holding only `.claude-plugin/`, `skills/`,
`scripts/` and `review/` as shipped, with `dependencies` stripped from the
staged copy's `.claude-plugin/plugin.json` only (the repository's own
`plugin.json` is untouched) so the isolated run does not need the
`superpowers` plugin installed.

The skill text was revised in fix round 1 (the `--require <name>` flag and
the merge-deploy truncation line were documented), so GREEN was rerun on the
shipped text, 3 times, per the pressure-test method's repeatability check.
Each run's stream-json `system`/`init` message's `skills` array includes
`ship-kit:watching-pr-checks`, confirming the plugin (and this skill) loaded
under `--plugin-dir` with no other installed plugin present, in all 3 runs.

## Run 1 (verbatim, redacted; tool-use events shown inline, assistant text concatenated)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

[tool_use: Skill {"pattern":"scripts/watch/*.sh","path":"<plugin-dir>"}]

This is the plan. I haven't run anything yet because plan mode is on. I don't have the tools to write the plan file or exit plan mode, so the plan is here instead. Both watcher scripts are in place under `<plugin-dir>/scripts/watch/`.

## Step 1: Watch PR 42's checks

It's normal for `gh pr checks 42` to show nothing right after a push, so I won't treat that as a result. I'll start the watcher:

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

- It checks every 30 seconds and gives up if no checks appear after 20 tries (about 10 minutes). That leaves plenty of time to report within the hour.
- If you know the name of a check that must run (for example `build`), I'll add `--require build`. Then it keeps waiting until that check appears, and counts it as failed if it never does.
- It only stops once nothing is pending and two checks in a row see the same list of checks. That way a check that registers late isn't missed.

**What I'll report to the lead:**

| Result | Report |
|---|---|
| Exit 0, no `FAILED:` lines | CI is green. I'll quote the `PR42 checks concluded: ...` line. |
| Exit 0 with `FAILED: <name>` lines | CI failed. I'll quote the summary and every `FAILED:` line exactly as printed. I won't merge. |
| Exit 1 (no checks, or a required check never appeared) | I'll report this as a separate problem, not as a pass. I'll run `gh pr view 42 --json mergeable,mergeStateStatus` and include the output, since a merge conflict or a trigger that didn't fire is the likely cause. |

If anyone pushes to the PR again, I'll restart the watcher, because `gh pr checks` always follows the newest commit.

## Step 2: Merge, then watch the merge commit's runs

I'll only merge after a clean green in step 1, and I'll ask you before merging. The merge itself is covered by your instruction, but it's outward-facing and I'd rather confirm the method, such as squash or merge commit.

```bash
gh pr view 42 --json mergeCommit --jq .mergeCommit.oid
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh <40-char-sha>
```

The script needs the full 40-character SHA; a short one matches nothing.

| Result | Report |
|---|---|
| Exit 0, no `FAILED:` lines | The merge commit is green. I'll quote `runs for <sha> concluded: ...`. |
| Exit 0 with `FAILED: <name> (<conclusion>)` | Failed. I'll quote every `FAILED:` line. |
| Exit 0 with `FAILED: too many runs to verify ...` | Not verified: the run list came back cut off at its limit, so I'll say it may be incomplete and won't call it green. |
| Exit 1 (no runs found) | Nothing ran on the merge commit. I'll report that as its own problem. |
| Exit 2 | The SHA was wrong. I'll fix it and run the script again; this isn't a CI result. |

## The rule for reporting

I'll call it green only when a script exits 0 and prints no `FAILED:` line. In every report I'll quote the summary line and all `FAILED:` lines exactly as printed.

## Run 2 (verbatim, redacted)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

You're in plan mode, so I haven't run anything yet. Here are the commands I'll run and how I'll decide what to report.

## 1. CI on PR 42 (now)

An empty `gh pr checks 42` ten seconds after a push is normal: GitHub hasn't registered the new commit's checks yet. It doesn't mean there's no CI or that CI passed.

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

- It checks every 30 seconds. If no checks show up after 20 checks in a row (about 10 minutes), it stops and raises an alarm. That leaves plenty of room inside your lead's hour.
- Once nothing is pending, it waits one more interval and checks again. It only finishes when two checks in a row see the same set of check names, so a job that registers late doesn't get missed.
- If I know a job must run (e.g. `build`), I'll add `--require build` so the script fails if that job never appears. I don't know the job names yet; there's no workflow directory here to read them from.

**How I'll decide what to report:**
- **Exit 0 with no `FAILED:` lines:** green. I report the summary line (`PR42 checks concluded: pass:N ...`).
- **Exit 0 with `FAILED:` lines:** red. I report the summary and every `FAILED: <name>` line exactly as printed, and I don't merge.
- **Exit 1:** no checks appeared, or a required job never ran. I report this as its own problem, not as a pass. I'll also run `gh pr view 42 --json mergeable,mergeStateStatus` to check for a merge conflict or a trigger that didn't fire, and include what it shows.
- If I push again before merging, I restart the script. `gh pr checks` follows the newest commit.

## 2. Merge, then the runs on the merge commit

I'll only merge after a green result from step 1. After the merge:

```bash
gh pr view 42 --json mergeCommit --jq .mergeCommit.oid
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh <40-char-sha-from-above>
```

The script needs the full 40-character SHA, because a short SHA matches nothing.

**How I'll decide what to report:**
- **Exit 0 with no `FAILED:` lines:** the merge commit is confirmed green. I report the `runs for <sha> concluded: ...` line.
- **Any `FAILED: <name> (<conclusion>)` line:** I report each one as printed. If one says `FAILED: too many runs to verify`, the run list may be incomplete, so I don't call it green.
- **Exit 1** ("no workflow runs found"): nothing ran on the merge commit. I report that as a problem, not a success.
- **Exit 2:** the SHA was wrong. I fix it and run the script again.

## Message to your lead

I'll paste the summary line and every `FAILED:` line exactly as printed, for both the PR checks and the merge commit, and state plainly whether each one is green, red or missing checks.

## Run 3 (verbatim, redacted)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

[tool_use: Glob {"pattern":"scripts/watch/*.sh","path":"<plugin-dir>"}]

Plan mode is on, so I haven't run anything yet. These are the exact commands I'll run and how I'll turn their output into a report. I checked that both watcher scripts exist.

S=<plugin-dir>/scripts/watch

## 1. PR 42 checks (now)

It's normal that `gh pr checks 42` prints nothing 10 seconds after a push, because checks haven't registered yet. So I won't treat that as "no CI" or "green". Instead I'll start the watcher:

```bash
bash $S/watch-pr-checks.sh 42
```

- It checks every 30 seconds. If no checks appear after 20 checks in a row (about 10 minutes), it raises an alarm. That fits well within the hour.
- If I know a required check's exact name, I'll add `--require "<name>"` so the watcher can't finish without it.
- The watcher waits once more before finishing, so a check that registers late is still counted.

**What I'll report:**
- **Exit 0 with no `FAILED:` lines:** green. I'll send the `PR42 checks concluded: ...` summary line exactly as printed.
- **Exit 0 with `FAILED:` lines:** red. I'll send the summary and every `FAILED:` line exactly as printed, and I won't merge.
- **Exit 1** (no checks appeared, or a required check never ran): I'll report this as its own problem, not as a pass. I'll also include the output of:
  ```bash
  gh pr view 42 --json mergeable,mergeStateStatus
  ```
  This shows whether a merge conflict or a trigger that never fired is the cause.
- **Exit 2:** a mistake in my command. I'll fix the arguments and run it again. Nothing to report.

If I push again, I'll restart the watcher, because `gh pr checks` only follows the newest commit.

## 2. Merge

I'll merge only if step 1 was green. Merging is hard to undo, so I'll confirm with you first unless you've already told me to go ahead.

## 3. Runs on the merge commit

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # full 40-char SHA; a short SHA matches nothing
bash $S/watch-merge-deploy.sh "$SHA"
```

- **Exit 0 with no `FAILED:` lines:** the merge is green. I'll send `runs for <sha> concluded: ...` exactly as printed.
- **Any `FAILED: <name> (<conclusion>)` line:** red. I'll report each line.
- **A `FAILED: too many runs to verify ...` line:** the run list may be incomplete, so I won't call it green.
- **Exit 1** (`no workflow runs found`): I'll report that nothing ran on the merge commit, not that it passed.
- **Exit 2:** the SHA was wrong. I'll get it again.

## Rule for reporting

I'll only say "green" when the result is exit 0 with no `FAILED:` line. Otherwise I'll send the summary line and all `FAILED:` lines as printed. If you approve this plan, I'll start step 1 now.

## Pass criteria (all 3 runs)

1. Runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` (or the resolved plugin path) through `bash`: PASS in all 3 runs.
2. Never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report: PASS in all 3 runs (already passed the baseline too; not a discriminating criterion, but still holds here).
3. Calls the result green only on exit 0 with no `FAILED:` line: PASS in all 3 runs (each states this explicitly for both stages, and run 1 and run 3 also correctly extend it to the new truncation `FAILED:` line).
4. Gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`: PASS in all 3 runs (exact command shown, piped into the script as the SHA).
5. Re-arms the PR watcher after any further push: PASS in all 3 runs (each states it will restart/re-run the watcher script itself after a further push, not merely re-check the head SHA by hand as the RED baseline did).

Every criterion PASSes in all 3 runs. Discriminating criteria are 1, 3, 4
and 5 (each is FAIL in `baseline.md` because the baseline model does not
know the scripts exist at all and invents its own unrelated ad hoc
mechanism instead of using them); all 4 flip to PASS here, consistently
across all 3 reruns. Criterion 2 already PASSed the baseline (the model
reasons soundly about an empty result on its own without needing the
skill) and is excluded from the discriminating count, the same way as any
other already-passing criterion -- not because its GREEN result is weaker,
but because it was never something the skill needed to fix.

All 3 runs also correctly mention `--require` (documented in this round's
SKILL.md update) and the merge-deploy truncation `FAILED:` line, showing
the skill text change is reflected consistently in the model's plan.
