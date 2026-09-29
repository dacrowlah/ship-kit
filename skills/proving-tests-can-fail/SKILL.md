---
name: proving-tests-can-fail
description: Use when a fix and the test added for it are about to ship, commit or merge because the suite is green, when a test is claimed to guard a behavior, before calling a guard or regression test done, or when a reviewer asks whether a test can fail.
---

# Proving tests can fail

## The rule

A test is a guard only after you have watched it fail against the one production change it claims to catch. Until then it does not ship as a guard.

## Steps

1. Name the one production line whose reversal must turn the test red: start at the function the test calls, as the test is written, and follow it down to the line that implements the claim. A line the test never executes cannot turn it red, whoever named it.
2. Copy that file to a scratch directory: `cp <file> "$SCRATCH/"` (`$SCRATCH` is the session scratchpad or `mktemp -d`).
3. Apply the mutation to that one line.
4. Run only that test. It must fail on its assertion, not a syntax or import error.
5. Restore: `cp "$SCRATCH/<name>" <file>`, then `cmp` the two files.
6. Rerun the test; confirm it is green.
7. Record the mutation (file, line, before and after) and the red output where the change is reviewed: the PR body.

Never restore with `git checkout`, `git restore` or `git stash`: they also discard uncommitted real work, including the fix the test guards.

## When the test stays green

First check where the mutation went. Off the test's path, a green run says nothing: move the mutation to the line from step 1 and repeat from step 3. Never change the test so it reaches the line someone named: that proves a new assertion, and the test that ships as the guard stays unproven.

On the test's own path, it cannot fail for its claim: fix its assertion or fixture values and repeat from step 3, in the same change, before it ships.

## Rationalizations

| Excuse | Reality |
|---|---|
| "I'd accept that the case table covers it" | Green says the test passes. Only a red run says it can fail. |
| "do that mutation after the release", "I'll check that tomorrow", "propose a one-line test-only follow-up", "skip it and ship as-is" | By then the unproven test has shipped as a guard. It takes minutes now. |
| "the case is likely green regardless. I haven't checked either point." | A prediction. Run it. |
| "I don't have the old code." | Reverse the one line the test runs. |
| "C also edits the file the lead said not to touch." | The scratch copy restores it byte for byte; `cmp` proves it. |
| "Fixing the test would mean going against the lead's instruction, and that call is theirs." | Fixing a test that cannot fail is part of this change; an order about the production file does not cover the test file. |
| "That's harder to do in a way that's quick" | One copy, one line, one test run. Show the red. |
| "leave line 63 broken and add a test that runs the regex", "make the case table also check `globToRegExp`" | The guard that ships is the test as written. Mutate the line it runs. |
| "a `**` there can't match inside a segment anyway" | That is the claim under test. Break it on that path and watch the red. |

## Red flags

- A test called a guard with no red run observed
- Deferring the proof: "after merge", "tomorrow", "as a follow-up", "not proven yet"
- Mutating a line the test never reaches because someone named it, or changing the test so it reaches that line
- Handing a test that stayed green back to someone else to decide
- Reaching for `git checkout`, `git restore` or `git stash` to undo a mutation

Each means: go back to step 1.
