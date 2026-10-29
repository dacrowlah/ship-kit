---
name: converging-code-review-rounds
description: Use when reviewing a code pull request over several rounds, when re-reviewing an author's fix commit, when deciding whether a review finding blocks a merge, when about to suggest a fix in a review comment, or when code review rounds are not converging.
---

# Converging code review rounds

Every requested change costs a round: a commit, a review, probes, and a new surface for the next defect. Weigh that cost before asking. For any finding, ask: "If this were the last round, would I hold the merge for it?" If not, it is a follow-up.

## 1. State the bar before round one

State this bar to the author and the owner before the first round, and review to it.

A finding is BLOCKING only when it is one of:

- lost data;
- wrong data a user sees, on realistic input;
- leaked private data, or a cancelled or withdrawn item shown as live;
- a crash, or a broken error contract;
- a check that cannot fail (see `proving-tests-can-fail`).

A breach of a binding standard blocks when it lets a wrong result through. Every other breach is a follow-up, as are a missing test row for a list entry, documentation, style and wording.

Realistic input is input present in recorded or production-shaped data, or the same everyday habit as something that is. A contrived input is a follow-up.

## 2. Label every finding

Each finding is labelled **regression** (this commit broke it) or **older** (it was there before this commit). From round two on, a finding blocks when it is a regression, or an older item that clears the bar on realistic input. The adversarial reviewer will always find another older case; that is the stance working, not a sign the pull request is unready.

## 3. Bundle each round

Raise every known finding in the round it is found. A re-review is scaled to the diff: the fix and its neighbours, not the whole package, and its findings are what that fix changed.

## 4. Run a suggested fix before posting it

A suggested fix is a change too. Before posting one:

1. Apply it in a scratch copy.
2. Run both reviewers' full probe tables against the old head and against the fixed copy.
3. Post the fix with the list of every row it moves.

Prefer reverting to an earlier rule plus a documented known miss over widening a pattern. Prefer a missing value over a wrong one. Ask for one literal table per rule, in both directions: rows it must match and rows it must leave alone.

## 5. Own the reviewing side's mistakes

When a regression came from the reviewing side's own earlier suggestion, say so in the finding. When an earlier claim turns out wrong, correct it in the next round.

## 6. Watch the trend

Record the blocking count per round. When it is not shrinking round over round, stop and raise it with the owner, naming the likely cause (the bar is set too low, or suggested fixes are moving neighbouring rows), instead of running another round. The pattern method in `reviewing-design-documents` fits stalled code rounds too.

## 7. Done

Done means nothing meets the bar, not nothing left to say. Then:

1. Post the follow-ups once, as one list.
2. Say plainly that nothing blocks.
3. Leave approval and merge to whoever owns them.
