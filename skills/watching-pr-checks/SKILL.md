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

Defaults: a poll every 30 seconds; the alarm after 20 consecutive polls that
make no progress toward every required check being satisfied.

Before polling, the script derives the base branch's required check names by
itself (a repository ruleset's `required_status_checks` contexts, unioned
with classic branch protection's contexts) and never concludes while one of
them is missing or still pending, however many polls that takes -- this,
not a timer, is what makes "concluded" a real guarantee. Add more names with
`--require <name>` (repeatable); they are always included in addition to
whatever was derived. A required check that never appears, or that is still
pending when the alarm fires, is reported FAILED at that point, not left to
hang.

A check that is **not** required only gets a courtesy wait: once every
required name is satisfied and nothing else is pending, the script waits one
settle interval and polls once more, concluding only if the same check
names still show up. A non-required check that first registers more than
one settle interval after that point is **not** waited for and can be
missing from the summary; name it with `--require` if it matters.

If deriving the required set fails for a reason other than "this branch has
no rules of this kind" (a 404), the script warns on stderr and exits nonzero
unless you already passed at least one `--require` -- it never silently
treats whatever happened to appear as the full picture.

| Exit | Output | Meaning |
|---|---|---|
| 0 | `PR<n> checks concluded: <bucket>:<count> ...`, then one `FAILED: <name>` per failed or cancelled check | nothing is pending, and every required check appeared and is no longer pending |
| 1 | `PR<n>: no checks appeared after <k> polls ...`, or a summary with `FAILED: <name> (never appeared)` / `FAILED: <name> (still pending)` for a required check | no check registered, or a required check never showed up or never finished: the PR may have a merge conflict or the trigger did not fire; run `gh pr view <pr> --json mergeable,mergeStateStatus` and report it |
| 1 | `WARNING: could not read required checks for <base>; pass --require` on stderr | the derivation itself failed (not a 404); rerun with `--require <name>` for every check that must pass |
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
