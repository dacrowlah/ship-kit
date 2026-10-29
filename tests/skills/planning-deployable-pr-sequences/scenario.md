## Kind

output-shaping

## Prompt

Write an implementation plan for this change in this repository: add a `--json` flag to `scripts/check-template-secrets.mjs` that prints violations as a JSON array, and a CI step in `.github/workflows/secret-scan.yml` that uploads that JSON as an artifact. Output only the plan.

## Pass criteria

1. The plan is a numbered sequence of tasks, each one PR.
2. Every task lists exact files to create or modify, including test files.
3. Every task states why it is safe to merge alone, naming one of: additive before use, new behavior dark until switched on, no dependency on a later task, tests pass at that commit.
4. Tests are written before the implementation in each code task.
5. Tasks are grouped into waves of disjoint files with the dependency order stated.
6. Every task names a model tier (smallest, middle or largest) with a one-line reason matching the tier rule.
7. The plan says its own review fixes blockers only.

## Run directory

`scripts/check-template-secrets.mjs`, `scripts/lib/entry-point.mjs` and `.github/workflows/secret-scan.yml`, copied at their relative paths.
