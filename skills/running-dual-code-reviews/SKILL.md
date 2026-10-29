---
name: running-dual-code-reviews
description: Use when running a code review by hand with subagents - own changes before a commit, an uncommitted diff or working tree, a local branch before its pull request, or a pull request, including re-reviews after an author's fix rounds - and when briefing a reviewer, acting on a reviewer's report, or posting a round's result.
---

# Running dual code reviews

Every round runs two reviewers, each a separate subagent, over the change's current state. The `converging-code-reviews` skill decides what blocks and when review is done; this skill runs the rounds.

## 1. Two reviewers

- **General:** given the diff, the bar, the last round's findings and, on a pull request, the author's replies. It marks each prior finding fixed, partly fixed, not fixed or disputed, and mutation-checks each fix (`proving-tests-can-fail`).
- **Adversarial:** given the diff and the bar only, never the prior findings; keeping it unanchored is the point. It tries to break the change with concrete inputs, and every finding carries a reproduction.

## 2. The brief

Each brief has these parts, in order:

1. **Goal** and the bar.
2. **Ruled out:** what is already settled.
3. **Copy:** the reviewer's own copy, an export of the commit or a copy of the working tree, never the primary checkout; beside it, a copy of the previous state (the state the last round reviewed, or the merge base in round one). The orchestrator alone fetches and exports.
4. **Run:** every probe, one command with its input, on both copies, so each finding is labelled regression or older.
5. **Safety:** a ban on every git command that writes, by name: `commit`, `checkout`, `switch`, `restore`, `reset`, `stash`, `clean`, `merge`, `rebase`, `cherry-pick`, `revert`, `branch`, `tag`, `worktree`, `pull`, `push`, `fetch`. Network calls go to fakes and recorded fixtures only, never real third-party services. Queries against production systems stay light.
6. **Out of scope:** what is tracked elsewhere.
7. **Report:** a length cap. Each finding is a probe row: command, input, output on each state, file and line, regression or older. Exact inputs and outputs, not prose.

## 3. Reports are claims

Reviewer reports have been wrong before. Before acting on or posting a finding:

1. Check that the copy the reviewer read is the state you meant.
2. Check that every cited commit, file and line exists there.
3. Reproduce the probe yourself, on both states.

## 4. The round loop

1. Keep a ledger: the last reviewed state and, on a pull request, the id of the review posted for it.
2. Start the next round once the next state settles: an author's push unchanged for a while, not the first push.
3. Scale each re-review to the diff since the ledger's state.
4. Stop when `converging-code-reviews` says done.

## 5. Output

**Own changes:** fix the blockers in the same change, then run the next round.

**A pull request:**

1. One review per pull request per round, on the pull request the finding affects; a shared-code finding goes in one review, with pointers from the others.
2. Prior findings' status goes inside the review body only.
3. Immediately before posting, re-read the head. If it moved from the state reviewed, review the new state instead of posting.
4. Request changes only for a blocker on someone else's pull request (the host refuses it on your own); comment otherwise.
5. A later comment leaves an earlier request for changes in place: name the review that needs dismissing and tell the owner.
6. Approval and merge belong to the owner.
