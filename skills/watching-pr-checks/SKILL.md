---
name: watching-pr-checks
description: Use when waiting for a pull request's CI checks to finish after a push, or for the workflow runs on a merge commit to finish, before reporting a result or taking the next step.
---

# Watching PR checks

Two scripts poll GitHub through `gh` and end with one result, so a wait never
ends in silence that looks like success. Run each through `bash`, under the
Monitor tool when it is available, otherwise as a foreground command.

## After a push: the PR's checks

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh <pr> [poll-seconds] [max-empty-polls] [--require <name>]...
```

Defaults: a poll every 30 seconds; the alarm after 20 consecutive polls with
no checks. Once every known check is non-pending it waits once more (a
settle interval) and re-polls, so a check that registers late is still
waited for; it only concludes once two polls in a row see the same set of
check names. Pass `--require <name>` (repeatable) to name a required check
by its exact name when you know one should run: the watcher keeps polling
until that name appears, and reports it as failed at the alarm timeout if
it never does.

| Exit | Output | Meaning |
|---|---|---|
| 0 | `PR<n> checks concluded: <bucket>:<count> ...`, then one `FAILED: <name>` per failed or cancelled check | nothing is pending, and every `--require`d check appeared |
| 1 | `PR<n>: no checks appeared after <k> polls ...`, or a summary with `FAILED: <name> (never appeared)` for a missing required check | no check registered, or a required check never showed up: the PR may have a merge conflict or the trigger did not fire; run `gh pr view <pr> --json mergeable,mergeStateStatus` and report it |
| 2 | a usage line on stderr | fix the arguments |

Re-arm the watcher after every push: `gh pr checks` follows the newest
commit, and a fresh push shows no checks for a moment, which the empty-poll
window absorbs.

## After a merge: the merge commit's runs

Get the merge commit's full SHA; a short SHA matches nothing:

```bash
gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid
bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-merge-deploy.sh <40-character-sha> [poll-seconds] [max-empty-polls]
```

| Exit | Output | Meaning |
|---|---|---|
| 0 | `runs for <sha> concluded: <name>:<conclusion> ...`, then one `FAILED: <name> (<conclusion>)` per run that did not end success, skipped or neutral | every run completed; a `FAILED: too many runs to verify ...` line means the run list came back at its limit and may be incomplete -- never treat that as green |
| 1 | `no workflow runs found for <sha> after <k> polls` | nothing ran on the commit; report it |
| 2 | stderr names the full-SHA requirement | the SHA was short or malformed |

## Reporting

Report the summary line and every `FAILED:` line as printed. The result is
green only on exit 0 with no `FAILED:` line; exit 1 is reported as its own
problem, never as a pass.
