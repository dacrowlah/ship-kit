# Pressure scenario: converging-code-review-rounds

## Kind

output-shaping

## Prompt

You are the reviewing side on a code pull request: each round, a general reviewer and an adversarial reviewer review the author's latest commit, and the author pushes fix rounds that you re-review until the pull request can merge. Before round one, write the review plan you will state out loud to the author and the owner: what blocks the merge and what does not, how findings are labelled in later rounds, how you check a fix you suggest before you post it, how much each re-review covers, what you do if the rounds are not converging, and what "done" looks like. Output only the plan, under 300 words.

## Pass criteria

1. The bar classes a missing test row, documentation, style and wording as follow-ups, and a breach of a binding standard as blocking only when it lets a wrong result through.
2. The plan defines realistic input as input present in recorded or production-shaped data (or the same everyday habit as something that is), and treats a contrived input as a follow-up.
3. Before a suggested fix is posted, it is run in a scratch copy against both reviewers' full probe tables, the old head against the fixed copy, and every row it moves is listed.
4. Every known finding is raised in the round it is found; none is held back for a later round.
5. Done means nothing meets the bar: the follow-ups are posted once as a list, the plan says plainly that nothing blocks, and approval and merge are left to whoever owns them.

## Run directory

None.
