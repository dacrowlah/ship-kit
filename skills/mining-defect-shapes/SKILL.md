---
name: mining-defect-shapes
description: Use when asked to mine merged PRs, commit history or review comments for defect shapes, when a shipped defect or a BLOCKING design finding fits no shape in a hunt list, or when a design PR has run more than three complete review rounds.
---

# Mining defect shapes

A pass proposes a change to one hunt list. `$SCRATCH` is the session scratchpad or a `mktemp -d`.

## Steps

1. **Target.** CODE (merged PRs, commit subjects, review comments) writes the repo code list; DESIGN (design-doc PRs' state markers and comments) writes the repo design list. The user names it.
2. **Window.** From `git log --format='%H %cs %s' -- <list>`, the date of the last commit that changed shapes, not only METHOD.
3. **Collect.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/mining/collect.mjs --target <code|design> --since <date> --list <list> --out "$SCRATCH/mining-evidence"`. Exit 1: a call failed, nothing was written; report it and stop. Read `reconciliation.txt` first; re-run as a truncation warning advises. Markers in `markers.json` are unverified leads: confirm each from the comment and the commits.
4. **Pass one.** PR bodies and commit subjects: one line per described defect (PR, sentence, mechanism, shape id or NEW). Apply the drop rules.
5. **Pass two.** Review comments. Reviewers' false positives become METHOD sentences, not shapes.
6. **Cluster by mechanism; amend before add.** A covering shape gets the cluster's labelled instances and new tells. A new shape needs an uncovered mechanism and at least two instances; list a singleton as left out. Tag new shapes `[generic]` or `[repo]`.
7. **DESIGN.** An instance is a BLOCKING finding in a design PR's markers; it earns a shape by recurring after RESOLVED in a later round, or in two or more design PRs.
8. **Propose.** Write the whole list to `$SCRATCH/mining-proposal.md` in the format of `hunt-list-format.md` (beside this file): ids never renumbered or re-titled; ASCII; no ticket numbers, PR numbers or review labels. Print `diff -u <list> "$SCRATCH/mining-proposal.md"` and each left-out candidate with its reason. That printout is the deliverable.
9. **Promotion.** A `[generic]` shape mined in two or more repositories is proposed for ship-kit's shared list as mechanism, tells and exclusions only.

## Drop rules

- A mutation is not an incident: record what its survival says about the suite.
- Name the commit holding the defective state and the one that fixed it. `git log --all -S '<literal>'` lists every commit that added or removed the literal, rewrites included; empty output means no commit ever contained it: drop it.
- Under squash merges read the tree at the merge commit.
- Label each kept instance "Reached main" or "Caught in review"; drop one fixed before any review saw it.

## Rationalizations

| Excuse | Reality |
|---|---|
| "the code no longer exists ... rewritten twice, and `git log --all -S` finds nothing" | The removing commit would be listed. Nothing listed: it never existed. |
| "This goes up as a branch or PR for the maintainer to review" | Mining ends at the printed diff: no branch, commit, push or PR. |
| "Match R5 to the style of R1-R4" | Use `hunt-list-format.md`'s format. |

## Red flags

- A kept instance with no named commit
- A new shape with one instance
- `git commit`, `git push` or `gh pr create` in the plan
- A heading not shaped `### <ID>. <Name> [tag]`

Each means: back to the drop rules or step 8.
