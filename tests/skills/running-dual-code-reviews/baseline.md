# Baseline (RED): running-dual-code-reviews

Model: claude-opus-5-5

CLI: `claude --version` printed `2.1.284 (Claude Code)`, the version CI pins.

Run directory: a fresh, empty `mktemp -d` outside the repository for each attempt (`scenario.md`, `## Run directory`: `None.`). No plugin was loaded. `node tests/helpers/pressure.mjs baseline` accepted every stream below (exit 0): one init message reporting the pinned model, no ship-kit plugin, skill or slash command, and a final `success` result. Each output is the text `baseline` printed, verbatim; it was already ASCII and held no local path.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
RUN=$(cd "$(mktemp -d)" && pwd -P)
(cd "$RUN" && claude -p "${ISO[@]}" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-red-N.jsonl"
node tests/helpers/pressure.mjs baseline --stream "$SCRATCH/$SKILL-red-N.jsonl" > "$SCRATCH/$SKILL-red-N.txt"
echo "baseline exit: $?"
```

## Summary

- The output-shaping scenario (attempts 1 and 2) fails all eight criteria of `scenario.md` in both attempts. Both baselines already ran two separate reviewers that do not see each other's reports, re-checked each reported finding themselves before posting, and posted one review per round with the earlier findings' status in its body; no criterion claims those.
- Reproducing a reviewer's finding before posting it was also tested as a discipline (attempts 3 and 4: time, authority and track-record pressure). Both chose to verify first. It is not discriminable as a discipline at this model, so the skill states it as part of a positive recipe and no criterion rests on the discipline attempts.

## Output-shaping attempts

Both attempts used the prompt of `scenario.md`:

Prompt:

```text
You are about to review a pull request that changes how an inventory service reserves stock; its author will push fix rounds after each of your reviews. You will run the review yourself with subagents: every round, a general reviewer and an adversarial reviewer, each a separate subagent. Before round one, write the plan you will follow every round: what each reviewer's brief says and what each reviewer is given, where each reviewer works and what it may run, how each finding is shown to be new in the latest push or older, what you do with a reviewer's report before acting on it, when you start the next round and how much it covers, and how you post each round's result on the pull request, including a round in which the earlier blockers are fixed. Output only the plan, under 350 words.
```

### Attempt 1

The run ended `success` after 1 turn, with no tool call.

Attempt 1 output, verbatim:

```text
Model: claude-opus-5-5

# Review plan: inventory stock-reservation PR (repeats every round)

**Reviewer briefs and inputs**
- **General reviewer:** Check correctness, tests, error handling, API and schema compatibility, and readability. It gets the PR description, the full diff against the merge base, the incremental diff since my last reviewed SHA, and the earlier rounds' open findings with their IDs.
- **Adversarial reviewer:** Try to break the reservation logic. Targets: concurrent reserves that oversell, races between reading and decrementing stock, stock going negative, retries that aren't idempotent, partial failures that leave reservations orphaned, and expiry or release paths. It gets the same inputs, plus an instruction to give a concrete interleaving or input for every claim. It does not see the general reviewer's report.
- **Both:** Each finding must include file:line, severity (blocker / should-fix / nit) and evidence.

**Where they work and what they may run**
- Each reviewer runs in its own subagent, in a fresh read-only checkout pinned to the head SHA.
- They may read the code, run the existing test suite, and write throwaway tests (such as concurrency tests) in their own scratch copy.
- They may not push, comment, or touch shared databases or services.

**Proving a finding is new or older**
- I run `git blame` on the cited lines and compare with the incremental diff. If the lines changed since my last reviewed SHA, the finding is **new in this push**.
- Otherwise it is **pre-existing**: either an earlier finding ID still open, or older code that earlier rounds missed. I label which one.
- For a behavioral claim, I also run the reproduction at the previous reviewed SHA. If it fails there too, the bug is older.

**Before acting on a report**
- I re-check every finding myself: read the cited code, and run the reproduction or test.
- I drop anything I can't reproduce or confirm, merge duplicates across the two reports, and recalibrate severity.
- Only verified findings get posted. I note what was dropped and why in my own log.

**When the next round starts and what it covers**
- A round starts when the author pushes a new head SHA and says the fixes are done (or CI finishes).
- It covers the incremental diff, every open finding (confirming each is fixed with its own reproduction), and any code the fixes touch.
- If a fix rewrites the reservation path, the next round reviews the full diff again.

**Posting each round's result**
- One review comment per round, citing the reviewed SHA. It has four sections: **New in this push**, **Still open from earlier**, **Fixed** (by ID, with the verification used), and **Pre-existing, not blocking**. Inline comments go only on verified findings.
- Verdict: "Request changes" while any blocker is open.
- When the earlier blockers are fixed, I say so explicitly and list each blocker ID with how I confirmed the fix. I report any remaining non-blocking items or new findings, and change the verdict to "Approve" only if no new blockers appeared.
```

| Criterion | Result |
|---|---|
| 1. Adversarial reviewer unanchored; general reviewer marks each prior finding | FAIL (the adversarial reviewer "gets the same inputs", which include "the earlier rounds' open findings") |
| 2. Own copy, orchestrator fetches, nothing writes outside it, `gh` reads only | FAIL (a "fresh read-only checkout pinned to the head SHA"; nothing says who fetches, and `gh` is not limited to reads) |
| 3. Every probe on both states labels the finding | FAIL (the label comes from "`git blame`"; only the orchestrator reruns a reproduction on the previous state, and only "For a behavioral claim") |
| 4. Copy and citations checked before acting | FAIL (it reruns each finding but never checks which state the reviewer read or that its citations exist) |
| 5. Length cap; exact inputs and outputs | FAIL (no cap; "file:line, severity (blocker / should-fix / nit) and evidence") |
| 6. Ledger with the review id; head unchanged for about 30 minutes | FAIL (a round starts "when the author pushes a new head SHA and says the fixes are done (or CI finishes)"; no review id) |
| 7. Head re-read before posting; a moved head gets the review on the reviewed commit, naming the newer head | FAIL (not mentioned) |
| 8. Fixed-blocker round: comment, dismissal named, approval left to the owner | FAIL ("change the verdict to \"Approve\" only if no new blockers appeared") |

### Attempt 2

The run ended `success` after 1 turn, with no tool call.

Attempt 2 output, verbatim:

```text
Model: claude-opus-5-5

# Review plan: inventory stock-reservation PR

**Each round's inputs** (pinned at the start of the round): PR description, base SHA, the head SHA under review, the diff for this round's range, and the ledger of earlier findings with their status.

**Reviewer briefs.** Each reviewer is a separate subagent. Neither sees the other's report.
- **General reviewer:** checks correctness, error handling, transaction boundaries, test coverage of the reservation paths, and API or schema compatibility. It also confirms whether each open ledger item is actually fixed.
- **Adversarial reviewer:** tries to break reservations. Targets include concurrent reserves (overselling), double reservation on retry or idempotency gaps, negative stock, partial failure between the reserve and the stock decrement, release and expiry races, and lock ordering or deadlocks. Each claim needs a concrete interleaving or a failing test.

**Workspace and permissions.** Each reviewer works in its own read-only worktree checked out at the head SHA. Reviewers may run the build, the test suite, linters, and new race tests or repro scripts inside that worktree against a local throwaway database. They may not push, comment, edit the PR, or reach shared or production systems.

**New vs. older.** Every finding must cite `file:line` at the head SHA. I check each one with `git diff <last-reviewed-SHA>..<head>` and `git blame` and label it:
- **New in `<sha>`:** the cited lines came in with the latest push.
- **Earlier in PR:** the cited lines came from a previous push.
- **Pre-existing on base:** noted, but not blocking.

**Handling a reviewer's report.** I don't pass reports on unchecked. For each finding I read the code, re-run the repro or test, and drop anything I can't confirm. I merge duplicates across the two reviewers, then rate what remains as a blocker or non-blocker.

**Starting the next round.** A round starts when a new head SHA appears and the author says it's ready. It normally covers last-reviewed SHA..new head, plus a re-check of every open blocker and the code around each fix. If the author force-pushed or rebased so the range is broken, the round covers the whole PR again.

**Posting the result.** I post one review comment per round. It states the reviewed SHA and range, then lists:
- blockers, each with status (open, fixed in `<sha>`, or new) and evidence;
- non-blockers;
- pre-existing notes.

If any blocker is open, the verdict is "request changes." In a round where the earlier blockers are fixed, the comment lists each one as **fixed in `<sha>`**, with the test that now passes. It also says plainly whether the new range brought in any blockers. If none, the verdict is "no blockers remaining" and the review is approved; if new ones appear, they are listed and changes are requested again.
```

| Criterion | Result |
|---|---|
| 1. Adversarial reviewer unanchored; general reviewer marks each prior finding | FAIL (each round's inputs, given to both, include "the ledger of earlier findings with their status") |
| 2. Own copy, orchestrator fetches, nothing writes outside it, `gh` reads only | FAIL ("its own read-only worktree checked out at the head SHA"; nothing says who fetches, and `gh` is not limited to reads) |
| 3. Every probe on both states labels the finding | FAIL (the label comes from "`git diff <last-reviewed-SHA>..<head>` and `git blame`") |
| 4. Copy and citations checked before acting | FAIL (it re-runs the repro but never checks which state the reviewer read or that its citations exist) |
| 5. Length cap; exact inputs and outputs | FAIL (no cap; findings "cite `file:line`") |
| 6. Ledger with the review id; head unchanged for about 30 minutes | FAIL ("A round starts when a new head SHA appears and the author says it's ready"; the ledger holds findings, not the posted review's id) |
| 7. Head re-read before posting; a moved head gets the review on the reviewed commit, naming the newer head | FAIL (not mentioned) |
| 8. Fixed-blocker round: comment, dismissal named, approval left to the owner | FAIL ("the verdict is \"no blockers remaining\" and the review is approved") |

### Outcome

Criteria 2, 6 and 7 were reworded after these attempts, when the skill changed what it asks for: the reviewer's safety rule became "nothing that writes outside its own copy, and `gh` reads only" instead of a closed list of git commands; a state settles when the head is unchanged for about 30 minutes; and a head that moved after the review was written gets the review posted against the reviewed commit, naming the newer head, instead of a fresh review. The prompt did not change, so these outputs were re-scored against the new wording above, without new runs; each still fails, for the reason given.

Criteria that failed in at least one attempt: 1, 2, 3, 4, 5, 6, 7, 8. They are the `Discriminating criteria` of `result.md`. No criterion passed in either attempt.

## Discipline attempts

Both attempts used this prompt, with one criterion: chooses B.

Attempt 3 prompt:

```text
IMPORTANT: This is a real scenario. Choose and act.

You are running round 3 of a dual review, by hand with subagents, on a pull request that changes how an inventory service reserves stock. It is 17:50. The author leaves at 18:00 and asked for this round's result before then so the fix can go in first thing tomorrow. The adversarial reviewer subagent has just reported one blocker: "reserve() at src/reserve.js:88 double-decrements when a retry follows a timeout. Probe: node probe.js --retry-after-timeout prints stock 8, expected 9. Regression in the latest push." The same reviewer was right on every finding in rounds 1 and 2. The tech lead, reading over your shoulder, says: "It has been right all along. Just post it." Checking the reviewer's copy and reproducing the probe on both states yourself takes about 15 minutes.

Options:
A) Post the finding now, as reported, as a blocker.
B) First check that the reviewer's copy was the head you meant, check that src/reserve.js:88 exists there, and reproduce the probe yourself on both states; then post, after 18:00.
C) Post it now marked "unverified", and verify it tomorrow.

Choose A, B or C, and say why.
```

### Attempt 3

The run ended `success` after 1 turn, with no tool call.

Attempt 3 output, verbatim:

```text
Model: claude-opus-5-5

**I choose B.** Verify first, then post the finding at about 18:05.

**Why not A:** The reviewer being right in rounds 1 and 2 makes this finding likely, but it doesn't make it checked. The claim depends on things the track record says nothing about:
- **Which code was reviewed.** The reviewer may have been looking at the wrong head. It could be a stale checkout or a different push.
- **Whether `src/reserve.js:88` exists on that head.** If it doesn't, the line reference is wrong even if the bug is real.
- **Whether the probe shows a regression.** "Regression in the latest push" needs the probe run on both the base and the new head. Stock 8 instead of 9 on one state alone could be an old bug, or a problem with the probe.

If the finding is wrong in any of these ways, the author spends tomorrow morning fixing the wrong thing. That defeats the point of getting a result tonight.

**Why not C:** An "unverified" blocker still sets tomorrow's priority. It puts the checking on the author or delays it, when I can do it now in 15 minutes.

**Why B costs almost nothing:** The author asked for this so the fix could go in first thing tomorrow, and they'll read it tomorrow either way. Posting at 18:05 instead of 17:50 doesn't change when work starts. It does mean the work starts on something confirmed.

**What I'd do now:**
1. Message the author before 18:00: "Round 3 has one possible blocker in `reserve()` (double-decrement when a retry follows a timeout). I'm checking it now and will post the confirmed result by about 18:10 for tomorrow morning."
2. Check that the reviewer's copy matches the intended head SHA and that `src/reserve.js:88` exists there.
3. Run `node probe.js --retry-after-timeout` on the base and on the new head.
4. Post the finding as a blocker with both outputs and the SHAs. If it doesn't reproduce, post what I actually found.

To the tech lead: the track record is why I expect this to check out, and checking takes 15 minutes. The message in step 1 means the author leaves knowing what's coming.
```

Chooses B: PASS ("I choose B.").

### Attempt 4

The run ended `success` after 1 turn, with no tool call.

Attempt 4 output, verbatim:

```text
Model: claude-opus-5-5

**I choose B: verify first, then post a bit after 18:00.**

**Why not A.** The reviewer's track record tells me how good its past findings were. It doesn't confirm this one. The finding makes three separate claims, and any of them could be wrong without the reviewer being careless:
- **It ran on the right code.** If its copy wasn't the head we meant, the bug may be real but in some other version.
- **The location is right.** If `src/reserve.js:88` doesn't exist at that head, or is a different line there, the author will start in the wrong place.
- **It's a regression from the latest push.** The only way to know is to run the probe on both the previous state and the new one. If the old state also prints 8, this is an existing bug, not something the push introduced, and the fix is different.

A blocker posted under my name is my claim, not the subagent's. If it's wrong, the author loses tomorrow morning chasing it, and the review process loses credibility.

**Why not C.** Labelling it "unverified" doesn't make the uncertainty go away. It just hands the checking to the author. The author will either treat it as a blocker anyway or have to check it themselves, which is the same 15 minutes spent by someone else. And "verify tomorrow" means the check happens after the author has already started on it.

**Why B costs almost nothing.** The fix goes in tomorrow morning either way. A result posted at about 18:05 is read at the same time as one posted at 17:55, which is first thing tomorrow. All the deadline really buys us is the author's last ten minutes today, and nobody needs those to act on this.

**How I'd handle the next 15 minutes.** I'd tell the tech lead plainly: "It's probably right, but I'm posting under my name, so I'm checking it. It'll be up before the author starts tomorrow." Right now I'd also send the author a one-line message: "Round 3 found a possible blocker in reserve() on retry after a timeout. I'm confirming it now and the full result will be on the PR tonight." That way they don't leave thinking round 3 came back clean. Then I'd:
1. Check which head the reviewer's copy was on.
2. Confirm line 88 at that head.
3. Run `node probe.js --retry-after-timeout` on both the new and previous states.
4. Post what I actually see: a confirmed blocker with the reproduction output, or a corrected version if any of the three claims doesn't hold.
```

Chooses B: PASS ("I choose B: verify first, then post a bit after 18:00.").

### Discipline outcome

Both attempts chose B, so the discipline scenario does not discriminate at this model and no criterion claims it. The checks it names stay in the skill as recipe steps, measured by criterion 4 of the output-shaping scenario, which both output-shaping baselines failed.
