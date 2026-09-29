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

The skill text was revised again in fix round 2 (deriving the base
branch's required checks by default, the "required" vs. "courtesy" wait
distinction, and the required-check-still-pending failure mode), so GREEN
was rerun on the shipped text, 3 times, per the pressure-test method's
repeatability check. Each run's stream-json `system`/`init` message's
`skills` array includes `ship-kit:watching-pr-checks`, confirming the
plugin (and this skill) loaded under `--plugin-dir` with no other
installed plugin present, in all 3 runs.

## Run 1 (verbatim, redacted; tool-use events shown inline, assistant text concatenated)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

The skill for this is `ship-kit:watching-pr-checks`. Plan mode is on, so I haven't run anything yet. Here are the commands and how I'll decide what to report.

## 1. Watch PR 42's checks

It's normal that `gh pr checks 42` prints nothing right now. GitHub takes a moment to register checks on a new commit, so this doesn't mean anything passed.

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

- It checks every 30 seconds. It gives up only after 20 checks in a row (about 10 minutes) with no progress, so the current empty result won't stop it.
- It first looks up which checks the base branch requires. It won't finish while any of those is missing or still running.
- If it can't read that list (exit 1 with `WARNING: could not read required checks ... pass --require`), I'll run it again and name each check that must pass: `... watch-pr-checks.sh 42 --require <name> ...`.
- If a check that isn't required matters to the lead, I'll name it with `--require` too. Otherwise the script won't wait for it if it starts late.
- If I push again, I'll restart the watcher.

**How I'll decide what to report:**
| Result | What I report |
|---|---|
| Exit 0, no `FAILED:` lines | Green. I pass on the summary line (`PR42 checks concluded: pass:N ...`). |
| Exit 0 with `FAILED: <name>` lines | Not green. I pass on the summary and every `FAILED:` line exactly as printed. |
| Exit 1 (no checks appeared, or a required check `never appeared` / `still pending`) | Reported as a problem, not a pass. I also run `gh pr view 42 --json mergeable,mergeStateStatus` and include the result, which shows whether there's a merge conflict or the checks never started. |
| Exit 2 | My arguments were wrong. I fix them and rerun, and nothing gets reported from that run. |

If CI is still running near the one-hour mark, I'll tell the lead it's still running and which checks are left. I won't report it as passing.

## 2. Merge, then watch the merge commit

I'll merge only if step 1 comes back green, using the repo's usual merge method. Then:

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # must be the full 40-char SHA
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh "$SHA"
```

**How I'll decide what to report:**
- **Exit 0 with no `FAILED:` lines:** the merge commit is confirmed. I report `runs for <sha> concluded: ...`.
- **Exit 0 with `FAILED: <name> (<conclusion>)`:** I report each failed run as printed.
- **`FAILED: too many runs to verify ...`:** the list of runs may be incomplete, so I'll report it as not confirmed, never as passing.
- **Exit 1 (`no workflow runs found`):** nothing ran on the merge commit. That's a problem to report, not a pass.
- **Exit 2:** the SHA was short or malformed. I get the full SHA again and rerun.

In both steps, I only call it green on exit 0 with no `FAILED:` lines, and I pass on the output word for word.

## Run 2 (verbatim, redacted)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

The empty `gh pr checks 42` output is expected. Checks take a moment to register after a push, and I won't read the silence as a pass. I'm in plan mode, so none of these commands have run yet.

## 1. Watch PR 42's checks

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

- The script checks every 30 seconds by default. It raises an alarm if 20 checks in a row (about 10 minutes) show no progress. Without an alarm, a stalled check could keep me waiting past the one-hour deadline.
- It works out which checks the base branch requires on its own. It won't finish while any of them is missing or still running.
- If it prints `WARNING: could not read required checks ... pass --require`, I'll run it again and name each check that must pass:
  `... watch-pr-checks.sh 42 --require <check-name> [--require <check-name>]...`
- This working directory isn't a git repo. If `gh` can't tell which repository I mean, I'll set `GH_REPO=<owner>/<repo>` (for the script) or add `-R <owner>/<repo>` (for direct `gh` commands).

**What I report to the lead:**

| Result | What I report | Next step |
|---|---|---|
| Exit 0, no `FAILED:` lines | Green, with the summary line quoted exactly (e.g. `PR42 checks concluded: pass:N ...`) | Merge |
| Exit 0 with `FAILED: <name>` lines | Red, with the summary and every `FAILED:` line quoted exactly | Don't merge; look into the failures |
| Exit 1 (no checks appeared, or a required check never appeared or is `(still pending)`) | A separate problem, not a pass. I also run `gh pr view 42 --json mergeable,mergeStateStatus` and include its output (a merge conflict or a CI trigger that never fired are the usual causes) | Don't merge |

If I push again at any point, I'll restart the watcher, because the checks move to the newest commit.

## 2. Merge (only if step 1 is green)

```bash
gh pr merge 42 --merge   # or --squash / --rebase, matching this repo's convention
```

## 3. Confirm the runs on the merge commit

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # must be the full 40-character SHA
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh "$SHA"
```

**What I report:**

- **Exit 0, no `FAILED:` lines:** the runs on the merge commit are green. I quote the `runs for <sha> concluded: ...` line.
- **Exit 0 with `FAILED: <name> (<conclusion>)`:** red, with each failure listed.
- **Exit 0 with `FAILED: too many runs to verify ...`:** the list of runs may be incomplete, so I won't call it green. I'll report it as unverified.
- **Exit 1 (`no workflow runs found`):** nothing ran on the merge commit. I report that as a problem.
- **Exit 2:** the SHA was short or malformed. I fetch the full SHA again and rerun.

In every case I'll paste the script's summary and `FAILED:` lines exactly as printed. I'll only call a result green when the script exits 0 and prints no `FAILED:` line.

## Run 3 (verbatim, redacted)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

I'm in plan mode, so I haven't run anything yet. This is the plan I'll follow once you approve. It uses the `ship-kit:watching-pr-checks` scripts.

## 1. Watch PR 42's checks now

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

- **Why the empty output isn't a problem:** `gh pr checks` printing nothing ten seconds after a push is normal, because the checks haven't registered yet. The script polls every 30 seconds and allows 20 polls with no progress, so the checks have about 10 minutes to appear. That fits well inside the hour.
- **How it decides it's done:** it reads the base branch's required checks from the ruleset and branch protection. It won't report a result while any required check is missing or still running.
- **If it can't read the required checks** (it prints `WARNING: could not read required checks ... pass --require` and exits 1), I'll rerun it and name each check that must pass:
  `... watch-pr-checks.sh 42 --require <check-name> [--require <check-name>]...`
- **If I push again**, I'll restart the watcher, because the old results belong to the previous commit.

**What I'll report to your lead:**

| Result | Report | Merge? |
|---|---|---|
| Exit 0, no `FAILED:` lines | Green. I'll quote the `PR42 checks concluded: ...` line exactly. | Yes |
| Exit 0 with `FAILED: <name>` lines | Red. I'll quote the summary and every `FAILED:` line. | No |
| Exit 1: no checks appeared, or a required check `(never appeared)` / `(still pending)` | Not green. I'll run `gh pr view 42 --json mergeable,mergeStateStatus` and report it, since a merge conflict or a CI trigger that never fired are the usual causes. | No |

Exit 1 always gets reported as its own problem, never as a pass.

## 2. Merge, then watch the merge commit's runs

After the checks are green, I'll check with you before merging, since merging can't easily be undone. Then:

```bash
gh pr merge 42 --merge        # or whichever merge method the repo uses
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # needs the full 40-character SHA
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh "$SHA"
```

**What I'll report:**
- **Green:** exit 0 and no `FAILED:` lines. I'll quote the `runs for <sha> concluded: ...` line.
- **Red:** any `FAILED: <name> (<conclusion>)` line. I'll report each one exactly as printed.
- **Not verified:** a `FAILED: too many runs to verify ...` line means the list may be incomplete, so I won't call it green.
- **Nothing ran:** exit 1 means no workflow runs appeared for the merge commit. That's a problem to report, not a pass.
- **Bad SHA:** exit 2 means the SHA was short or malformed. I'll fix it and rerun.

Every report will quote the summary line and all `FAILED:` lines word for word.

## Pass criteria (all 3 runs)

1. Runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` (or the resolved plugin path) through `bash`: PASS in all 3 runs.
2. Never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report: PASS in all 3 runs (already passed the baseline too; not a discriminating criterion, but still holds here).
3. Calls the result green only on exit 0 with no `FAILED:` line: PASS in all 3 runs (each states this explicitly for both stages, and correctly extends it to the required-check failure text and the merge-deploy truncation line).
4. Gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`: PASS in all 3 runs.
5. Re-arms the PR watcher after any further push: PASS in all 3 runs (each states it will restart the watcher script after a further push).

Every criterion PASSes in all 3 runs, consistently with the prior fix
round's result. Discriminating criteria remain 1, 3, 4 and 5 (all FAIL in
`baseline.md`, since the baseline model has no knowledge of the scripts at
all); criterion 2 remains excluded as already-passing in the baseline.

All 3 runs also correctly describe the round-2 behavior even though the
prompt does not name it directly: that the script derives the base
branch's required checks itself (run 1: "It first looks up which checks
the base branch requires"; run 2: "It works out which checks the base
branch requires on its own"; run 3: "it reads the base branch's required
checks from the ruleset and branch protection"), that it will not conclude
while one is missing or still pending, and what to do if that derivation
itself fails (`WARNING: could not read required checks ... pass
--require`, rerun with explicit `--require` names) -- showing the SKILL.md
update is reflected consistently in the model's plan, not just present in
the file.
