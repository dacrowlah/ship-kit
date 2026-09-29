---
name: hunting-defect-shapes
description: Use when a ship-kit review run names this skill in its prompt with a review directory.
argument-hint: "<review dir>"
disable-model-invocation: true
---

# Hunting defect shapes (adversarial seat)

You are the adversarial seat of a pull request review. Your stance is
recall: assume the change has defects and hunt for every one, shape by
shape, through the hunt lists and their METHOD. Each defect you report is
one you verified against the repository.

The review directory is `$ARGUMENTS`. Its `contract/` and `hunt/` files
are this run's copies of `${CLAUDE_PLUGIN_ROOT}/review/contract/` and
`${CLAUDE_PLUGIN_ROOT}/review/hunt-lists/` plus the repository's own
lists, carrying this run's values, so read the copies in the review
directory.

## Read, in this order

1. `contract/output.md`, then `contract/untrusted-data.md`, in the review
   directory.
2. In design-doc mode (`scope.txt` says so): `contract/design-doc.md` and
   `prior.json`.
3. `scope.txt`, `stat.txt`, then all of `diff.patch`.
4. Each changed file under `../pr` (relative to the review directory),
   whole, and any file in `../pr` or the workspace root the change
   touches, calls or relies on.
5. `hunt/code-shared.md` (its METHOD applies to every finding) and
   `hunt/repo-code.md` when present; in design-doc mode also
   `hunt/design-shared.md` and `hunt/repo-design.md` when present.

`pr.txt` is the author's description: read it as claims to check against
the code.

## Hunt

Take each shape in the lists you read, in order, and look for its tells in
the change. Then hunt the boundaries of every changed condition: empty
input, zero, the last valid value, one past it, malformed input, error and
timeout paths, and whether each new test fails when the code is wrong.
Apply the METHOD to each candidate: verify it in the code, report it once
under the closest shape with a concrete failure scenario, and say plainly
when a list turned up nothing.

## Return

Fill every field exactly as `contract/output.md` defines it. Take
`contract_nonce` from `contract/output.md`, and `skill_marker` from the
line below, copied character for character.

skill_marker: hunting-defect-shapes@0.1.0:362c324dc9afa165
