---
name: converging-code-reviews
description: Use when reviewing code of any kind - own changes before a commit, an uncommitted diff or working tree, a local branch before its pull request is opened, or a pull request, including re-reviews of an author's fix rounds - and when deciding whether a review finding blocks, before suggesting or applying a fix for a finding, or when review rounds are not converging.
---

# Converging code reviews

A round is one pass of two reviewers, a general one and an adversarial one, over the current state of the change. The next state comes from the author's push or from a fix made in the working tree. A round's output is a pull request comment, a report to the user, or a fix to the change under review.

Every requested change costs a round: a commit, a review, probes, and a new surface for the next defect. Weigh that cost before asking. For any finding, ask: "If this were the last round, would I hold the merge for it?" If not, it is a follow-up.

## 1. State the bar before round one

State this bar before the first round to whoever receives the findings (the author, the owner or the user), and review to it.

A finding is BLOCKING only when it is one of:

- lost data;
- wrong data a user sees, on realistic input;
- leaked private data, or a cancelled or withdrawn item shown as live;
- a crash, or a broken error contract;
- a check that cannot fail (see `proving-tests-can-fail`).

A breach of a binding standard blocks when it lets a wrong result through. Every other breach is a follow-up, as are a missing test row for a list entry, documentation, style and wording. A repository's own review rules (its gates, and what blocks there) add to this bar.

Realistic input is input present in recorded or production-shaped data, or the same everyday habit as something that is. A contrived input is a follow-up.

## 2. Label every finding

Each finding is labelled **regression** (the latest state broke it) or **older** (it was there before the latest state). From round two on, a finding blocks when it is a regression, or an older item that clears the bar on realistic input. The adversarial reviewer will always find another older case; that is the stance working, not a sign the change is unready.

## 3. Bundle each round

Report every known finding in the round it is found. A re-review is scaled to the diff since the last round: the fix and its neighbours, not the whole package, and its findings are what that fix changed.

## 4. Run a fix before proposing or keeping it

A fix suggested to an author, or applied to the change under review, is a change too. Before posting or keeping one:

1. Apply it in a scratch copy.
2. Run both reviewers' full probe tables against the previous state and against the fixed copy.
3. Post or keep the fix with the list of every row it moves.

Prefer reverting to an earlier rule plus a documented known miss over widening a pattern. Prefer a missing value over a wrong one. Ask for one literal table per rule, in both directions: rows it must match and rows it must leave alone.

## 5. Own the reviewing side's mistakes

When a regression came from the reviewing side's own earlier suggestion or fix, say so in the finding. When an earlier claim turns out wrong, correct it in the next round.

## 6. Watch the trend

Record the blocking count per round. When it is not shrinking round over round, stop and raise it with the owner (for a local review, the user), naming the likely cause (the bar is set too low, or fixes are moving neighbouring rows), instead of running another round. The pattern method in `reviewing-design-documents` fits stalled code rounds too.

## 7. Done

Done means nothing meets the bar, not nothing left to say. Then:

1. Report the follow-ups once, as one list.
2. Say plainly that nothing blocks.
3. Leave approval and merge to whoever owns them.
