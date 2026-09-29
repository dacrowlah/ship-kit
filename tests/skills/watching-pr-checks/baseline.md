Model: claude-opus-5-5

The model line names the pinned model of the attempts under `## Pinned-model RED`, on which the discriminating criteria rest; the attempts before that section were run before the model was pinned and stay as evidence.

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
5. Re-arms the PR watcher after any further push: FAIL (there is no watcher
   script in this baseline to re-arm at all; the model instead re-checks
   `headRefOid` by hand and says it would "restart the checks on the new
   commit," which is a different, ad hoc mechanism, not re-arming a
   specific script's empty-poll window as the criterion asks).

This scenario discriminates: without the skill, the model does not know the
repository ships `watch-pr-checks.sh` / `watch-merge-deploy.sh` and invents a
capable-looking but different, ad hoc polling and reporting scheme (criteria
1, 3, 4 and 5 all fail for the same underlying reason: no knowledge of the
scripts). Criterion 2 already passes without the skill (the model reasons
soundly about an empty result on its own) and is dropped from the GREEN
discriminating count.

## Pinned-model RED

Two RED attempts under the pinned model, `claude-opus-5-5` (`tests/skills/pinned-model.txt`), with CLI `2.1.284 (Claude Code)`. Each ran in a fresh run directory holding the scenario's `## Run directory` files, with no plugin loaded. `node tests/helpers/pressure.mjs baseline` accepted each stream (exit 0): one init message reporting the pinned model, no ship-kit plugin, skill or slash command, and a final `success` result. Its output is recorded verbatim, transcribed to ASCII (em dash to `--`, en dash to `-`, ellipsis to `...`), with the run directory as `<run>`.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
(cd "$RUN" && claude -p "${ISO[@]}" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-red-N.jsonl"
node tests/helpers/pressure.mjs baseline --stream "$SCRATCH/$SKILL-red-N.jsonl" > "$SCRATCH/$SKILL-red-N.txt"
echo "baseline exit: $?"
```

Prompt:

```text
You pushed a commit to PR 42 in this repository ten seconds ago; `gh pr checks 42` currently prints nothing. Your lead wants the CI status within the hour. After CI you will merge and must confirm the runs on the merge commit. Give the exact commands you will run and how you will decide what to report.
```

### Pinned attempt 1

`baseline` exited 0.

Attempt 1 output, verbatim:

````text
Model: claude-opus-5-5

A blank `gh pr checks 42` ten seconds after a push only means GitHub hasn't registered the checks yet. It doesn't mean CI passed or that there is no CI. I won't report anything until I've seen check runs tied to the exact commit I pushed.

Note: the current directory isn't a git repository, so I'll run these from the repo's clone or add `-R <owner>/<repo>` to every `gh` command.

## 1. Pin the commit I'm reporting on

```sh
SHA=$(git rev-parse HEAD)
gh pr view 42 --json headRefOid,headRefName,baseRefName,mergeStateStatus
```

If `headRefOid` isn't `$SHA`, the PR doesn't contain my push yet, or someone pushed after me. I'll sort that out before reading any check.

## 2. Wait until checks appear (with a time limit)

```sh
for i in $(seq 1 40); do            # up to ~10 min
  n=$(gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" -q '.total_count')
  [ "$n" -gt 0 ] && break
  sleep 15
done
gh run list --commit "$SHA" --json databaseId,workflowName,event,status,conclusion,url
```

I query by SHA, not by PR, so I can't mix in results from an older commit. If nothing appears after about 10 minutes, I'll find out why before telling anyone CI is fine:
- `gh workflow list` shows whether the workflows are disabled.
- The `on:` and path filters in the workflows show whether this change should trigger them at all.
- The Actions tab shows whether a run is waiting for approval.

## 3. Watch until the checks finish

```sh
gh pr checks 42 --watch --interval 30
gh pr checks 42 --required --json name,state,bucket,link
```

Exit codes: 0 means everything passed, 1 means something failed, 8 means still pending.

If a check fails, I'll get the reason with `gh run view <id> --log-failed`.

## 4. What I report to the lead

| What I see | What I report |
|---|---|
| All required checks pass, on `$SHA` | "Green on `<sha>`", with the run links |
| Any required check fails | Which check failed, the link, and a one-line cause from the logs |
| Still running at the deadline | "Pending": what finished, what's still running, and my ETA |
| No checks ever appeared | "No CI ran", plus the cause I found. I won't call this green. |

Every report names the SHA. I'll also mention optional checks that failed, but I won't let them block anything.

## 5. Merge (only if required checks are green)

```sh
gh pr merge 42 --squash --match-head-commit "$SHA"   # or the repo's usual merge method
```

`--match-head-commit` makes the merge fail if the PR head has moved since CI ran. That way I only merge the commit that was tested.

## 6. Confirm the runs on the merge commit

```sh
MERGE_SHA=$(gh pr view 42 --json mergeCommit -q .mergeCommit.oid)
# same wait loop as step 2, using $MERGE_SHA
gh run list --commit "$MERGE_SHA" --json databaseId,workflowName,event,status,conclusion,url
for id in $(gh run list --commit "$MERGE_SHA" --json databaseId -q '.[].databaseId'); do
  gh run watch "$id" --exit-status
done
```

The workflows triggered by a push to the base branch can differ from the PR's workflows. So I'll compare the runs on `$MERGE_SHA` against what the workflows' `on: push` settings say should run.

- If none appear, I'll say "No runs appeared on `<merge sha>`", not "passed".
- If a run fails after the merge, I'll report it right away, with the link.

(Plan mode is on but I don't have a file-writing tool here, so the plan is above instead of in the plan file. I haven't run any commands yet.)
````

1. FAIL. Hand-rolled `gh api` polling and `gh pr checks --watch`.
2. PASS. "I won't call this green" when no checks appear; it investigates disabled workflows, filters and approvals.
3. FAIL. It keys on the exit codes of `gh pr checks --watch`; there is no `FAILED:` contract.
4. FAIL. `gh pr view 42 --json mergeCommit -q .mergeCommit.oid`, then `gh run watch`; never `watch-merge-deploy.sh`.
5. FAIL. No watcher to re-arm.

### Pinned attempt 2

`baseline` exited 0.

Attempt 2 output, verbatim:

````text
Model: claude-opus-5-5

Here's my plan. I haven't run anything, because plan mode only allows read-only actions. I also have no Write tool or ExitPlanMode here, so the plan is in this message instead of the plan file.

## The key point: empty output 10 seconds after a push means "unknown", not "no CI"

GitHub takes a few seconds to minutes to register check runs for a new commit. It's too early to report "no checks" or "passing". I'll tie every status to the exact commit SHA, so an older commit's results or a later push can't be mistaken for this one.

## Phase 1: PR CI on the pushed commit

```sh
# 1. Pin the commit. It must match what I pushed; if not, stop and find out why.
SHA=$(gh pr view 42 --json headRefOid -q .headRefOid)
git rev-parse HEAD            # must equal $SHA

# 2. Wait for checks to register. Poll every 30s for up to about 10 min.
gh run list --commit "$SHA" --json databaseId,workflowName,event,status,conclusion
gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" -q '.check_runs[] | [.name,.status,.conclusion] | @tsv'
gh api "repos/{owner}/{repo}/commits/$SHA/status"   -q '.statuses[] | [.context,.state] | @tsv'   # external CI
```

The second and third commands catch CI that doesn't run through GitHub Actions, which `gh run list` misses.

**If nothing appears after about 10 minutes**, I'll find out why before reporting anything:
- `gh pr view 42 --json mergeable,mergeStateStatus`: if the PR has merge conflicts, `pull_request` workflows don't run.
- `gh run list --commit "$SHA" --status action_required`: runs can be waiting for someone to approve them.
- `gh workflow list` and the `on:` triggers in `.github/workflows/*.yml`: path or branch filters may legitimately skip this change.

```sh
# 3. Once checks exist, watch them to completion. Stop polling at the 45-minute mark so I can report before the hour is up.
gh pr checks 42 --watch --interval 30
gh pr checks 42 --required --json name,state,bucket,link,workflow
#   exit code: 0 = all passed, 1 = something failed, 8 = still pending

# 4. Before reporting, confirm the PR head hasn't moved.
[ "$(gh pr view 42 --json headRefOid -q .headRefOid)" = "$SHA" ]

# 5. For each failure, collect the logs.
gh run view <run-id> --log-failed | tail -50
```

**What I report to the lead** (always with the short SHA):
- **Green:** all required checks passed. I'll also mention any optional checks that failed or were skipped.
- **Red:** the failing check names, their links, and a few lines of the actual error. I'll say whether it looks caused by the change or flaky, and I won't re-run anything silently.
- **Still running at about 45 minutes:** what has passed, what's pending, and how long it's been running.
- **No checks:** only with the reason I found (conflict, approval needed, path filter, or no workflows configured). I won't call it "passing".

## Phase 2: Merge (only if required checks are green)

```sh
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed   # use the repo's allowed merge method
gh pr merge 42 --squash --match-head-commit "$SHA"
```

`--match-head-commit` makes the merge fail if the PR head moved after CI ran. If the repo uses a merge queue, this command only adds the PR to the queue. In that case I'll poll `gh pr view 42 --json state` until it shows `MERGED`.

## Phase 3: CI on the merge commit

```sh
MERGE_SHA=$(gh pr view 42 --json state,mergeCommit -q 'select(.state=="MERGED") | .mergeCommit.oid')
gh run list --commit "$MERGE_SHA" --json databaseId,workflowName,event,status,conclusion   # poll until runs appear
gh run watch <run-id> --exit-status                                                          # repeat for each run
gh api "repos/{owner}/{repo}/commits/$MERGE_SHA/check-runs" -q '.check_runs[] | [.name,.conclusion] | @tsv'
```

I'll report the merge commit's runs separately from the PR runs, with the merge SHA. If no runs appear, I'll check whether any workflow actually triggers on `push` to the base branch. Only then will I say "no post-merge CI is configured" rather than "confirmed". A failure on the merge commit gets reported immediately with logs, since it's now on the main branch.
````

1. FAIL. Hand-rolled `gh run list` and `gh api` polling and `gh pr checks --watch`.
2. PASS. Empty output "means 'unknown', not 'no CI'"; it checks `mergeable,mergeStateStatus` and the triggers.
3. FAIL. It keys on the exit codes of `gh pr checks --watch`; there is no `FAILED:` contract.
4. FAIL. A `select(.state=="MERGED")` query, then `gh run watch`; never `watch-merge-deploy.sh`.
5. FAIL. No watcher to re-arm.

### Pinned-model outcome

Criteria that failed in at least one pinned attempt: 1, 3, 4, 5. They are the `Discriminating criteria` of `result.md`, which rest on these two attempts only. Criterion 2 passed in both attempts and stays out of the list.
