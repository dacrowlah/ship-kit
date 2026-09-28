---
name: reviewing-design-documents
description: Use when drafting or revising a design document or implementation plan, when deciding how many review rounds a design gets, or when review rounds on a design are not converging.
---

# Reviewing design documents

## 1. Gather rulings before drafting

Record each owner decision in the owner's words, with the section that implements it and the test that pins it. Ask for a missing ruling before drafting, not after review finds the gap.

## 2. Draft to the document shape

- Mechanism sections are canonical; each mechanism is stated once.
- A ruling is a quote with a pointer to its section and the test that pins it.
- No history: the document states the current design only.
- Transcribable content (code, configuration, schemas) is given as executable text.
- Every derived number carries the model that produced it.
- Each test is specified once; other sites point at it.
- Toolchain facts cite the pinned artifact; repository facts cite file and line.

## 3. Set the review budget out loud, before round one

State this budget to everyone involved before the first round, and run it as stated:

1. **Dual review at every tier.** Each round has two reviewers: a general reviewer and an adversarial reviewer.
2. **Roles.** The drafter writes the first pass only. The reviewing side makes the revisions after that.
3. **Every round hunts the shared shapes.** Both reviewers hunt every shape in `${CLAUDE_PLUGIN_ROOT}/review/hunt-lists/design-shared.md`, on every round, alongside the design's own concerns.
4. **After PASS/PASS.** Fold the findings once. Run one scoped confirmation round on the folded text only. Turn every remaining NON-BLOCKING finding into a note on the plan task it affects. The design then merges.
5. **A recurring defect class.** A second instance of one defect class means the mechanism is redesigned so the fact lives at one site, with pointers elsewhere; the next round checks the redesign.

## 4. Rounds not converging

When rounds keep producing findings instead of converging, follow `pattern-method.md`.

## 5. When review stops

Review stops when the scoped confirmation round after PASS/PASS is done. What that round finds:

- **NON-BLOCKING:** becomes a note on a plan task, and the design merges.
- **BLOCKING:** is fixed, and the fix gets a scoped check of the changed text only.

A request for "one more round to be safe" after PASS/PASS is answered with this budget: the confirmation round is the safety step it asks for. Write the request and the answer in the review record. When the person the owner put in charge of review process directs another round, that direction stands: run the round, with the budget's answer on record.
