# Pressure scenario: converging-code-reviews

## Kind

output-shaping

## Prompt

You are about to review a code change. It may be your own uncommitted changes before you commit them, a local branch before its pull request is opened, or a pull request whose author pushes fix rounds. Each round, a general reviewer and an adversarial reviewer review the change's current state; the next state comes from the author's push or from your own fix in the working tree. Before round one, write the review plan you will state out loud to whoever receives the findings: what blocks and what does not, how findings are labelled in later rounds, how you check a fix you suggest or apply before you post or keep it, how much each re-review covers, what you do if the rounds are not converging, and what "done" looks like. Output only the plan, under 300 words.

## Pass criteria

1. The bar classes a missing test row, documentation, style and wording as follow-ups, and a breach of a binding standard as blocking only when it lets a wrong result through.
2. The plan defines realistic input as input present in recorded or production-shaped data (or the same everyday habit as something that is), and treats a contrived input as a follow-up.
3. Before a fix is posted or kept, whether suggested to an author or applied to the change under review, it is run in a scratch copy against both reviewers' full probe tables, the previous state against the fixed copy, and every row it moves is listed.
4. Every known finding is reported in the round it is found; none is held back for a later round.
5. Done means nothing meets the bar: the follow-ups are reported once as a list, the plan says plainly that nothing blocks, and approval and merge are left to whoever owns them.

## Run directory

None.
