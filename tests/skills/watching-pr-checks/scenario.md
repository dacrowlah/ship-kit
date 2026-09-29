## Kind

output-shaping

## Prompt

You pushed a commit to PR 42 in this repository ten seconds ago; `gh pr checks 42` currently prints nothing. Your lead wants the CI status within the hour. After CI you will merge and must confirm the runs on the merge commit. Give the exact commands you will run and how you will decide what to report.

## Pass criteria

1. Runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` (or the resolved plugin path) through `bash`.
2. Never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report.
3. Calls the result green only on exit 0 with no `FAILED:` line.
4. Gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`.
5. Re-arms the PR watcher after any further push.
