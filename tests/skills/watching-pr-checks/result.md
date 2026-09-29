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

The stream-json `system`/`init` message's `skills` array includes
`ship-kit:watching-pr-checks`, confirming the plugin (and this skill) loaded
under `--plugin-dir` with no other installed plugin present.

## Output (verbatim, redacted; tool-use events shown inline, assistant text concatenated)

[tool_use: Skill {"skill":"ship-kit:watching-pr-checks"}]

An empty `gh pr checks 42` ten seconds after a push is normal. GitHub hasn't registered the checks for the new commit yet, so it doesn't mean pass or fail. I'm in plan mode, so nothing below has been run yet.

## Step 1: Watch PR 42's checks

```bash
bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42
```

With the defaults it checks every 30 seconds and gives up if no checks appear after 20 checks in a row (about 10 minutes). That covers the gap right after a push. The script only stops once no check is still pending, so I'll watch the output rather than stopping it early.

**What I'll report to your lead:**
- **Exit 0 with no `FAILED:` lines:** CI is green. I'll pass on the summary line exactly as printed (`PR42 checks concluded: pass:N ...`).
- **Exit 0 with `FAILED:` lines:** CI failed. I'll send the summary line and every `FAILED: <name>` line as printed, and I won't merge.
- **Exit 1 (no checks appeared):** I won't call this a pass. I'll run the command below and report its result, since the likely causes are a merge conflict or a CI trigger that didn't fire:
  ```bash
  gh pr view 42 --json mergeable,mergeStateStatus
  ```
- **Exit 2:** I passed the wrong arguments. I'll fix them and start the watcher again.

If checks are still running close to the one-hour deadline, I'll send your lead a progress update from `gh pr checks 42`, clearly marked as not final, and keep the watcher running.

If I push again for any reason, I'll restart the watcher, because `gh pr checks` always follows the newest commit.

## Step 2: Merge, only if Step 1 was green

This needs your go-ahead, because a merge can't easily be undone. Then:

```bash
gh pr merge 42    # using the repo's usual merge method
```

## Step 3: Watch the runs on the merge commit

```bash
SHA=$(gh pr view 42 --json mergeCommit --jq .mergeCommit.oid)   # the full 40-character SHA; a short one matches nothing
bash <plugin-dir>/scripts/watch/watch-merge-deploy.sh "$SHA"
```

**What I'll report:**
- **Exit 0 with no `FAILED:` lines:** every run finished as success, skipped or neutral. I'll pass on the `runs for <sha> concluded: ...` line.
- **Exit 0 with `FAILED: <name> (<conclusion>)` lines:** the merge commit failed. I'll report each of those lines as printed.
- **Exit 1:** no workflow runs happened on the merge commit. I'll report that as a separate problem, not as a pass.
- **Exit 2:** the SHA was short or malformed. I'll fetch it again and rerun.

I'll only call either stage green when the script exits 0 with no `FAILED:` lines, and I'll quote the script's lines as printed rather than summarising them.

## Pass criteria

1. Runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` (or the resolved plugin path) through `bash`: PASS (`bash <plugin-dir>/scripts/watch/watch-pr-checks.sh 42`).
2. Never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report: PASS (already passed the baseline too; not a discriminating criterion, but still holds here).
3. Calls the result green only on exit 0 with no `FAILED:` line: PASS (states this explicitly for both stages).
4. Gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`: PASS (exact command shown, piped into the script as `$SHA`).
5. Re-arms the PR watcher after any further push: PASS ("If I push again for any reason, I'll restart the watcher").

Every criterion PASS. Discriminating criteria (1, 3, 4) each flipped from
FAIL in `baseline.md` to PASS here; criterion 2 already passed the baseline
and is not counted as discriminating.
