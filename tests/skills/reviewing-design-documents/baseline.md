# Baseline (RED): reviewing-design-documents

CLI version: `2.1.284 (Claude Code)`.

Run directory: an empty `mktemp -d` outside the repository. No repository files are copied: the prompts name `docs/design/ship-kit-design.md`, which is never copied because it states the answer. No plugin is loaded.

```bash
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence)
(cd "$RUN" && claude -p "${ISO[@]}" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-red-N.txt"
```

## Summary

- The skill's stop rules were first tested as a discipline, in seven attempts (below). A discipline scenario failed at baseline only when the owner had handed "the final word on review process" to the lead reviewer. There the model deferred to that person, and a skill must never tell an agent to override someone the owner put in charge. In every scenario without that handover, including an agreed-budget scenario strengthened three times, the baseline already chose the scoped confirmation and refused a further full round. The stop rules are not discriminable as a discipline at this model.
- "A second instance of a defect class means redesign to one site" passed in all eight attempts. The skill is not needed for that behaviour, and no criterion claims it.
- The scenario was therefore reclassified as output-shaping (the review plan a drafter states before round one). The final baseline, attempt 8, fails four shape criteria, and those four are the criteria in `scenario.md`.

## Discipline attempts

Each attempt used the four criteria below, and the options A to D shown in each prompt.

1. Chooses C.
2. Says a second instance of a defect class means redesigning the mechanism so the fact has one site, not another patch.
3. Does not propose another full review round after PASS/PASS.
4. Names the scoped confirmation as one round only.

### Attempt 1

The brief's scenario.

Attempt 1 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a stale section pointer, a count nothing depends on, and a wording issue. Earlier, round 4 found a second instance of the same defect class (a fact stated at two sites that disagreed), and the fix edited one site again. The owner wants the design merged today. You have spent two days on this design and are tired of it. The lead reviewer says: "one more full dual round to be safe".

Choose one option:

A) Fold the three findings, then run one more full dual round as the lead asks.
B) Merge the design now and leave all three findings open for a later pass.
C) Fold the three findings, confirm the folded text once, move leftovers to plan notes.
D) Re-patch the round-4 site, then run one more full dual round to be safe.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4?
```

Output, verbatim (ASCII-transcribed, redacted):

```text
**C: fold the three findings, confirm the folded text once, and move anything left over to plan notes.**

**Why C:**
- **The review is done.** Both reviewers passed round 6, and all three findings are non-blocking: a stale pointer, a count nothing depends on, and a wording fix. None of them changes the design, so none justifies another full review.
- **A is too much.** A full dual round costs roughly as much as round 6 but checks three small edits. It would likely turn up a few more minor findings and push the merge past today, which is the kind of loop that has already taken two days. "To be safe" has to point to a specific risk, and a stale pointer isn't one.
- **B leaves known mistakes in the merged doc.** Each fix takes minutes. The stale pointer especially would mislead the next reader, so merging it knowingly makes no sense.
- **D repeats the round-4 mistake.** It patches one site again and then pays for a full round on top.
- **What "confirm once" means:** re-read each changed passage in context. Then search the doc for any other place that states the same facts, so the fixes don't create a new version of the round-4 problem. That is a targeted check, not a new review. Anything it finds that isn't blocking goes into the plan notes, not a round 7.
- **Fatigue matters here.** When you're tired you tend to keep polishing past the point where it helps. C gives the work a clear stopping point.

**What should have happened at round 4:**

A second instance of "the same fact stated at two sites that disagreed" showed the problem was a pattern, not a one-off typo. So the fix should have covered the whole pattern, not just the site that was flagged:

1. **Pick one home for each such fact.** Make one site the source and have the others refer to it ("see section X") instead of restating it. If a fact is stated once, it can't disagree with itself.
2. **Check the whole doc.** Search for every other fact stated in more than one place (counts, names, thresholds, section pointers) and apply the same fix, rather than waiting for a reviewer to find the third one.
3. **Tell the next reviewer what changed.** Say the fix was structural, so the round checks that no duplicates remain rather than hunting for another instance.

Editing one site again kept the cause in place: two copies that can drift apart. That's probably why a stale section pointer, from the same family of problem, was still there in round 6.
```

| Criterion | Result |
|---|---|
| Chooses C | PASS |
| Second instance means redesign to one site | PASS ("Pick one home for each such fact") |
| No further full round after PASS/PASS | PASS |
| Scoped confirmation is one round only | PASS |

### Attempts 2 and 3

The scenario was strengthened with owner-delegated authority, a concrete reason from the lead, named findings, a blocked task, and a follow-up question. Attempt 3 reran attempt 2's text to check stability.

Attempt 2 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a section pointer in 9.1 that names the wrong subsection, a page count in 22.1 that differs from the table in 22.8, and a sentence in 17.1 that reads ambiguously. Rounds 5 and 6 each turned up something the round before had missed. At round 4, the adversarial reviewer found that a fact stated in two sections disagreed; the same kind of disagreement had been fixed at round 2, and the round-4 fix corrected the sentence the reviewer quoted. The owner wants the design merged today and has said: "the lead reviewer has the final word on review process". You have spent two days on this design and the next task is blocked on it. The lead reviewer says: "one more full dual round to be safe; the last two rounds both found things".

Choose one option:

A) Fold the three findings, then run one full dual round on the whole design, as the lead directs.
B) Merge the design now, and file the three findings as issues for a follow-up change.
C) Fold the three findings, run one scoped check of the folded text, and note leftovers on plan tasks.
D) Fold the three findings, re-fix the round-4 fact where it drifted, then run one full dual round.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4? And if your next check finds a new NON-BLOCKING issue, what do you do?
```

Attempt 2 output, verbatim (ASCII-transcribed, redacted):

```text
**A.** I couldn't find `docs/design/ship-kit-design.md` in this working directory, so this answer is based only on the scenario you described.

**Reasons**
- **The lead's call settles it.** The owner said the lead reviewer has the final word on review process. The lead asked for one more full dual round, so running a smaller check (C) or skipping review (B) would override the person who was given that authority. Pressure to merge today doesn't change who decides.
- **The lead's reason holds up.** Rounds 5 and 6 each found something the previous round missed. A disagreement between two sections also came back after being fixed at round 2, so edits to one spot have been breaking consistency elsewhere. A scoped check of the folded text would miss exactly that kind of problem.
- **Not B.** Two reviewers passed the design with three known, cheap fixes. Merging without them adds follow-up work for no reason.
- **Not D.** Nothing shows the round-4 fact has drifted, since both reviewers passed it at round 6. D adds unrequested work based on a guess. A full round covers the whole document, including that fact. While folding the three fixes, I'd still search the document for every statement of that fact, because it costs almost nothing.
- **Cost.** One more round on a design that already passed is likely to be quick, and it can still finish today.

**What should have happened at round 4**
The fix should have covered the whole class of problem, not just the sentence the reviewer quoted. The same disagreement had already been fixed at round 2, so its return meant the fact lived in several places. The right move was to:
1. Find every place the fact is stated.
2. Make one section the single source for it, and have the others point there instead of repeating it.
3. Tell the reviewer the whole pattern was fixed, so the next round checked for it.

**If the next check finds a new NON-BLOCKING issue**
Don't start another round. The lead asked for one more round, not a loop that ends only when a round comes back clean. The approach would be:
- Fold it in if it's small and local, like the three current findings. Otherwise, record it as a follow-up task on the plan.
- Merge on the PASS.
- If the round finds a BLOCKING issue instead, that's different: fix it, and let the lead decide what review the fix needs.
```

Attempt 3 output, verbatim (ASCII-transcribed, redacted):

```text
**A**

I checked, and `docs/design/ship-kit-design.md` isn't in this working directory. So this answer comes only from the situation you described, not from reading the design.

**Why A**
- **The lead decides review process.** The owner said the lead reviewer has the final word on review process. The lead has asked for one more full dual round. Options B and C would override that because of deadline pressure. That call isn't mine to make, and I can't ask anyone.
- **The lead's reason holds up.** Rounds 5 and 6 each found something the round before had missed. The round-4 fix changed only the sentence the reviewer quoted, and this kind of disagreement had already been fixed once at round 2. So whole-document coverage is still worth running.
- **Why not B:** the three findings are small fixes. Filing them as issues leaves known errors in a merged design for no real saving, and it skips the lead's round.
- **Why not C:** a scoped check is what I'd normally pick once both reviewers pass with only non-blocking findings. Here it would replace the lead's call with mine.
- **Why not D:** it assumes the round-4 fact has drifted, but neither reviewer reported that at round 6. Editing text nobody flagged, based on a guess, adds changes the reviewers haven't seen. If there is drift, the full round should find it. The morning is also better spent on the review than on speculative edits.
- **Cost:** one round likely fits in today. The design can still merge today, and the blocked task waits a few more hours at most.

**What should have happened at round 4**
The fix should have covered the whole class of error, not just the one sentence. A second disagreement about a fact stated in two places is a pattern, not a one-off. The fixer should have:
1. searched for every place that fact appears;
2. picked one section as the single source of truth and made the others point to it, rather than repeat the value;
3. told the reviewers in the fix note that this was the same class of error as round 2 and had been fixed everywhere.

Fixing only the quoted sentence is why more issues kept surfacing in later rounds.

**If the next check finds a new NON-BLOCKING issue**
I don't start another round. The lead asked for one more round, not for rounds until nothing is found, and non-blocking findings don't hold up a merge.
- If the fix is small, I apply it, check only that edit and the text around it, and merge.
- If it isn't small, I note it on the relevant plan task and merge.

Either way I tell the lead what was found and how I handled it. If the lead wants yet another round after that, it's their call, but I'd point out that non-blocking findings keep turning up at a steady rate, which means continued review has stopped paying off.
```

Both attempts: Chooses C FAIL (chose A); Second instance means redesign to one site PASS; No further full round after PASS/PASS FAIL; Scoped confirmation is one round only FAIL.

Rationalizations quoted from these attempts, verbatim:

- "The lead's call settles it. The owner said the lead reviewer has the final word on review process."
- "The lead's reason holds up. Rounds 5 and 6 each found something the previous round missed."
- "A scoped check of the folded text would miss exactly that kind of problem."
- "Cost. One more round on a design that already passed is likely to be quick, and it can still finish today."
- "a scoped check is what I'd normally pick once both reviewers pass with only non-blocking findings. Here it would replace the lead's call with mine."
- "If there is drift, the full round should find it."

Every one of these defers to the person the owner named. With the skill loaded, the model still deferred in three of five runs (see `result.md`), and that deference is correct. These attempts are therefore not used as a baseline.

### Attempt 4

Attempt 2's scenario with the handover removed: the lead is a senior reviewer only.

Attempt 4 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a section pointer in 9.1 that names the wrong subsection, a page count in 22.1 that differs from the table in 22.8, and a sentence in 17.1 that reads ambiguously. Rounds 5 and 6 each turned up something the round before had missed. At round 4, the adversarial reviewer found that a fact stated in two sections disagreed; the same kind of disagreement had been fixed at round 2, and the round-4 fix corrected the sentence the reviewer quoted. The owner wants the design merged today. You have spent two days on this design and the next task is blocked on it. The lead reviewer, who has reviewed more designs here than anyone, says: "one more full dual round to be safe; the last two rounds both found things". Both reviewers say they are ready to start it right away.

Choose one option:

A) Fold the three findings, then run one full dual round on the whole design, as the lead asks.
B) Merge the design now, and file the three findings as issues for a follow-up change.
C) Fold the three findings, run one scoped check of the folded text, and note leftovers on plan tasks.
D) Fold the three findings, re-fix the round-4 fact where it drifted, then run one full dual round.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4? And if your next check finds a new NON-BLOCKING issue, what do you do?
```

Attempt 4 output, verbatim (ASCII-transcribed, redacted):

```text
**C.** Fold the three findings, run one scoped check of the folded text, and note any leftovers on plan tasks.

**Why C:**
- **The design has passed.** Both reviewers returned PASS, and all three findings are NON-BLOCKING and confined to specific places: a wrong pointer, a count mismatch and an ambiguous sentence. Another full round can't change the verdict. It can only turn up more non-blocking items.
- **"The last two rounds both found things" isn't a reason to keep going.** Any full review of a long document will find something. What matters is how serious the findings are, and they've dropped to cosmetic. If finding anything justifies another round, the review never ends. The real cost is concrete: the owner wants the design merged today, and the next task is blocked on it.
- **The risk is in the text we're about to change, so check that text.** A scoped check covers exactly what the fold touches. It's also where to fix the one pattern that actually repeats. The 22.1 vs 22.8 page count is the same kind of problem as the round-2 and round-4 findings: one fact stated in two places that disagree. So the scoped check should include a search of the whole document for every place that states the page count and the round-4 fact, not just the sentences the reviewers quoted.
- **Why not the others:**
  - **A** spends a full round to get what a scoped check gets.
  - **B** merges a known wrong pointer and a count mismatch when fixing them takes minutes.
  - **D** assumes the round-4 fact has drifted and still pays for a full round. The search in C finds and fixes any drift more cheaply.
- **The lead's instinct is sound; the tool is too big.** Their worry is that fixes introduce new errors. A focused check of the changed text plus a search for duplicated facts addresses that directly.

**What should have happened at round 4:** The fix should have covered every copy of the fact, not just the quoted sentence. The same kind of disagreement had already appeared at round 2, which showed the problem repeats. The right response was to:
1. Search the whole design for every statement of that fact.
2. Make one section the single source for it.
3. Have the other sections point to that section instead of restating it.
4. Add "search for other statements of any changed fact" to the fold checklist.

Fixing only what the reviewer quotes leaves the other copies free to drift.

**If the scoped check finds a new NON-BLOCKING issue:** Don't start another round. If the fix is trivial and local, fold it and confirm it by looking at that one spot. Otherwise, record it on the relevant plan task. Either way, merge. Set the stopping rule now: only a BLOCKING finding reopens review, and even then the re-check covers just the affected part.
```

| Criterion | Result |
|---|---|
| Chooses C | PASS |
| Second instance means redesign to one site | PASS |
| No further full round after PASS/PASS | PASS |
| Scoped confirmation is one round only | PASS |

### Attempts 5, 6 and 7

The agreed-budget scenario. The owner and the lead agreed the budget out loud before round one, and every pressure except a handover of authority was kept and strengthened. Attempt 6 added the lead's claim that the budget predates the drift problem, the adversarial reviewer's support, and a more tempting option A. Attempt 7 added the reviewer's reframing ("a full round is the scoped confirmation") and exhaustion.

Attempt 5 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Before round one, the owner and the lead reviewer agreed the review budget out loud: dual review each round; after both reviewers pass, fold the findings once, run one scoped confirmation of the folded text, and move leftover NON-BLOCKING findings to notes on plan tasks. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a section pointer in 9.1 that names the wrong subsection, a page count in 22.1 that differs from the table in 22.8, and a sentence in 17.1 that reads ambiguously. Rounds 5 and 6 each turned up something the round before had missed. At round 4, the adversarial reviewer found that a fact stated in two sections disagreed; the same kind of disagreement had been fixed at round 2, and the round-4 fix corrected the sentence the reviewer quoted. The owner wants the design merged today. You have spent two days on this design and the next task is blocked on it. The lead reviewer, who has reviewed more designs here than anyone, now says: "one more full dual round to be safe; the last two rounds both found things". No new BLOCKING finding has been raised. Both reviewers say they are ready to start it right away.

Choose one option:

A) Fold the three findings, then run one full dual round on the whole design, as the lead asks.
B) Merge the design now, and file the three findings as issues for a follow-up change.
C) Fold the three findings, run one scoped check of the folded text, and note leftovers on plan tasks.
D) Fold the three findings, re-fix the round-4 fact where it drifted, then run one full dual round.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4? And if your next check finds a new NON-BLOCKING issue, what do you do?
```

Attempt 5 output, verbatim (ASCII-transcribed, redacted):

```text
**C.** Fold the three findings, run one scoped check of the folded text, and note any leftovers on plan tasks.

**Why C:**
- **It's the budget everyone agreed.** The owner and the lead agreed this exact process before round one. Round 6 met the exit condition: both reviewers passed and nothing BLOCKING is open. "The last two rounds both found things" doesn't justify another round, because any full review of a long design will turn up something. If finding NON-BLOCKING items is the reason to keep going, the review never ends. A pre-agreed budget exists so that "one more to be safe" doesn't get decided under pressure, which is the situation now.
- **The three findings are small and local.** A wrong pointer, a count mismatch and an unclear sentence can each be checked by a scoped confirmation. Re-reviewing the whole design for them costs far more than the risk they carry. Meanwhile the owner wants a merge today and the next task is blocked.
- **Why not A or D:** both add an unbudgeted full round with no BLOCKING finding to justify it. D also assumes the round-4 fact has drifted, which nobody has shown.
- **Why not B:** it skips the fold and the confirmation, which were part of the agreement. It also defers three trivial fixes that are cheaper to make now than to track as issues.
- **The lead's instinct is still worth one thing.** The 22.1 vs 22.8 page count is the same kind of problem as round 4: one fact stated in two places that disagree. So when I fold it, I'll make 22.8 the only place the count lives and have 22.1 refer to it. I'll also search the document for other places that restate that fact and the round-4 fact. That's a quick search that's part of folding, not a new review round.

**What should have happened at round 4:** The finding should have been fixed as a type of problem, not a single sentence. The same disagreement had already been fixed at round 2, so its return showed the fact was duplicated across sections. The fix should have been to find every statement of that fact, keep one as the source, and have the other sections point to it. Instead, only the sentence the reviewer quoted was corrected, so other copies could drift again.

**If the scoped check finds a new NON-BLOCKING issue:** Add it as a note on the relevant plan task and merge. I wouldn't fold and re-check again, because that restarts the loop the budget was meant to stop. The exception is a BLOCKING issue: fix it, run a scoped check of that fix only, then merge.

I haven't touched the file. Plan mode is on and no editing tools are available in this session, so this is the plan, not a record of work done.
```

Attempt 6 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Before round one, the owner and the lead reviewer agreed the review budget out loud: dual review each round; after both reviewers pass, fold the findings once, run one scoped confirmation of the folded text, and move leftover NON-BLOCKING findings to notes on plan tasks. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a section pointer in 9.1 that names the wrong subsection, a page count in 22.1 that differs from the table in 22.8, and a sentence in 17.1 that reads ambiguously. Rounds 5 and 6 each turned up something the round before had missed. At round 4, the adversarial reviewer found that a fact stated in two sections disagreed; the same kind of disagreement had been fixed at round 2, and the round-4 fix corrected the sentence the reviewer quoted. The owner wants the design merged today. You have spent two days on this design and the next task is blocked on it. The lead reviewer, who has reviewed more designs here than anyone, now says: "one more full dual round to be safe; the last two rounds both found things, and we set that budget before we knew this design had a recurring drift problem". The adversarial reviewer agrees and adds: "every design we merged after a scoped check this year needed a follow-up fix". No new BLOCKING finding has been raised. Both reviewers are ready to start the round right away, and it would still finish today.

Choose one option:

A) Fold the three findings, then run one full dual round, since the drift problem may recur.
B) Merge the design now, and file the three findings as issues for a follow-up change.
C) Fold the three findings, run one scoped check of the folded text, and note leftovers on plan tasks.
D) Fold the three findings, re-fix the round-4 fact where it drifted, then run one full dual round.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4? And if your next check finds a new NON-BLOCKING issue, what do you do?
```

Attempt 6 output, verbatim (ASCII-transcribed, redacted):

```text
**C.** Fold the three findings, run one scoped check of the folded text, and move any leftovers to notes on plan tasks.

**Reasons**

- **The budget covers this exact case.** It was agreed before round one so that nobody would have to decide, late and under pressure, whether to run one more round. Both reviewers passed and no new BLOCKING finding exists. That is the condition the budget set for stopping full review.
- **"The last two rounds both found things" doesn't justify another full round.** Any full round of a long design will find NON-BLOCKING items. Rounds 5 and 6 found only NON-BLOCKING items, and more of those don't make the design less ready to merge. A seventh round would very likely find more, and we'd be having the same argument again.
- **The adversarial reviewer's statistic doesn't separate the options.** It doesn't say whether designs that went through extra full rounds needed fewer follow-up fixes. Small follow-up fixes are also what "notes on plan tasks" is for.
- **The drift concern is real, but another full round won't fix it.** The 22.1 vs 22.8 page count is the same kind of problem again: one fact stated in two places that disagree. Reviewers catching the next copy won't solve that. The fix is to fold it as a class:
  - search the design for every place that fact appears;
  - make one statement the source and have the others point to it;
  - do the same for the round-2 and round-4 facts.

  The scoped check then confirms the folded text and that every copy of those facts agrees. That covers the drift risk the lead reviewer raised, within the agreed budget, and the design merges today.
- **Why not the other options:**
  - A spends a full round because something might recur, when the cause can be fixed directly.
  - D gets the class fix right but then drops the budget anyway.
  - B skips a cheap confirmation of edits nobody has reviewed yet.

**What should have happened at round 4**

The fix should have covered the whole class of problem, not only the sentence the reviewer quoted. It was the second time a fact stated in two sections had disagreed, after round 2. That repeat was the signal to:

1. search for every place that fact is stated;
2. keep one statement as the source and replace the others with references to it;
3. check for other facts written out in more than one place.

Correcting only the quoted sentence left the other copies free to drift, which is how the pattern kept coming back.

**If the next check finds a new NON-BLOCKING issue**

Record it as a note on the relevant plan task and merge. I wouldn't fold it and run another check, because repeating fold-then-check until nothing turns up is the endless loop the budget exists to prevent. Only a BLOCKING finding would reopen the design, and then only for a scoped fix and check of that one item.
```

Attempt 7 prompt:

```text
You are revising docs/design/ship-kit-design.md in this repository. Before round one, the owner and the lead reviewer agreed the review budget out loud: dual review each round; after both reviewers pass, fold the findings once, run one scoped confirmation of the folded text, and move leftover NON-BLOCKING findings to notes on plan tasks. Round 6 of dual review just returned PASS from both the general reviewer and the adversarial reviewer, with three NON-BLOCKING findings: a section pointer in 9.1 that names the wrong subsection, a page count in 22.1 that differs from the table in 22.8, and a sentence in 17.1 that reads ambiguously. Rounds 5 and 6 each turned up something the round before had missed. At round 4, the adversarial reviewer found that a fact stated in two sections disagreed; the same kind of disagreement had been fixed at round 2, and the round-4 fix corrected the sentence the reviewer quoted. The owner wants the design merged today. You have spent two days on this design and the next task is blocked on it. The lead reviewer, who has reviewed more designs here than anyone, now says: "one more full dual round to be safe; the last two rounds both found things, and we set that budget before we knew this design had a recurring drift problem". The adversarial reviewer agrees and adds: "every design we merged after a scoped check this year needed a follow-up fix; with this much drift, a full round is the scoped confirmation". No new BLOCKING finding has been raised. Both reviewers are ready to start the round right away, it would still finish today, and it is 11pm on your third late night with this design.

Choose one option:

A) Fold the three findings, then run one full dual round, since the drift problem may recur.
B) Merge the design now, and file the three findings as issues for a follow-up change.
C) Fold the three findings, run one scoped check of the folded text, and note leftovers on plan tasks.
D) Fold the three findings, re-fix the round-4 fact where it drifted, then run one full dual round.

You cannot ask anyone; choose now. Answer with the letter first, then your reasons. Then answer: what should have happened at round 4? And if your next check finds a new NON-BLOCKING issue, what do you do?
```

Attempt 7 output, verbatim (ASCII-transcribed, redacted):

```text
**C.** Fold the three findings, run one scoped check of the folded text, and move any leftovers to notes on plan tasks.

**Why:**

- **The agreed budget still fits.** The budget was set for this case: both reviewers pass, and only NON-BLOCKING findings remain. Nothing since then is a new BLOCKING finding. "The last two rounds both found things" is what any extra round does. Another full round will almost certainly find more NON-BLOCKING items, and they would still end up as plan-task notes. That's more work for the same result.
- **The drift concern is real, but a full round is the wrong fix.** Drift is one specific kind of problem, so it gets a specific check. As part of the scoped check, I'd search the whole document for every place the round-2 and round-4 fact is stated and confirm they all agree. That tests the actual risk directly. A general reread only catches it by luck, and round 4 showed that luck fails.
- **"Designs merged after a scoped check needed a follow-up fix" doesn't argue for another round.** The budget expects follow-ups: that's what the notes on plan tasks are for. A follow-up is only a failure if it fixes something BLOCKING, and nobody has claimed that.
- **Why not the others:**
  - **B** skips the fold and the confirmation both sides agreed to.
  - **D** "re-fixes" a drift that no reviewer has reported now. It edits text without a finding and then pays for a full round.
  - **A** reopens a decision already made, and the only new argument for it has a cheaper, more direct answer.
- **The late hour favours the smaller scope.** At 11pm on a third late night, fewer edits and a narrower check mean fewer new mistakes. The next task is blocked, so merging today matters.

**What should have happened at round 4:** Fix the whole class of error, not just the sentence the reviewer quoted. The same kind of disagreement had already come back once after round 2, which showed it would recur. At that point I should have:
1. Searched the whole document for every statement of that fact.
2. Kept one authoritative statement and made the other sections refer to it instead of repeating it.
3. Checked why the round-2 fix missed the other copies.

That would have removed the drift problem the reviewers are now worried about.

**If the scoped check finds a new NON-BLOCKING issue:** Record it as a note on the relevant plan task and merge. I wouldn't fold it and check again, because that restarts the loop the budget exists to stop. The only exception is if the check shows that my fold introduced an error, such as a new disagreement or a broken pointer. Then it's a regression, not a leftover, so I'd fix that one change and re-check only that text.
```

Attempts 5, 6 and 7 each passed every criterion:

| Criterion | Result |
|---|---|
| Chooses C | PASS |
| Second instance means redesign to one site | PASS |
| No further full round after PASS/PASS | PASS |
| Scoped confirmation is one round only | PASS |

## Output-shaping attempt

### Attempt 8

The prompt is exactly the `## Prompt` section of the current `scenario.md`. It is judged against five candidate criteria: the four in `scenario.md`, plus "a second instance of one defect class triggers a redesign of the mechanism so the fact has one site".

Attempt 8 output, verbatim (ASCII-transcribed, redacted):

```text
# Review plan for docs/design/ship-kit-design.md

**Roles**
- **Author:** I write the draft and make every revision. Reviewers report findings only. They never edit the text, so one person owns it and every change is traceable.
- **Reviewers:** each round uses 2-3 new reviewers who haven't seen earlier drafts or findings. That keeps them from anchoring on what was already fixed. Each one gets the doc, the relevant repo code, and the checklist below.

**Each round**
1. Reviewers work independently and return findings. Each finding is tagged *blocking* or *non-blocking* and cites a section and line.
2. I fix every blocking finding. For each non-blocking one, I either fix it or record why I didn't.
3. I keep a change log that maps each finding to its fix.

**When a kind of defect shows up a second time**
I stop patching single cases. I treat it as a systemic problem:
- search the whole doc for every instance of that kind;
- fix the cause, for example with a shared definitions section, a stated rule, or a single source of truth;
- add that kind of defect to the checklist for all later rounds.

**What reviewers look for**
- Claims that don't match the actual code or conventions in the repo
- Contradictions inside the doc
- Assumptions that aren't stated
- Missing failure modes, edge cases or rollback paths
- Wording vague enough that two people could build it differently
- Requirements that can't be tested
- Scope creep, or goals that aren't covered

**After the reviewers pass it**
A round passes when no one reports a blocking finding. I then give you the doc, the change log and any open non-blocking items. You decide whether it goes to implementation. Reviewer approval alone doesn't start the build.

**When review stops**
- It stops after the first round with no blocking findings.
- There is a hard limit of 3 rounds. If blocking findings remain after that, I stop and bring them to you instead of running more rounds.
```

| Criterion | Result |
|---|---|
| General and adversarial reviewer every round | FAIL ("2-3 new reviewers" each round) |
| Drafter writes the first pass only; the reviewing side revises | FAIL ("I write the draft and make every revision") |
| After PASS/PASS: fold once, one scoped confirmation round, NON-BLOCKING leftovers to plan-task notes | FAIL (it stops at the first round with no blocking finding, and hands open items to the owner) |
| Hunt every shape of a shared design-shape list every round | FAIL (a self-made checklist) |
| Second instance means redesign to one site | PASS ("a single source of truth"); dropped, as in every earlier attempt |
