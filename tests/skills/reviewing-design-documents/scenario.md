# Pressure scenario: reviewing-design-documents

## Kind

output-shaping

## Prompt

You are about to draft a design document, docs/design/ship-kit-design.md, for a new feature in this repository, and it will go through review before anyone implements it. Before drafting, write the review plan you will state out loud before round one: who reviews each round, who writes and who revises the text, what happens after the reviewers pass it, what happens when the same kind of defect is found a second time, what the reviewers hunt for, and when review stops. Output only the plan, under 250 words.

## Pass criteria

1. Every round is reviewed by two reviewers: a general one and an adversarial one.
2. The drafter writes the first pass only; revisions after review are made by the reviewing side.
3. After both reviewers pass: the findings are folded once, exactly one scoped confirmation round follows, and remaining NON-BLOCKING findings become notes on plan tasks, with no further full round.
4. The reviewers hunt every shape of a shared list of design defect shapes, on every round.
