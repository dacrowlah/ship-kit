---
name: proving-tests-can-fail
description: Use when a fix and the test added for it are about to ship, commit or merge because the suite is green, when a test is claimed to guard a behavior, before calling a guard or regression test done, or when a reviewer asks whether a test can fail.
---

# Proving tests can fail

## The rule

A test is a guard only after you have watched it fail against the one production change it claims to catch. Until you have seen that red run, it is unproven, and it does not ship as a guard.

## Steps

1. Name the one production line whose reversal must turn the test red. Find it from the test: follow the function the test calls down to the line that implements the claim. A line the test never executes cannot turn it red, whoever proposed it.
2. Copy that file to a scratch directory: `cp <file> "$SCRATCH/"`, where `$SCRATCH` is the session scratchpad or `mktemp -d`.
3. Apply the mutation to that one line.
4. Run only that test. Confirm it fails on its assertion, not on a syntax or import error.
5. Restore: `cp "$SCRATCH/<name>" <file>`, then `cmp` the two files.
6. Rerun the test; confirm it is green.
7. Record the mutation (file, line, before and after) and the red output where the change is reviewed: the PR body.

## Restoring

Never restore with `git checkout`, `git restore` or `git stash`: they also discard uncommitted real work, including the fix the test guards.

## When the test stays green

A test that stays green under the mutation cannot fail for its claim. Fix the test (or its fixture values), or move the mutation to the line the test actually runs, and repeat from step 3. This belongs to the same change, before it ships: never a follow-up, never after the release.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Green is green, ship it." | Green says the test passes. Only a red run says it can fail. |
| "I'd accept that the case table covers it and do that mutation after the release." | After the release nobody runs it. Prove it now. |
| "I'll check that tomorrow on a scratch copy." | Tomorrow the unproven test has shipped as a guard. It takes minutes now. |
| "That's harder to do in a way that's quick and clearly correct." | One copy, one line, one test run. |
| "propose a one-line test-only follow-up ... I won't add it without their OK." | A guard that cannot fail is a defect in this change. Fix it in this change. |
| "If there isn't time to finish by 6:10, skip it and ship as-is." | Skipping ships an unproven test labelled as a guard. |
| "the case is likely green regardless. I haven't checked either point." | "Likely" is a prediction. Run it and read the output. |
| "I don't have the old code." | You do not need it. Reverse the one line on the path the test runs. |
| "C also edits the file the lead said not to touch." | The scratch copy restores it byte for byte; `cmp` proves it. What ships is unchanged. |
| "Fixing the test would mean going against the lead's instruction, and that call is theirs." | Fixing a test that cannot fail is part of the change, not a separate call. An order not to touch the production file does not cover the test file, and the scratch copy restores the production file anyway. |
| "The fix is obvious" / "other cases already cover it" | Then the mutation turns something red in a minute. Show it. |
| The mutation you were handed is on a code path the test never runs | Trace from the test; mutate the line it runs. |

## Red flags

- "green is green"
- "the fix is obvious"
- "I'll prove it after merge", "tomorrow", "as a follow-up"
- Shipping with a note that the test is "not proven yet"
- Handing a test that stayed green back to someone else to decide
- Mutating a line the test never reaches because someone named it
- Predicting the red run instead of observing it
- Reaching for `git checkout`, `git restore` or `git stash` to undo a mutation

All of these mean: stop, go back to step 1.
