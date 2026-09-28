---
name: planning-deployable-pr-sequences
description: Use when turning a design, spec or set of requirements into an implementation plan, or when reviewing a plan before anyone executes it.
---

# Planning deployable PR sequences

A plan is a sequence of PRs. Each task is one PR, with its own review and
its own CI run, mergeable the moment its own checks are green.

## Each task states

- **Exact files**: every file to create, every file to modify, and every
  test file, named by path.
- **The failing test first**: for a code task, name the test written
  before the implementation, and what it asserts.
- **Verification commands**: the exact commands to run, with the output
  or exit code that means the task is done.
- **Acceptance criteria**: the observable conditions that make the task
  complete.
- **Why it is safe to deploy alone**, as one or more of:
  - additive before use (new code, nothing calls it yet)
  - new behavior dark until switched on (behind a flag or unused path)
  - no dependency on a later PR (nothing in this task references a file,
    export or config key that a later task adds)
  - tests pass at that commit

## Waves

Group tasks touching disjoint files into the same wave; they can run and
merge in parallel. A file two tasks both touch puts them in different
waves. State the dependency order as edges between task numbers (for
example, "2 -> 5" means task 5 depends on task 2). Release or version-bump
steps go in the last task, after every other task in the plan.

## Model tier per task

Name the lowest tier that fits, with a one-line reason:

- **Smallest**: transcribing complete, given content, or a single-file
  mechanical edit.
- **Middle**: standard implementation work.
- **Largest**: design-level judgment (architecture, a stalled review,
  writing a discipline skill's rationalization table from observed
  behavior).

## Decide, do not defer

Every point the source spec leaves open gets one ruling, one line, in the
plan itself. A plan that pushes an open question to "later" or to whoever
implements the task has not finished planning.

## Reviewing a plan

Fix blockers only. Record anything non-blocking as a note on the task it
concerns, not as a plan-wide rewrite.

## Output check

Before handing a plan over, confirm:

1. Numbered sequence of tasks, each one PR.
2. Every task lists exact files, including test files.
3. Every task states why it is safe to merge alone, naming one of the
   four reasons above.
4. Every code task's test comes before its implementation.
5. Every task names exact verification commands.
6. Tasks are grouped into waves of disjoint files, with dependency order
   stated between task numbers.
7. Every task names a model tier with a one-line reason matching the
   tier rule.
8. The plan states that its own review fixes blockers only.
