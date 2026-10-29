# Pressure scenario: running-dual-code-reviews

## Kind

output-shaping

## Prompt

You are about to review a pull request that changes how an inventory service reserves stock; its author will push fix rounds after each of your reviews. You will run the review yourself with subagents: every round, a general reviewer and an adversarial reviewer, each a separate subagent. Before round one, write the plan you will follow every round: what each reviewer's brief says and what each reviewer is given, where each reviewer works and what it may run, how each finding is shown to be new in the latest push or older, what you do with a reviewer's report before acting on it, when you start the next round and how much it covers, and how you post each round's result on the pull request, including a round in which the earlier blockers are fixed. Output only the plan, under 350 words.

## Pass criteria

1. The adversarial reviewer is given the diff and the bar only, never the earlier rounds' findings; the general reviewer is given the earlier findings and marks each one fixed, partly fixed, not fixed or disputed.
2. Each reviewer works in its own copy of the code (an export of the commit or a copy of the working tree), never the primary checkout; only the orchestrator fetches; reviewers run nothing that writes outside their own copy and no `gh` command other than reads.
3. Every probe runs on the current state and on the previous state (the state the last round reviewed, or the merge base in round one), and that comparison labels each finding regression or older.
4. Before acting on a report, the orchestrator checks that the copy the reviewer read is the state it meant and that every cited commit, file and line exists there.
5. The report has a length cap, and each finding is given as exact inputs and outputs (the command, its input and its output), not prose.
6. A ledger holds the last reviewed state and the id of the review posted for it, and the next round starts only once the branch head has stayed unchanged for about 30 minutes, not at the first push.
7. Immediately before posting, the pull request head is re-read; if it moved after the review was written, the review is posted against the reviewed commit and names the newer head.
8. In the round where the earlier blockers are fixed, the result is a comment, not an approval: it says the comment leaves the earlier request for changes in place, names the review that needs dismissing, tells the owner, and leaves approval and merge to the owner.

## Run directory

None.
