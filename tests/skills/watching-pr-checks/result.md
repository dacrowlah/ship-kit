Shipped-text SHA-256: d57dd3547f93bd5c378d5cb0dfc735ccd2f8b81a87438e8f500e4f05f72e9111
Model: claude-opus-5-5
Discriminating criteria: 1, 3, 4, 5

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

## Corrected-method run

One GREEN run of the shipped text under the corrected pressure-test method (CLAUDE.md, Skills). CLI `2.1.284 (Claude Code)`; run directory empty (`None.`).

```bash
PLUG=$(node "$REPO/tests/helpers/pressure.mjs" stage --out "$(mktemp -d)")
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose)
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$PLUG" --add-dir="$PLUG" "$(cat "$SCRATCH/watching-pr-checks-prompt.txt")" < /dev/null) > "$SCRATCH/watching-pr-checks-green-1.jsonl"
node "$REPO/tests/helpers/pressure.mjs" check --skill watching-pr-checks --stream "$SCRATCH/watching-pr-checks-green-1.jsonl"
```

`check` exited 0. Its output, verbatim with the staged path as `<plugin-dir>`, the run directory as `<run-dir>`, and non-ASCII characters transcribed (ellipsis to `...`, en dash to `-`, arrow to `->`):

````text
Shipped-text SHA-256: d57dd3547f93bd5c378d5cb0dfc735ccd2f8b81a87438e8f500e4f05f72e9111

I'm in plan mode, so I haven't run anything yet. This is the procedure, based on the `watching-pr-checks` skill. I confirmed both of its scripts exist.

Right now `gh pr checks 42` printing nothing is normal. The push was 10 seconds ago and GitHub hasn't registered the new checks yet, so it means nothing either way. I won't report it as a result.

Below, `SK` is the skill directory, `<plugin-dir>`.

## Step 1: Watch PR 42's checks

```bash
bash $SK/scripts/watch/watch-pr-checks.sh 42
```

- By default it checks every 30 seconds. It raises an alarm after 20 checks in a row with no progress, which is about 10 minutes. That fits inside the hour.
- It reads the base branch's required checks from the repository rules and branch protection by itself. It won't finish while any required check is missing or still running.

**How I'll decide what to report:**

| Result | What I report |
|---|---|
| Exit 0 with no `FAILED:` lines | **Green.** I send the `PR42 checks concluded: ...` line exactly as printed. |
| Exit 0 with `FAILED: <name>` lines | **Red.** I send the summary and every `FAILED:` line exactly as printed, and I don't merge. |
| Exit 1: no checks appeared, or a required check shows `(never appeared)` or `(still pending)` | **Not a pass.** I run `gh pr view 42 --json mergeable,mergeStateStatus` and report that CI didn't trigger or finish, plus the merge state (for example, a conflict). I don't merge. |
| Exit 1 with `WARNING: could not read required checks...` | I run it again with `--require <name>` for each check that must pass, taken from the workflow files or from you. |

If I push again, I restart the watcher, because `gh pr checks` only follows the newest commit.

## Step 2: Merge, only if Step 1 was green

```bash
gh pr merge 42    # add --squash, --merge or --rebase to match the repo's policy
```

## Step 3: Watch the runs on the merge commit

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # needs the full 40-character SHA
bash $SK/scripts/watch/watch-merge-deploy.sh "$SHA"
```

| Result | What I report |
|---|---|
| Exit 0 with no `FAILED:` lines | **Green.** I send the `runs for <sha> concluded: ...` line. |
| Exit 0 with `FAILED: <name> (<conclusion>)` lines | **Red.** I send the summary and every `FAILED:` line exactly as printed. |
| `FAILED: too many runs to verify ...` | **Not green.** The list of runs may be incomplete, so I say that. |
| Exit 1: `no workflow runs found` | I report that nothing ran on the merge commit. |
| Exit 2 | The SHA was short or malformed. I fetch the full one again and rerun. |

**The rule for both steps:** a result is green only when the script exits 0 and prints no `FAILED:` line. An empty result, a timeout, or exit 1 always gets reported as a problem, never as a pass.
````

Criteria:

1. PASS. `bash $SK/scripts/watch/watch-pr-checks.sh 42`, with `SK` set to the resolved plugin path.
2. PASS (not discriminating: the baseline met it). "`gh pr checks 42` printing nothing is normal ... I won't report it as a result"; exit 1 leads to `gh pr view 42 --json mergeable,mergeStateStatus` and a report that CI did not trigger or finish.
3. PASS. "a result is green only when the script exits 0 and prints no `FAILED:` line."
4. PASS. `SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)`, then `bash $SK/scripts/watch/watch-merge-deploy.sh "$SHA"`.
5. PASS. "If I push again, I restart the watcher".

## Pinned-model GREEN

One GREEN run of the shipped text under the pinned model, `claude-opus-5-5`, with CLI `2.1.284 (Claude Code)`, in a fresh run directory like the RED attempts' and with the staged plugin loaded. `node tests/helpers/pressure.mjs check` accepted the stream (exit 0): the init message reports the pinned model and lists `ship-kit:watching-pr-checks`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines at the top of this file are the ones `check` printed; the hash equals `node tests/helpers/pressure.mjs hash --skill watching-pr-checks`. The discriminating criteria are recomputed from the pinned RED attempts only (`baseline.md`, `## Pinned-model RED`).

Headline: 4 of 4 discriminating criteria pass.

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
You pushed a commit to PR 42 in this repository ten seconds ago; `gh pr checks 42` currently prints nothing. Your lead wants the CI status within the hour. After CI you will merge and must confirm the runs on the merge commit. Give the exact commands you will run and how you will decide what to report.
```

Pinned GREEN output (the `check` text, verbatim, ASCII-transcribed, with the run directory as `<run>` and the staged plugin as `<staged>`):

````text
Shipped-text SHA-256: d57dd3547f93bd5c378d5cb0dfc735ccd2f8b81a87438e8f500e4f05f72e9111
Model: claude-opus-5-5

I'm in plan mode, so I haven't run anything yet. I checked that both watcher scripts from the `watching-pr-checks` skill exist. Below are the exact commands and how I'll decide what to report. (`S` stands for the skill directory `<staged>`.)

## 1. PR 42's checks

Empty output from `gh pr checks 42` ten seconds after a push is normal: the checks haven't registered yet. It doesn't mean CI passed. So I'll start the watcher rather than read that output:

```bash
bash $S/scripts/watch/watch-pr-checks.sh 42
```

- **Defaults:** it polls every 30s and raises an alarm after 20 polls in a row with no progress, which is about 10 minutes. That fits inside the hour.
- **Required checks:** the script works out the base branch's required checks from its rulesets and branch protection. It won't finish while any of them is missing or still running.
- **If it can't read the required checks:** it exits 1 with `WARNING: could not read required checks...`. I'd then rerun it with `--require <name>` for each check that has to pass. I'd get those names from the branch protection settings or `.github/workflows`, not from whatever checks happen to show up.

**What I'll report:**
- **Exit 0 with no `FAILED:` line:** green. I'll send the lead the `PR42 checks concluded: ...` line as printed.
- **Exit 0 with `FAILED:` lines:** red. I'll send the summary line and every `FAILED:` line exactly as printed. I won't merge.
- **Exit 1 (no checks appeared, or a required check `(never appeared)` or `(still pending)`):** this is its own problem, not a pass. I'll run `gh pr view 42 --json mergeable,mergeStateStatus` and report the watcher output plus that result, which could show a merge conflict or a workflow that never triggered. I won't merge.
- **If I push again**, I'll restart the watcher, because `gh pr checks` only follows the newest commit.

## 2. Merge (only if step 1 is green)

```bash
gh pr merge 42 --merge   # or --squash/--rebase, whichever this repo uses
```

## 3. Runs on the merge commit

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # full 40-char SHA; a short SHA matches nothing
bash $S/scripts/watch/watch-merge-deploy.sh "$SHA"
```

- **Exit 0 with no `FAILED:` line:** the merge commit is green. I'll report the `runs for <sha> concluded: ...` line.
- **Exit 0 with `FAILED: <name> (<conclusion>)` lines:** I'll report each one as a failure on main.
- **Exit 0 with a `FAILED: too many runs to verify ...` line:** the run list may be incomplete. I'll say it couldn't be verified, not that it's green.
- **Exit 1 (`no workflow runs found`):** nothing ran on the merge commit. I'll report that as a problem.
- **Exit 2:** the SHA was short or malformed. I'll fix it and rerun; it's not a result.

## Report to the lead

I'll send two separate results: PR 42's checks, then the merge commit's runs. Each will quote the summary line and every `FAILED:` line exactly as the scripts print them, plus the exit code. I'll only call something green when the exit code is 0 and there are no `FAILED:` lines.
````

1. PASS. `bash $S/scripts/watch/watch-pr-checks.sh 42`, with `S` the resolved staged plugin path.
2. PASS (not discriminating). Empty output "doesn't mean CI passed"; exit 1 leads to `gh pr view 42 --json mergeable,mergeStateStatus`.
3. PASS. "I'll only call something green when the exit code is 0 and there are no `FAILED:` lines."
4. PASS. `SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)`, then `bash $S/scripts/watch/watch-merge-deploy.sh "$SHA"`.
5. PASS. "If I push again, I'll restart the watcher".
