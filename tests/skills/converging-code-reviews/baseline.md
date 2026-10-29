# Baseline (RED): converging-code-review-rounds

Model: claude-opus-5-5

CLI version: `2.1.312 (Claude Code)`. Every attempt ran under the pinned model (`tests/skills/pinned-model.txt`) in a fresh `mktemp -d` run directory outside the repository, with no files copied (`## Run directory` is `None.`) and no plugin loaded. `node tests/helpers/pressure.mjs baseline` accepted each stream (exit 0): one init message reporting the pinned model, no ship-kit plugin, skill or slash command, and a final `success` result. Each output below is the `baseline` text, verbatim, with non-ASCII characters transcribed (en dash to `-`).

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
RUN=$(mktemp -d)
(cd "$RUN" && claude -p "${ISO[@]}" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-red-N.jsonl"
node tests/helpers/pressure.mjs baseline --stream "$SCRATCH/$SKILL-red-N.jsonl" > "$SCRATCH/$SKILL-red-N.txt"
echo "baseline exit: $?"
```

## Summary

- The convergence rules were first tested as a discipline: a round-5 choice under deadline, fatigue and sunk-cost pressure, where the right option is to block only on the regression the reviewing side's own suggestion caused, revert rather than widen, post the rest once as follow-ups and raise the stalled trend with the owner. The baseline chose that option unprompted (attempt 1). As with `reviewing-design-documents`, the rule is not discriminable as a discipline at this model, and no criterion rests on that attempt.
- The scenario was therefore reclassified as output-shaping: the review plan the reviewing side states before round one. Attempts 2 and 3 run the `## Prompt` of `scenario.md`.
- Both shaping attempts already scale re-reviews to the diff, add no new nits on unchanged code, and escalate to the owner when blockers stop falling; both tag late findings on unchanged code much as the skill labels older ones. No criterion claims those behaviours. They fail the five criteria in `scenario.md`.

## Discipline attempt

### Attempt 1

Attempt 1 prompt:

```text
You are the reviewing side on a code pull request that adds a parser for duration strings in a task tracker. Each round a general reviewer and an adversarial reviewer review the author's latest commit; both keep a probe table of input strings with the parsed result they expect. Round 5 just finished on the author's fix commit, which applied the widened range regex your adversarial reviewer suggested in round 4. Round 5 found:

1. The new regex reads two neighbouring probe rows ("1-2h", "3-4h") as minutes. Both passed at round 3.
2. An older case, present since the first commit: a duration written out in words ("an hour and a half") mis-parses. No recorded input has one.
3. One entry of the unit alias list has no test row.
4. Two doc comments are worded loosely.

Blocking findings per round so far: 3, 4, 3, 4, 4. The owner wants this merged this week, the author is tired of review, and you have spent two days on it.

Choose one option:

A) Post all four as blocking, suggest a further-widened regex that covers both rows, and request round 6.
B) Approve now and list all four as follow-ups.
C) Block only on 1: say it came from your own round-4 suggestion, propose reverting to the round-3 rule plus a documented known miss after running that revert against both probe tables, post 2 to 4 once as follow-ups, and raise with the owner that blockers are not shrinking.
D) Block on 1 and 2, suggest a further-widened regex, and hold 3 and 4 for round 6.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons.
```

Attempt 1 output, verbatim:

```text
Model: claude-opus-5-5

**C**

**Reasons:**

1. **Finding 1 is a real regression, and we caused it.** "1-2h" and "3-4h" passed at round 3 and broke because of the regex our adversarial reviewer suggested in round 4. That is the only blocker that fits the usual rule: the change made things worse. Saying so plainly is honest, and the author shouldn't have to pay for our mistake.

2. **Widening the regex again (A and D) repeats the pattern that got us here.** Each widening has fixed some rows and broken others. That's why the blocker counts (3, 4, 3, 4, 4) aren't going down. The round-3 rule is known to pass both probe tables, so reverting to it and documenting the known miss is the smallest safe step. Running that revert against both tables before proposing it means we're offering a checked fix, not another guess.

3. **Findings 2-4 shouldn't block.** Finding 2 has been there since the first commit, so it isn't a regression, and no recorded input uses that format. Findings 3 and 4 are a missing test row and loose doc wording. Each is worth fixing, so post all three once as follow-ups and don't save them up for round 6. That keeps the review from dragging on (D's problem) and keeps the findings from getting lost.

4. **B approves a known regression** in rows that used to pass, just to hit the deadline. Merging something broken isn't the right way to stop the review going in circles.

5. **Telling the owner the blockers aren't shrinking** is the real fix for the process. After five rounds and two days, the owner should know the review isn't converging. That lets them decide on scope, such as accepting documented known misses, rather than the reviewers quietly approving to end it or pushing for yet another round.
```

It chose the option the skill teaches, for the skill's reasons ("Widening the regex again (A and D) repeats the pattern that got us here.", "Telling the owner the blockers aren't shrinking"). Nothing for a discipline skill to correct.

## Output-shaping attempts

Prompt:

```text
You are the reviewing side on a code pull request: each round, a general reviewer and an adversarial reviewer review the author's latest commit, and the author pushes fix rounds that you re-review until the pull request can merge. Before round one, write the review plan you will state out loud to the author and the owner: what blocks the merge and what does not, how findings are labelled in later rounds, how you check a fix you suggest before you post it, how much each re-review covers, what you do if the rounds are not converging, and what "done" looks like. Output only the plan, under 300 words.
```

### Attempt 2

`baseline` exited 0.

Attempt 2 output, verbatim:

```text
Model: claude-opus-5-5

# Review plan for this pull request

**What blocks the merge:** correctness bugs, security problems, data loss or corruption, contract or API breaks, and changed behaviour that has no test or a failing test. Nothing else blocks. Style, naming, refactor ideas and guesses about performance are labelled `nit`, and the author decides on those.

**Labels:** every finding gets a stable ID and a tag: `blocking`, `nit` or `question`. The ID includes the round, for example R1-04. In each later round, every earlier ID gets one status: `fixed`, `still-open`, `regressed` or `withdrawn`. A new finding is tagged `new-in-diff` if it is in the latest commit. It is tagged `missed-earlier` if it was already in code we had reviewed, and we say that we missed it.

**Checking a fix before we post it:** we apply the suggested fix locally, build, and run the relevant tests. Where we can, we also add a test that fails without the fix and passes with it. If we could not check a fix, it is marked `unverified`, so nobody treats it as a known-good patch.

**What each re-review covers:** the new commit's diff, the code that diff calls or is called by, and every open ID. We do not re-review the whole pull request unless the fix rewrites a large part of it or changes the design. From round 2 on, we post no new nits on code that hasn't changed.

**If the rounds are not converging:** this means the blocking count has not dropped for two rounds in a row, or one finding has been fixed and reopened twice. In that case we stop posting rounds and meet with the author and the owner to choose: accept the risk with a written reason, redesign, or split the pull request. From round 3 on, the adversarial reviewer can raise a new blocker on unchanged code only by stating its severity and why it was missed before.

**Done:** no open blocking IDs and CI passing. Every nit is either addressed or deferred by the owner to a linked ticket. Both reviewers approve the latest commit.
```

1. FAIL. "changed behaviour that has no test or a failing test" blocks, and binding standards are not mentioned.
2. FAIL. Realistic input is not defined; contrived inputs are not mentioned.
3. FAIL. "we apply the suggested fix locally, build, and run the relevant tests"; no probe tables, no old-head comparison, no list of moved rows.
4. FAIL. Not stated; "the adversarial reviewer can raise a new blocker on unchanged code only by stating its severity and why it was missed before" lets a known finding arrive in a later round.
5. FAIL. "Every nit is either addressed or deferred by the owner to a linked ticket. Both reviewers approve the latest commit."

### Attempt 3

`baseline` exited 0.

Attempt 3 output, verbatim:

```text
Model: claude-opus-5-5

# Review Plan

**What blocks the merge**
- Correctness bugs, including edge cases the change creates.
- Security problems: injection, broken authorization, leaked secrets, unsafe input handling.
- Data loss or corruption, and migrations that can't be rolled back.
- A broken build, failing tests, or changed behaviour with no test covering it.
- Breaking changes to a public API or contract that nobody has announced.

**What does not block**
- Style, naming, optional refactors, performance with no measured impact, and taste. These are labelled *nit* or *suggestion*, and the author may decline them with a one-line reason.

**Labels**
- Every finding gets a stable ID that shows the round and the reviewer (G for general, A for adversarial). For example, `R1-G2` is the general reviewer's second finding in round 1.
- Every finding is tagged `[blocking]` or `[non-blocking]`.
- In later rounds each ID also gets a status: `open`, `fixed (verified)`, `regressed`, `new-from-fix` or `withdrawn`.
- A finding raised after round 1 on code that hasn't changed must say why it was missed, and it is non-blocking unless it is severe.

**Checking suggested fixes**
Before I post a fix, I apply it to the author's commit, build it, and run the relevant tests plus a test that reproduces the issue. If I can't verify a fix, I say so in the comment. I never post an untested fix as if it were tested.

**Re-review scope**
Each round covers:
- the diff since the last commit I reviewed;
- the code that diff calls or touches;
- every finding still marked open and blocking.

If a fix round rewrites a large part of the PR, I do a full re-review and say that I did.

**If rounds don't converge**
If blocking findings haven't gone down after 3 rounds, or a fix brings back an earlier issue, I stop running rounds. I write up each open disagreement with both positions and hand it to the owner to decide. Neither reviewer can drag the rounds out with new non-blocking items.

**Done**
- No blocking findings are open, and each one is verified fixed on the latest commit.
- CI passes.
- Every non-blocking item has been fixed or acknowledged.
- I post a final summary of what was verified, what wasn't, and any accepted risks, then approve.
```

1. FAIL. "A broken build, failing tests, or changed behaviour with no test covering it" blocks, and binding standards are not mentioned.
2. FAIL. Realistic input is not defined; a late finding "is non-blocking unless it is severe".
3. FAIL. "I apply it to the author's commit, build it, and run the relevant tests plus a test that reproduces the issue"; no probe tables or list of moved rows.
4. FAIL. Not stated.
5. FAIL. "Every non-blocking item has been fixed or acknowledged." and "I post a final summary ... then approve."

## Outcome

Criteria that failed in at least one shaping attempt: 1, 2, 3, 4, 5. Each failed in both. They are the `Discriminating criteria` of `result.md`.
