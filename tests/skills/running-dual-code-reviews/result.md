# Result (GREEN): running-dual-code-reviews

Shipped-text SHA-256: 2d45fad8467feb63e3bb5415e1e9fc52bdb6058567f61862a53088224f76a2e0
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3, 4, 5, 6, 7, 8

Headline: 8 of 8 discriminating criteria pass.

CLI: `2.1.284 (Claude Code)`. A fresh, empty run directory like the RED attempts', the same `ISO` flags and the prompt of `scenario.md`. The plugin is the staged copy (`dependencies` deleted), loaded with `--plugin-dir` and readable through `--add-dir=`. `node tests/helpers/pressure.mjs check` accepted the stream (exit 0): the init message reports the pinned model and lists `ship-kit:running-dual-code-reviews` and one ship-kit plugin at the content-addressed staged path, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines above are the ones `check` printed; the hash equals `node tests/helpers/pressure.mjs hash --skill running-dual-code-reviews` over the repository's shipped text.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
RUN=$(cd "$(mktemp -d)" && pwd -P)
PLUG=$(cd "$(mktemp -d)" && pwd -P)
STAGED=$(node tests/helpers/pressure.mjs stage --out "$PLUG")
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$STAGED" --add-dir="$STAGED" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green-N.jsonl"
node tests/helpers/pressure.mjs check --skill "$SKILL" --stream "$SCRATCH/$SKILL-green-N.jsonl" > "$SCRATCH/$SKILL-green-N.txt"
echo "check exit: $?"
```

Prompt:

```text
You are about to review a pull request that changes how an inventory service reserves stock; its author will push fix rounds after each of your reviews. You will run the review yourself with subagents: every round, a general reviewer and an adversarial reviewer, each a separate subagent. Before round one, write the plan you will follow every round: what each reviewer's brief says and what each reviewer is given, where each reviewer works and what it may run, how each finding is shown to be new in the latest push or older, what you do with a reviewer's report before acting on it, when you start the next round and how much it covers, and how you post each round's result on the pull request, including a round in which the earlier blockers are fixed. Output only the plan, under 350 words.
```

## GREEN run 1

The run ended `success` after 3 turns. Its one tool call was `Skill` (`ship-kit:running-dual-code-reviews`).

Run 1 output, verbatim (the `check` text; it was already ASCII and held no local path):

```text
Shipped-text SHA-256: 2d45fad8467feb63e3bb5415e1e9fc52bdb6058567f61862a53088224f76a2e0
Model: claude-opus-5-5

# Review plan for the stock-reservation PR (used every round)

**Reviewers (two separate subagents per round)**
- **General reviewer.** Gets the diff, the bar (stock is never oversold or double-reserved, reservations are released on failure, behaviour under concurrency is correct), the previous round's findings and the author's replies. It marks each earlier finding as fixed, partly fixed, not fixed or disputed. For each fix it checks that the new test fails when the fix is reverted.
- **Adversarial reviewer.** Gets only the diff and the bar, never the earlier findings. Its job is to break reservation using concrete inputs: concurrent reserves, zero or negative quantities, retries, and partial failures. Every finding comes with a reproduction.

**Brief, in order:** goal and bar; what is already settled; copies; how to run probes; safety rules; out of scope (tracked elsewhere); report format. Reports are capped at about 400 words. Each finding is one row: command, input, output on each state, file and line, and "regression" or "older".

**Where reviewers work and what they may run**
- I do all fetching and exporting. Each reviewer gets its own export of the head commit plus a copy of the previous state: the merge base in round one, and after that the last reviewed commit. Neither works in the main checkout.
- They may read files and run tests and probes. They may not run any git command that writes: commit, checkout, switch, restore, reset, stash, clean, merge, rebase, cherry-pick, revert, branch, tag, worktree, pull, push, fetch.
- Databases and network calls go only to fakes or recorded fixtures. Any queries against production stay light.

**New or older:** every probe runs on both copies. If it fails only on the head, it's a regression from the latest push. If it fails on both, it's older.

**Before acting on a report:** I confirm the reviewer read the state I intended and that every commit, file and line it cites exists there. Then I re-run each probe myself on both states. Anything I can't reproduce gets dropped.

**When the next round starts and what it covers**
- I keep a ledger of the last reviewed commit and the ID of the review posted for it.
- A new round starts once the author's push has been unchanged for a while, not on the first push.
- Each round covers the diff since the ledger commit, plus whatever code that diff touches.
- Rounds stop when no blockers remain.

**Posting each round**
- One review per round on this PR. The status of earlier findings goes in the review body only.
- Right before posting, I check the head again. If it has moved, I review the new state instead of posting.
- If there are blockers, I post "Request changes". Otherwise I post a comment.
- **Round where earlier blockers are fixed:** I post a comment listing each blocker as fixed, with its verifying probe, plus any non-blocking notes. A comment doesn't clear the earlier "Request changes", so I name that review by ID and tell the owner it needs dismissing. Approval and merge stay with the owner.
```

| Criterion | Result |
|---|---|
| 1. Adversarial reviewer unanchored; general reviewer marks each prior finding | PASS ("Gets only the diff and the bar, never the earlier findings."; "It marks each earlier finding as fixed, partly fixed, not fixed or disputed.") |
| 2. Own copy, orchestrator fetches, write commands banned by name | PASS ("I do all fetching and exporting. Each reviewer gets its own export of the head commit"; "Neither works in the main checkout."; "They may not run any git command that writes: commit, checkout, switch, restore, reset, stash, clean, merge, rebase, cherry-pick, revert, branch, tag, worktree, pull, push, fetch.") |
| 3. Every probe on both states labels the finding | PASS ("every probe runs on both copies. If it fails only on the head, it's a regression from the latest push. If it fails on both, it's older."; the previous state is "the merge base in round one, and after that the last reviewed commit") |
| 4. Copy and citations checked before acting | PASS ("I confirm the reviewer read the state I intended and that every commit, file and line it cites exists there.") |
| 5. Length cap; exact inputs and outputs | PASS ("Reports are capped at about 400 words. Each finding is one row: command, input, output on each state, file and line") |
| 6. Ledger with the review id; wait for the push to settle | PASS ("I keep a ledger of the last reviewed commit and the ID of the review posted for it."; "A new round starts once the author's push has been unchanged for a while, not on the first push.") |
| 7. Head re-read before posting | PASS ("Right before posting, I check the head again. If it has moved, I review the new state instead of posting.") |
| 8. Fixed-blocker round: comment, dismissal named, approval left to the owner | PASS ("I post a comment listing each blocker as fixed"; "A comment doesn't clear the earlier \"Request changes\", so I name that review by ID and tell the owner it needs dismissing. Approval and merge stay with the owner.") |

## GREEN run 2

A second run of the same text, same method, to check the shape holds. `check` exited 0 with the same hash. The run ended `success` after 3 turns; its one tool call was `Skill` (`ship-kit:running-dual-code-reviews`).

Run 2 output, verbatim (the `check` text; it was already ASCII and held no local path):

```text
Shipped-text SHA-256: 2d45fad8467feb63e3bb5415e1e9fc52bdb6058567f61862a53088224f76a2e0
Model: claude-opus-5-5

# Dual-review plan for the stock-reservation PR

**Reviewers (both new subagents every round)**
- **General reviewer.** Receives the diff, the bar (correct stock reservation: no overselling, no lost or double reservations under concurrency, retries or rollback), last round's findings and the author's replies. It marks each prior finding fixed, partly fixed, not fixed or disputed. It mutation-checks each fix's test to show the test can fail.
- **Adversarial reviewer.** Receives only the diff and the bar, never prior findings, so earlier rounds don't steer it. It tries to break the change with concrete inputs: concurrent reservations, zero or negative quantities, partial failures. Every finding carries a reproduction.

**Brief order (same for both):** goal and bar; what's already ruled out; their copies; how to run probes; safety rules; what's out of scope; report format.

**Where they work and what they may run**
- I alone fetch and export. Each reviewer gets its own export of the head commit, plus an export of the previous state: the merge base in round one, then the last reviewed commit. Neither touches the main checkout.
- They may run tests and probes. They may not run any git command that writes: commit, checkout, switch, restore, reset, stash, clean, merge, rebase, cherry-pick, revert, branch, tag, worktree, pull, push, fetch.
- Network calls go only to fakes and recorded fixtures. Any production queries stay light.

**New or older:** every probe runs as one command with its input on both copies. A finding is a "regression" if it fails only on the new state, and "older" if it fails on both.

**Report format:** capped length. One row per finding: command, input, output on each state, file:line, and the regression/older label.

**Before acting on a report:** I check that the reviewer read the state I meant, and that every cited commit, file and line exists there. Then I reproduce each probe myself on both states. Anything I can't reproduce is dropped.

**Next round:** I keep a ledger of the last reviewed commit and the id of its posted review. A round starts when the author's push has stayed unchanged for a while, not at the first push. Each round's scope matches the diff since the ledger commit. I stop when the convergence criteria say review is done.

**Posting**
- One review per round. Prior findings' status goes in the review body only.
- Right before posting, I re-read the head. If it has moved, I review the new state instead of posting.
- Request changes only for a reproduced blocker; otherwise comment.
- **Round where the earlier blockers are fixed:** I post a comment review that marks each blocker fixed with its evidence. My earlier request-changes review stays in place, so I name it and tell the owner it needs dismissing. Approval and merge stay with the owner.
```

All eight criteria pass again: 1 ("Receives only the diff and the bar, never prior findings"), 2 ("I alone fetch and export."), 3 ("A finding is a \"regression\" if it fails only on the new state, and \"older\" if it fails on both."), 4 ("I check that the reviewer read the state I meant, and that every cited commit, file and line exists there."), 5 ("capped length. One row per finding: command, input, output on each state"), 6 ("A round starts when the author's push has stayed unchanged for a while, not at the first push."), 7 ("If it has moved, I review the new state instead of posting."), 8 ("My earlier request-changes review stays in place, so I name it and tell the owner it needs dismissing. Approval and merge stay with the owner.").

## Loopholes closed

None observed. This is an output-shaping skill: a positive recipe, no rationalization table.
