## CLI version

2.1.284 (Claude Code)

## Command

```
claude -p --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence "$(cat <scratch>/watching-pr-checks-prompt.txt)" < /dev/null
```

Run directory: empty (no files). No `--plugin-dir`.

## Output (verbatim, redacted)

I'm in plan mode, so I haven't run anything. I also can't save the plan file because there's no Write tool in this session, so the plan is below. The working directory isn't a git repo, so every command takes `-R OWNER/REPO` (shown as `$R`). OWNER/REPO is a placeholder; I'll fill it in first.

## Why the empty output doesn't tell us anything yet

Ten seconds after a push, GitHub often hasn't created the check runs yet. An empty `gh pr checks` could mean "not created yet" or "no CI will run at all", and neither of those means passing. So I'll tie everything to the exact commit I pushed and never report green unless check runs actually exist and have finished.

## Phase 1: CI on the PR head

```sh
R="-R OWNER/REPO"
HEAD_SHA=$(gh pr view 42 $R --json headRefOid -q .headRefOid)   # must equal the SHA I pushed
```

**Wait for checks to appear.** Poll every 15s for up to about 5 minutes:
```sh
gh api repos/OWNER/REPO/commits/$HEAD_SHA/check-runs -q .total_count
gh api repos/OWNER/REPO/commits/$HEAD_SHA/status   -q '.statuses|length'     # older-style commit statuses
gh run list $R --commit $HEAD_SHA --json databaseId,workflowName,event,status,conclusion
```

**If nothing appears after about 5 minutes**, find out why before reporting:
- `gh pr view 42 $R --json mergeable,mergeStateStatus`: if the PR has merge conflicts, `pull_request` workflows don't run.
- `gh run list $R --commit $HEAD_SHA --status action_required`: runs may be waiting for someone to approve them.
- `gh workflow list $R` and the `on:` triggers in the workflow files: `branches` or `paths` filters may exclude this change.

**Once checks exist, wait for them to finish:**
```sh
gh pr checks 42 $R --watch --interval 30        # exit code: 0 = all passed, 1 = something failed, 8 = still pending
gh pr checks 42 $R --required --json name,state,bucket,link,workflow
gh pr view 42 $R --json headRefOid -q .headRefOid   # confirm the head is still $HEAD_SHA (nobody pushed after me)
```
For each failure: `gh run view <run-id> $R --log-failed`.

I'll stop waiting at about 45 minutes so there's time to report within the hour.

## Phase 2: Merge

I'll merge only if every required check passed and the head is still `$HEAD_SHA`. The `--match-head-commit` flag makes the merge fail if the PR head moved after I checked it, so I only merge the commit I verified:
```sh
gh pr merge 42 $R --squash --match-head-commit $HEAD_SHA   # squash/merge/rebase: I'll use whatever the repo normally uses
gh pr view 42 $R --json state,mergeCommit -q '.state+" "+.mergeCommit.oid'
MERGE_SHA=...   # the merge commit ID from the line above; state must be MERGED
```
If the repo uses a merge queue or auto-merge, the state won't be MERGED right away. In that case I wait and report it as queued, not merged.

## Phase 3: Runs on the merge commit

Same approach, tied to `$MERGE_SHA`:
```sh
gh run list $R --commit $MERGE_SHA --json databaseId,workflowName,event,status,conclusion   # poll until runs appear
gh run watch <id> $R --exit-status                                                          # once per run
gh api repos/OWNER/REPO/commits/$MERGE_SHA/check-runs -q '.check_runs[]|[.name,.status,.conclusion]|@tsv'
```
If no workflow runs on pushes to the base branch, I'll say so plainly: "no CI runs on the merge commit". I won't call it green.

## What I'll report

Every report includes the SHA, each check's name and result, and links.

| What I see | What I report |
|---|---|
| All required checks finished with success | **Passed** on `<sha>`. Optional checks that were skipped or neutral are listed separately. |
| Any required check failed | **Failed**: the check name, the run link, and a short excerpt from the failing log. I don't merge. |
| Still running when I stop waiting | **Pending**, not passed, with how long it's been running. |
| No checks ever appeared | **No CI ran**, with the reason: merge conflict, waiting for approval, or excluded by trigger filters. |
| PR head changed after my push | Tell the lead, and restart the checks on the new commit before any merge. |

I'll send the lead a first report once the PR checks finish, and a second after the merge-commit runs finish.

**Before I start, I need:** the `OWNER/REPO` name, and the merge method (squash, merge or rebase) if the repo doesn't make it obvious.

## Pass criteria

1. Runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` through `bash`: FAIL (the model does not know the script exists; it hand-rolls `gh pr checks --watch` and `gh api` polling instead).
2. Never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report: PASS (it explicitly treats the empty result as inconclusive and investigates mergeability and trigger filters).
3. Calls the result green only on exit 0 with no `FAILED:` line: FAIL (there is no such exit-code/`FAILED:` contract to honor; the model invents its own ad hoc pass/fail table keyed on `gh pr checks --watch`'s own exit codes, which is a different, unverified contract).
4. Gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`: FAIL (uses `gh pr view --json state,mergeCommit -q '.state+" "+.mergeCommit.oid'` and then hand-rolled `gh run list`/`gh run watch` polling, never `watch-merge-deploy.sh`).
5. Re-arms the PR watcher after any further push: PARTIAL, not counted as PASS (it checks whether the head SHA moved and says it would "restart the checks on the new commit," but this is a manual re-check of `headRefOid`, not re-arming the empty-poll window of a specific watcher script; no watcher script is used in this baseline at all).

This scenario discriminates: without the skill, the model does not know the
repository ships `watch-pr-checks.sh` / `watch-merge-deploy.sh` and invents a
capable-looking but different, ad hoc polling and reporting scheme (criteria
1, 3, 4 fail). Criterion 2 already passes without the skill (the model
reasons soundly about an empty result on its own) and is dropped from the
GREEN discriminating count.
