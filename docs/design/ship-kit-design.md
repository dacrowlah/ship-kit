# ship-kit design

ship-kit packages a review-and-shipping practice into one versioned Claude
Code plugin. Local sessions get skills and commands from it. CI gets
centrally maintained GitHub reusable workflows from the same repository,
called by thin caller files that `/ship-kit:setup` writes into each
adopting repo. CI review seats load the same plugin at the same commit, so a
local review and a CI review run the same instructions against the same
hunt lists.

This document states the current design only. Each mechanism is specified
once, in its own section; other sections cite it by section number.

Contents:

1. Owner rulings
2. Platform facts this design relies on
3. Architecture
4. Component inventory
5. Configuration
6. Review engine: reusable workflow, caller, gate
7. How CI loads the plugin
8. Design-doc mode
9. Hunt lists
10. Seats and shadow-then-promote
11. Finding contract, rebuttal and override
12. Patch-coverage gate
13. Preflight, receipt and hook guards
14. `/ship-kit:develop` and the change classifier
15. `/ship-kit:ship`
16. `/ship-kit:ci-watch`, watchers and merge
17. Practice skills
18. Mining defect shapes
19. `/ship-kit:setup`: install, update, drift
20. Security model
21. Test strategy
22. Release plan
23. Migrating the adopting repos
24. Self-check
25. Owner decisions needed

---

## 1. Owner rulings

Recorded 2026-09-28 from the owner's brief, in the owner's words. Each
points at the section that implements it and the test that pins it.

| # | Ruling (owner's words) | Implemented in | Pinned by |
|---|---|---|---|
| R1 | "gives local Claude sessions the skills and commands, and ... provides CI via centrally maintained GitHub reusable workflows in ship-kit, called by thin caller files that `/ship-kit:setup` installs into adopting repos pinned to a ship-kit tag" | 6, 19 | `tests/setup/render.test.mjs` (caller renders a `uses:` pinned to a tagged SHA) |
| R2 | "CI seats load the same plugin through claude-code-action's `plugins`/`plugin_marketplaces` inputs so local and CI share one source of skills and hunt lists" | 7, 9 | dogfood workflow run (21.4) |
| R3 | "Files that must be inlined per repo (preflight, config) carry a version stamp and setup has a diff-before-write update mode" | 19 | `tests/setup/drift.test.mjs` |
| R4 | "design-doc mode (only when every changed file is under configured spec/plan dirs; incremental re-review from a trusted, unedited bot state marker chosen by ancestry; gate fails only on BLOCKING, missing severity = BLOCKING; hunt list read from the BASE branch / pinned version, never the PR head)" | 8, 9 | `tests/review/design-doc-mode.test.mjs` |
| R5 | "dual review (general + adversarial) as required checks" | 6, 10 | `tests/review/aggregate.test.mjs`; caller gate test (21.1) |
| R6 | "shadow-then-promote per seat" | 10 | `tests/review/plan.test.mjs` (enforced output from base config) |
| R7 | "Mining skill with two targets sharing one method (two passes; mutation != incident; name the defect's existing and fixing commits; cluster by mechanism; amend before add)" | 18 | pressure test `tests/skills/mining-defect-shapes/` |
| R8 | "New repos bootstrap with the 20 generic design shapes and a method-only adversarial list." | 9 | `tests/setup/render.test.mjs` (fresh install hunt-list files) |
| R9 | "Out of scope: hub invariant test suites, mechanical red/green replay." | not built | none; nothing in this design depends on either |
| R10 | Releases 1 to 6 as listed in the brief, "each its own PR sequence" | 22 | release checklist (22.8) |
| R11 | "Both adopting repos migrate from their hand-built copies (design the migration, including running old and new checks side by side and switching required-check names)." | 23 | migration exit criteria (23.1, 23.2) |
| R12 | Owner practices: "plans as sequences of discrete PRs each safe to deploy alone, parallel waves, lowest-tier model per task; after PASS/PASS fold findings once and stop; no change logs in design docs; fix findings in the same PR; mutate to prove a test can fail; run preflight before push"; "admin-merge ritual when checks green" | 13, 15, 16, 17 | skill pressure tests (21.5) |

---

## 2. Platform facts this design relies on

Every platform claim the design depends on appears here once, with its
source. Sections cite this table by row. "Verified" means read at the
named source on 2026-09-28; UNVERIFIED rows name the test that settles
them before the dependent release ships.

| # | Fact | Source | Status |
|---|---|---|---|
| F1 | A `job` context in a reusable workflow exposes `job.workflow_repository` and `job.workflow_sha`, "the commit SHA of the workflow file that defines the current job". Not available on GitHub Enterprise Server. | docs.github.com, Actions contexts reference | Verified |
| F2 | `secrets: inherit` works only for callers "in the same organization or enterprise". A caller owned by anyone else must pass each secret explicitly. | docs.github.com, reusing workflows | Verified |
| F3 | Permissions "can only be maintained or reduced, not elevated" through a reusable-workflow chain. | docs.github.com, reusing workflows | Verified |
| F4 | `issue_comment` runs with `GITHUB_SHA` = last commit on the default branch; a check it creates does not attach to the PR head. `pull_request` does not run while the PR has a merge conflict; fork PRs receive no secrets. | docs.github.com, events that trigger workflows | Verified |
| F5 | claude-code-action accepts in `plugin_marketplaces` either an `https://...git` URL (regex requires the string to end in `.git`, so a `#ref` suffix is rejected) or a local path starting with `./`, `../` or `/`; `plugins` takes `name@marketplace`. It runs `claude plugin marketplace add` then `claude plugin install`. | claude-code-action v1.0.236, `base-action/src/install-plugins.ts` lines 7-8, 15-23, 30-53 | Verified |
| F6 | When the `github_token` input is set, the action uses it and skips the OIDC-to-app-token exchange. The exchange is where the server refuses a run whose workflow file differs from the default branch. | claude-code-action v1.0.236, `src/github/token.ts` `setupGitHubToken`, `isWorkflowValidationError` | Verified |
| F7 | The action outputs `structured_output` when `--json-schema` is passed in `claude_args`. | claude-code-action v1.0.236, `action.yml` line 183 | Verified |
| F8 | SKILL.md content substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` (plugin skills only) and `${CLAUDE_PROJECT_DIR}`; `disable-model-invocation: true` removes a skill from Claude's context listing and leaves it user-invocable. | code.claude.com/docs/en/skills | Verified; contradicts the current CLAUDE.md rule, see 22.1 PR 1.1 |
| F9 | Hook `if` takes one permission rule (`Bash(git *)`); exec form is `command` + `args`; a PreToolUse deny is `hookSpecificOutput.permissionDecision: "deny"` with a reason; `hooks/hooks.json` has an optional top-level `description`. | code.claude.com/docs/en/hooks | Verified |
| F10 | Whether a leading wildcard in an `if` rule (`Bash(*--no-verify*)`) matches a compound command such as `cd x && git push --no-verify`. | code.claude.com/docs/en/hooks says matching "depends on the shape of the pattern" | UNVERIFIED; settled by `tests/hooks/live-match.md` in PR 3.2 |
| F11 | Plugin sources in `marketplace.json` support `ref` and `sha` pins. | code.claude.com/docs/en/plugin-marketplaces | Verified |
| F12 | `extraKnownMarketplaces` in a repo's `.claude/settings.json` accepts a `github` source with a `ref`. | plugin-facts research note ("Pin via ref/sha") | UNVERIFIED for the settings key; settled by the fixture test in PR 2.5; fallback in 19.4 |
| F13 | A prompt beginning `/ship-kit:<skill>` passed to `claude -p` or to the action's `prompt` input invokes that skill, with no `Skill` tool in the allowlist. | plugin-facts research note | UNVERIFIED; settled by the dogfood run in PR 2.4 |
| F14 | Cross-plugin skill invocation by name (ship-kit naming a superpowers skill) works in practice and is not a documented contract. | ship-kit CLAUDE.md, "Unverified" | UNVERIFIED by design; 14.3 degrades when it fails |
| F15 | Installing ship-kit auto-installs its declared dependency `superpowers` from `claude-plugins-official`, which must be allow-listed in `allowCrossMarketplaceDependenciesOn` (already set). Whether CI must add that marketplace explicitly for the dependency to resolve. | code.claude.com/docs/en/plugins/dependencies | First part verified; second UNVERIFIED, settled by the dogfood run in PR 2.4 (7.2 adds it explicitly regardless) |

---

## 3. Architecture

Three layers, one rule: anything that can be a script is a script.

- **Layer 0, deterministic scripts** (`scripts/`, no model): planning and
  aggregating reviews, config validation, rendering and drift detection,
  classification, patch coverage, receipts, hook guards, watchers. Every
  script is Node, uses only the Node standard library (plugin installs run
  no `npm install`, so a dependency would not exist at runtime), and is
  covered by `node --test`.
- **Layer 1, thin skills**: each says which script to run and how to read
  its exit code and output. `/ship-kit:setup`, `develop`, `ship`,
  `ci-watch`, `merge`, and the four seat skills.
- **Layer 2, judgment skills**: what cannot be scripted. Review method,
  design review, planning, mining, proving tests can fail, resolving
  findings. ship-kit's own judgment skills cover review and shipping;
  superpowers covers work before code is written (brainstorming, planning,
  TDD). Where they overlap (verification before completion), `/ship` wins,
  because only it knows the receipt, the gates and the seats.

One source for local and CI: the seat skills, the output contract and the
shared hunt lists live in the plugin. CI checks out ship-kit at the exact
commit of the reusable workflow it is running (F1) and installs the plugin
from that checkout (7). Local sessions run the same seat skills headless
(15.3). The repo-specific inputs (config, repo hunt lists) are read from
the PR's base commit in both places (5.3, 9.2).

---

## 4. Component inventory

Paths are relative to the plugin root. "dmi" marks
`disable-model-invocation: true`. Seat skills are dmi so they cost nothing
in a session's context listing (F8) and run only when named in a prompt.

### 4.1 Skills

| Path | Invoked as | dmi | Release |
|---|---|---|---|
| `skills/setup/SKILL.md` | `/ship-kit:setup [install\|update\|check]` | yes | 2 |
| `skills/develop/SKILL.md` | `/ship-kit:develop` | no | 3 |
| `skills/ship/SKILL.md` | `/ship-kit:ship` | yes | 3 |
| `skills/ci-watch/SKILL.md` | `/ship-kit:ci-watch <pr>` | yes | 6 |
| `skills/merge/SKILL.md` | `/ship-kit:merge <pr>` | yes | 6 |
| `skills/reviewing-design-documents/SKILL.md` + `pattern-method.md` | model | no | 1 |
| `skills/planning-deployable-pr-sequences/SKILL.md` | model | no | 1 |
| `skills/proving-tests-can-fail/SKILL.md` | model | no | 1 |
| `skills/watching-pr-checks/SKILL.md` | model | no | 1 |
| `skills/mining-defect-shapes/SKILL.md` + `hunt-list-format.md` | model | no | 1 |
| `skills/reviewing-for-correctness/SKILL.md` | seat prompt | yes | 2 |
| `skills/hunting-defect-shapes/SKILL.md` | seat prompt | yes | 2 |
| `skills/promoting-shadow-checks/SKILL.md` | `/ship-kit:promoting-shadow-checks` | yes | 2 |
| `skills/measuring-coverage-baseline/SKILL.md` | `/ship-kit:measuring-coverage-baseline` | yes | 4 |
| `skills/resolving-review-findings/SKILL.md` | model | no | 5 |
| `skills/reviewing-security/SKILL.md` | seat prompt | yes | 5 |
| `skills/reviewing-test-integrity/SKILL.md` | seat prompt | yes | 5 |

The command skills (`setup`, `develop`, `ship`, `ci-watch`, `merge`) keep
the owner's imperative names; the naming rule is Owner decision 1.

### 4.2 Hooks

| Path | Event | Scope |
|---|---|---|
| `hooks/hooks.json` | PreToolUse, matcher `Bash` | 13.5 |

### 4.3 Scripts

| Path | Purpose | Section |
|---|---|---|
| `scripts/lib/config.mjs` | load, validate, default the config | 5 |
| `scripts/lib/schema.mjs` | JSON Schema subset interpreter | 5.2 |
| `scripts/lib/glob.mjs` | `*`, `**`, `?` path matching | 5, 12, 14 |
| `scripts/lib/stamp.mjs` | managed-file stamps and hashes | 19.2 |
| `scripts/lib/render.mjs` | `<<key>>` template rendering | 19.3 |
| `scripts/review/review-mode.mjs` | modes, schemas, severity, state marker | 8 |
| `scripts/review/plan.mjs` | partition, scope, priors, materialize `.pr-review/` | 6.3, 8 |
| `scripts/review/aggregate.mjs` | fail-closed verdict, comment, state | 6.3, 8 |
| `scripts/review/override.mjs` | parse and authorize overrides and rebuttals | 11 |
| `scripts/review/local-seats.mjs` | run seats headless for `/ship` | 15.3 |
| `scripts/coverage/lcov.mjs` | parse and merge LCOV | 12 |
| `scripts/coverage/patch-coverage.mjs` | changed-line coverage | 12 |
| `scripts/coverage/baseline.mjs` | threshold from shadow runs | 12.4 |
| `scripts/classify/classify.mjs` | trivial / standard / hub | 14 |
| `scripts/classify/change-class-check.mjs` | CI check for hub changes | 14.4 |
| `scripts/setup/cli.mjs` | detect, render, diff, write, check | 19 |
| `scripts/mining/collect.mjs` | fetch PRs, comments and state markers | 18 |
| `scripts/promote/shadow-record.mjs` | count clean shadow runs | 10.3 |
| `scripts/hooks/deny-hook-bypass.mjs` | the `--no-verify` guard | 13.5 |
| `scripts/watch/watch-pr-checks.sh` | poll PR checks to one summary line | 16.2 |
| `scripts/watch/watch-merge-deploy.sh` | poll a merge commit's runs | 16.2 |
| `scripts/merge/admin-merge.sh` | the admin-merge ritual | 16.4 |

No top-level `bin/` (CLAUDE.md, Hooks and scripts). Skill prose invokes
every script through its interpreter (`node ...`, `bash ...`) using
`${CLAUDE_PLUGIN_ROOT}` (F8).

### 4.4 Review content (plugin-shared, read by seats)

| Path | Content | Section |
|---|---|---|
| `review/contract/output.md` | the seat output contract, both modes | 6.4 |
| `review/contract/design-doc.md` | design-doc mode instructions and severity rule | 8.3 |
| `review/contract/untrusted-data.md` | how seats treat priors, rebuttals, PR text | 20 |
| `review/hunt-lists/design-shared.md` | the 20 generic design shapes, ids `D1`..`D20` | 9 |
| `review/hunt-lists/code-shared.md` | the adversarial METHOD plus shared code shapes `S1`.. (none at launch) | 9 |

### 4.5 Templates (rendered into adopting repos)

| Path | Written to | Kind |
|---|---|---|
| `templates/callers/review.yml.tmpl` | `.github/workflows/ship-kit-<seat>.yml` | managed file |
| `templates/callers/change-class.yml.tmpl` | `.github/workflows/ship-kit-change-class.yml` | managed file |
| `templates/blocks/coverage-jobs.yml.tmpl` | inside the repo's test workflow | managed block |
| `templates/blocks/claude-md-workflow.md.tmpl` | inside the repo's `CLAUDE.md` | managed block |
| `templates/files/preflight.mjs` | `.ship-kit/preflight.mjs` | managed file |
| `templates/files/pre-push` | `.githooks/pre-push` | managed file |
| `templates/files/config.json` | `.ship-kit/config.json` | user-owned, stamped |
| `templates/files/hunt-list-code.md` | `.ship-kit/hunt-lists/code.md` | user-owned seed |
| `templates/files/hunt-list-design.md` | `.ship-kit/hunt-lists/design.md` | user-owned seed |

`templates/files/preflight.mjs` is itself a runnable module; its tests
import it directly, so the inlined copy and the tested code are the same
file.

### 4.6 Repository files (not part of the plugin payload)

| Path | Purpose |
|---|---|
| `.github/workflows/review.yml` | reusable review workflow (6) |
| `.github/workflows/patch-coverage.yml` | reusable coverage workflow (12) |
| `.github/workflows/change-class.yml` | reusable change-class workflow (14.4) |
| `.github/workflows/ci.yml` | ship-kit's own CI (21) |
| `.github/workflows/ship-kit-general.yml`, `ship-kit-adversarial.yml` | ship-kit's own dogfood callers (21.4) |
| `schemas/config.schema.json` | the config schema, single source (5.2) |
| `tests/` | all tests (21) |

---

## 5. Configuration

### 5.1 File and format

One file, `.ship-kit/config.json`, committed. JSON, because every consumer
(Node scripts, the Actions plan job, setup) parses it with no dependency,
and because the schema validator in 5.2 is JSON-native. The file has two
halves with different lifetimes:

- **`render`**: read only by `/ship-kit:setup`, baked into caller files and
  managed blocks at setup time. Changing a `render` key takes effect when
  setup re-renders (19.5 reports the drift).
- **Everything else**: read at run time by the plan job and by local
  scripts, always from the PR's base commit in CI (5.3).

```json
{
  "schemaVersion": 1,
  "shipKit": { "version": "0.2.0", "sha": "0000000000000000000000000000000000000000" },
  "render": {
    "auth": { "kind": "oauth", "secret": "CLAUDE_CODE_OAUTH_TOKEN" },
    "runners": {
      "plan": ["ubuntu-latest"],
      "seat": ["ubuntu-latest"],
      "aggregate": ["ubuntu-latest"],
      "gate": ["ubuntu-latest"]
    },
    "bootWorkflow": null,
    "seats": ["general", "adversarial"],
    "checks": {
      "general": "ship-kit general review",
      "adversarial": "ship-kit adversarial review",
      "security": "ship-kit security review",
      "test-integrity": "ship-kit test-integrity review",
      "coverage": "ship-kit patch coverage",
      "change-class": "ship-kit change class"
    },
    "coverageWorkflow": null,
    "changeClassCheck": false
  },
  "review": {
    "specDirs": ["docs/design/"],
    "planDirs": ["docs/plans/"],
    "seats": {
      "general": { "mode": "required", "model": null },
      "adversarial": { "mode": "shadow", "model": null }
    },
    "maxSeats": 12,
    "targetLines": 1500,
    "maxTurns": 120,
    "huntLists": {
      "code": ".ship-kit/hunt-lists/code.md",
      "design": ".ship-kit/hunt-lists/design.md"
    },
    "override": { "label": "ship-kit-override", "minPermission": "write" },
    "promotion": { "cleanRuns": 5, "falsePositiveLabel": "ship-kit-false-positive" },
    "allowUntaggedShipKit": false
  },
  "coverage": {
    "mode": "shadow",
    "include": ["src/**"],
    "exclude": [],
    "threshold": null,
    "baseline": null
  },
  "preflight": {
    "steps": [
      { "name": "lint", "tier": "fast", "run": ["npm", "run", "lint"] },
      { "name": "unit", "tier": "fast", "run": ["npm", "test"] },
      { "name": "integration", "tier": "full", "run": ["npm", "run", "test:integration"], "requires": ["docker"] }
    ],
    "prerequisites": { "docker": ["docker", "info"] },
    "prePushTier": "full"
  },
  "classify": {
    "trivial": ["**/*.md", "docs/**"],
    "hub": [],
    "hubRequires": ["spec", "plan"]
  },
  "ship": { "maxIterations": 5 },
  "ciWatch": { "maxIterations": 3, "pollSeconds": 30 },
  "merge": { "method": "squash", "adminRitual": false }
}
```

The example parses: `node -e 'JSON.parse(require("fs").readFileSync(0))'`
was run over it.

Per-repo settings the brief names, and where each lives: design-doc dirs
(`review.specDirs`, `review.planDirs`), runner labels (`render.runners`),
auth secret (`render.auth`), check names (`render.checks`), override label
(`review.override.label`), coverage command and threshold (the coverage
command is the repo's own test job, 12.2; threshold `coverage.threshold`),
preflight steps (`preflight.steps`), hub-file globs (`classify.hub`),
repo-specific hunt list location (`review.huntLists`).

`maxSeats`, `targetLines` and `maxTurns` defaults are the working values of
the first adopting repo, carried as starting points; nothing derives from
them.

### 5.2 Schema and validation

`schemas/config.schema.json` is the only definition of the config's shape.
`scripts/lib/schema.mjs` interprets the subset of JSON Schema the file uses
(`type`, `enum`, `const`, `required`, `properties`,
`additionalProperties: false`, `items`, `pattern`, `minimum`, `maximum`,
`default`), so there is no second hand-written copy of the rules.
`tests/lib/schema.test.mjs` fails if the schema uses a keyword the
interpreter does not implement. `scripts/lib/config.mjs` applies `default`
values from the schema.

A change to the schema that makes any previously valid file invalid, or
changes a key's meaning, is a breaking change (CLAUDE.md, Repo rules,
"changed config schema") and ships with a migration in
`scripts/setup/migrations/<from>-to-<to>.mjs` (19.5).

### 5.3 Reading config from the base commit

The plan jobs (6.3, 12.3, 14.4) read the config with
`git show "$BASE_SHA:.ship-kit/config.json"`, never from the PR head, so a
PR cannot move itself into design-doc mode, demote a seat to shadow, lower
the coverage threshold, or change who may override. A PR that edits the
config takes effect for the PRs after it merges.

**Absent or invalid base config yields strict defaults**: every seat whose
caller exists is enforced, design-doc mode is off (no dirs), coverage is
enforced only if a threshold exists, override is disabled. The run posts a
notice saying which. Strict defaults fail closed without deadlocking: the
PR that fixes a broken config is reviewed in full mode and can pass.

Local scripts read the config at the merge base too (15.3), so local and CI
classify a change the same way.

---

## 6. Review engine: reusable workflow, caller, gate

### 6.1 Shape

```
caller (adopting repo, managed file)          review.yml (ship-kit, pinned SHA)
  [boot]  (optional repo workflow)
  review  --uses-->                           plan -> seat (matrix) -> aggregate
  gate    (name = required check)  <-- outputs: status, enforced, mode
```

The gate job stays in the caller so its `name:` is exactly the configured
required-check string. The reusable workflow's aggregate job never fails on
findings; it reports `status` and `enforced` and the caller's gate decides.

### 6.2 `review.yml` API

`on: workflow_call` with:

| Kind | Name | Type | Required | Meaning |
|---|---|---|---|---|
| input | `seat` | string | yes | `general`, `adversarial`, `security` or `test-integrity` |
| input | `runners` | string (JSON) | yes | `{"plan":[...],"seat":[...],"aggregate":[...]}` label arrays |
| input | `config_path` | string | no, default `.ship-kit/config.json` | where the base commit's config lives |
| secret | `claude_code_oauth_token` | secret | no | OAuth auth for seats |
| secret | `anthropic_api_key` | secret | no | API-key auth for seats |
| output | `status` | string | | `pass`, `fail-findings`, `fail-coverage`, `fail-config`, `override` |
| output | `enforced` | string | | `true` or `false`; from the base config's seat mode |
| output | `mode` | string | | `full` or `design-doc` |

Exactly one secret must be non-empty; otherwise the plan job fails with an
error naming both (fail closed). Every input, output, secret and the
meaning of each `status` value is API: changing any of them is a breaking
change (CLAUDE.md, Versioning and releases).

Secrets are passed explicitly, never `secrets: inherit`, because adopting
repos are owned by other accounts than ship-kit (F2).

### 6.3 Jobs inside `review.yml`

All third-party actions are pinned by full commit SHA with the tag in a
trailing comment. Node for the scripts is set up at a version fixed in
`review.yml` (24), not the caller's, so scripts run under the version they
were tested on.

**plan** (`runs-on: ${{ fromJSON(inputs.runners).plan }}`; permissions
contents read, pull-requests read, issues read):

1. Check out the adopting repo, `fetch-depth: 0`.
2. Check out ship-kit into `.ship-kit-src` at
   `repository: ${{ job.workflow_repository }}`,
   `ref: ${{ job.workflow_sha }}` (F1).
3. Verify the pin: `git -C .ship-kit-src ls-remote --tags origin 'ship-kit--v*'`
   must list a tag whose peeled commit equals `job.workflow_sha`, unless the
   base config sets `review.allowUntaggedShipKit` (used only by ship-kit's
   own canary, 21.4). Failure sets `status=fail-config`.
4. Run `node .ship-kit-src/scripts/review/plan.mjs`. It reads the base
   config (5.3), classifies the mode (8.1), evaluates overrides (11.3),
   partitions the diff, and materializes `.pr-review/`:
   `seat-N.patch`, `seat-N.stat`, `pr.txt`, `scope.txt`, `seat-N.prior.json`
   (design-doc mode), `rebuttals.json` (11.2), `contract/*.md` copied from
   `.ship-kit-src/review/contract/`, and `hunt/` (9.2). It asserts every
   changed file lands in exactly one seat and exits non-zero otherwise.
   Outputs: `matrix`, `count`, `empty`, `mode`, `json_schema`, `enforced`,
   `override`.
5. Upload `.pr-review` (`include-hidden-files: true`, because
   `upload-artifact` drops dot-directories otherwise).

**seat** (matrix over `plan.outputs.matrix`, `fail-fast: false`, skipped
when `empty` or `override` is true; permissions contents read,
pull-requests write, issues read):

1. Check out the adopting repo (shallow) and ship-kit into `.ship-kit-src`
   at `job.workflow_sha`.
2. Download the plan artifact; copy this seat's chunk to
   `.pr-review/diff.patch`, `stat.txt`, `prior.json`.
3. Run `anthropics/claude-code-action` with:
   - `github_token: ${{ github.token }}` (F6; see 20.3 and Owner decision 3)
   - the auth secret from 6.2
   - `plugin_marketplaces` and `plugins` per 7
   - `prompt: /ship-kit:<skill for inputs.seat> .pr-review`
   - `claude_args`:
     `--allowedTools "Read,Grep,Glob,TodoWrite,Bash(gh pr view:*),mcp__github_inline_comment__create_inline_comment"`,
     `--max-turns <review.maxTurns>`, `--json-schema '<plan json_schema>'`,
     and `--model <model>` when the seat's config names one.
   `Task` is absent from the allowlist: a seat is already one shard and
   must not fan out, since headless CI orphans in-agent subagents. There is
   no broad `Bash` while a token is in the environment. `GH_TOKEN` is set
   at step scope only.
4. Always write and upload a receipt `{seat, body}`; `body` is `null` when
   the action returned no structured output.

**aggregate** (`needs: [plan, seat]`, `if: always()`, on the `aggregate`
runner so it does not share fate with the seat machines):

1. Download receipts (zero receipts is valid and fails closed) and, in
   design-doc mode, the plan.
2. `node .ship-kit-src/scripts/review/aggregate.mjs` writes the comment and
   `status`. Coverage is checked before verdict: a planned seat with no
   receipt, a null body, a verdict outside `PASS`/`FAIL`, `complete !==
   true`, or more planned seats than receipts is `fail-coverage`. An
   unrecognized or missing status file is `fail-coverage`.
3. Post the comment with `gh pr comment` (author `github-actions[bot]`).
4. Set outputs `status`, `enforced`, `mode`. The job exits 0 on every
   status; only a crash fails it, which the caller's gate treats as a
   failure (6.5).

### 6.4 Seat output contract

`review/contract/output.md` is the only statement of it; the seat skills
point at it. In full mode a seat returns `verdict` (`PASS`/`FAIL`),
`complete`, `unreviewed`, `summary`, and (from release 5) `findings[]`
with `severity`, `file`, `line`, `finding`, `failure_scenario`.
`review-mode.mjs` generates the matching JSON Schema for each mode; the
schema is passed as a single-quoted shell word, so neither schema may
contain a single quote (`tests/review/review-mode.test.mjs` asserts it).

### 6.5 Caller template

`templates/callers/review.yml.tmpl`. Placeholders use `<<key>>` so they
never collide with `${{ }}` expressions. `render.mjs` refuses unknown keys
and any unreplaced placeholder.

```yaml
# ship-kit-managed: <<stamp_json>>
# Rendered by /ship-kit:setup from .ship-kit/config.json. Hand edits are reported as drift.
# Requires the repository secret <<secret>> (<<auth_text>>).
name: ship-kit <<seat>> review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ship-kit-<<seat>>-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions: {}

jobs:
<<boot_job>>
  review:
<<review_needs>>
    permissions:
      contents: read
      pull-requests: write
      issues: read
    uses: dacrowlah/ship-kit/.github/workflows/review.yml@<<ship_kit_sha>> # ship-kit--v<<ship_kit_version>>
    with:
      seat: <<seat>>
      runners: '<<runners_json>>'
    secrets:
      <<secret_input>>: ${{ secrets.<<secret>> }}

  gate:
    name: <<check_name>>
    needs: [<<gate_needs>>]
    if: always()
    runs-on: <<gate_runner_json>>
    steps:
      - name: Require the review to have run and passed
        env:
          ALL_SUCCEEDED: ${{ !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') && !contains(needs.*.result, 'skipped') }}
          STATUS: ${{ needs.review.outputs.status }}
          ENFORCED: ${{ needs.review.outputs.enforced }}
        run: |
          echo "needs succeeded: $ALL_SUCCEEDED; status: ${STATUS:-none}; enforced: ${ENFORCED:-unknown}"
          if [ "$ALL_SUCCEEDED" = "true" ] && { [ "$STATUS" = "pass" ] || [ "$STATUS" = "override" ]; }; then
            exit 0
          fi
          if [ "$ENFORCED" = "false" ]; then
            echo "::warning::This seat is in shadow mode. It would have failed with status '${STATUS:-none}'."
            exit 0
          fi
          echo "::error::The review did not run to a pass (status '${STATUS:-none}'). An absent or incomplete review is not a pass. See the review jobs and the summary comment."
          exit 1
```

`<<boot_job>>` is empty unless `render.bootWorkflow` names a local reusable
workflow that must run first (for example, starting self-hosted capacity);
then it renders a `boot` job with `uses:` that path, and `review` gains
`needs: boot`. `<<gate_needs>>` is `review` or `boot, review`.

Gate properties, each pinned by `tests/callers/gate.test.mjs`, which
extracts the `run:` block from a rendered caller and executes it with
`bash` under every combination of the three variables:

- A dependency that failed, was cancelled or was skipped fails the gate,
  because GitHub counts a skipped required check as passing and the gate
  must not inherit that.
- An empty `ENFORCED` (plan never ran) is enforced.
- A shadow seat passes with a warning, whatever its status.
- A workflow that never triggers (merge conflict, F4) creates no gate
  check; a required context with no check is pending, which blocks.

The `run:` block above was executed with `bash` for the eight combinations
of `ALL_SUCCEEDED` in {true,false}, `STATUS` in {pass,fail-findings},
`ENFORCED` in {true,false}; it exited 0 exactly when the review passed or
the seat was shadow.

### 6.6 Required-check names

The required contexts are the rendered gate `name:` values from
`render.checks` (5.1). A shadow seat's gate is added to branch protection
at install like any other (19.4), so promotion is a reviewed config change
and a deleted caller shows as a pending required check rather than silently
disappearing. The default names are API: changing a default is a breaking
change (CLAUDE.md, Versioning and releases).

---

## 7. How CI loads the plugin

### 7.1 Pinning

The caller pins `review.yml` to a full commit SHA (the tag in a comment),
because a SHA is immutable and a tag is not (CLAUDE.md, Workflow
templates). Every job inside `review.yml` checks out ship-kit at
`job.workflow_sha` (F1) and 6.3 step 3 verifies that SHA is a release tag.
The scripts, the seat skills, the contract and the shared hunt lists all
come from that one checkout, so they cannot disagree with the workflow.

### 7.2 Exact inputs on the seat step

```yaml
plugin_marketplaces: |
  ./.ship-kit-src
  https://github.com/anthropics/claude-plugins-official.git
plugins: |
  ship-kit@ship-kit
```

- `./.ship-kit-src` is a local-path marketplace (F5). A git URL cannot be
  used here, because the action rejects a URL with a `#ref` suffix (F5),
  so a URL would install whatever the default branch holds.
- The official marketplace is listed so the declared superpowers
  dependency resolves (F15). Seats invoke no superpowers skill; the
  dependency only has to install. Its version is not pinned in CI, which
  affects nothing the seats run.
- A failed install fails the action step, the seat records a null receipt,
  and aggregate returns `fail-coverage`: fail closed.

### 7.3 Seat prompt

The prompt is the slash command and the review directory, nothing else:
`/ship-kit:hunting-defect-shapes .pr-review`. Everything else a seat needs
is a file in `.pr-review/`. The prompt contains no `${{ }}` of any size, so
the Actions expression length cap does not apply to hunt-list growth.
`.ship-kit-src/` sits in the workspace; `review/contract/output.md` tells
seats it is not part of the repository under review.

---

## 8. Design-doc mode

### 8.1 Entry

`classifyMode(paths, dirs)` in `review-mode.mjs`: design-doc mode when the
PR changes at least one file and every changed path (both sides of every
rename, `--no-renames`) starts with a directory in `review.specDirs` or
`review.planDirs` of the base config. Anything else, including an empty
diff, is full mode. With no dirs configured the mode never triggers.

### 8.2 Incremental scope and the state marker

- Aggregate writes the comment's first line as
  `<!-- ship-kit-review-state <base64url JSON> -->` carrying
  `{v, kind, head, mode, complete, mergeBase, findings}`; `kind` is the seat
  name. Only the first line is parsed, so text a seat returns cannot stand
  in for it.
- A state comment is trusted only if its author is `github-actions[bot]`
  and `created_at == updated_at` (anyone with write access can edit a bot
  comment and the edit keeps the bot as author).
- `findReviewBase` picks, among trusted, complete states of this kind whose
  head is an ancestor of the current head, the newest by ancestry; comment
  order breaks ties only between states ancestry cannot order. An
  incomplete run is never a base. A git error counts as "not an ancestor".
- `planDesignDocScope` reviews only `since..head` restricted to the PR's
  own files when the base state is design-doc mode, both merge bases are
  valid SHAs, and the base branch changed none of the PR's files between
  the recorded merge base and the current one. Any doubt returns a full
  scope with its reason, and a full scope carries no prior findings.
- Prior findings are assigned to the seat holding their file, else the
  lightest seat. When nothing changed but a BLOCKING prior is open, one
  seat with an empty chunk re-checks the priors.

### 8.3 Verdict

`review/contract/design-doc.md` holds the severity rule and the extra
output fields (`findings[]` with `severity`; `prior[]` with `id`,
`status`, `note`). Aggregate: coverage first; a seat whose body lacks
`findings`, or says FAIL with no finding and no unresolved prior, is
incomplete. Then the gate fails only on a BLOCKING new finding, or a prior
BLOCKING finding not confirmed RESOLVED by its assigned seat. `severityOf`
treats anything other than an explicit `NON-BLOCKING` as BLOCKING.

The severity rule, in brief (the contract file is canonical): BLOCKING for
wrong specified behavior, security, privacy or data integrity defects, a
check that cannot fail, a violation of a binding standard, a false claim an
implementer would rely on, or a self-contradiction an implementer would
follow; NON-BLOCKING for stale pointers, counts nothing depends on,
wording, provenance text. A finding fitting neither list is BLOCKING.

"Binding standard" in the rule means the repository's CLAUDE.md files and
any standards they name, so the contract needs no per-repo key for it.

### 8.4 Round count and the mining trigger

Aggregate counts trusted complete design-doc states of either kind on the
PR. When the count exceeds 3, the comment adds one line suggesting a design
mining pass (18.5). The threshold is the owner's "design PR > ~3 rounds",
fixed at "more than 3 complete review runs"; it is a constant in
`aggregate.mjs`, not config, since it only prints a hint.

---

## 9. Hunt lists

### 9.1 Where they live

| List | Location | Ids | Owner |
|---|---|---|---|
| Shared design shapes (20 generic) | plugin `review/hunt-lists/design-shared.md` | `D1`..`D20` | ship-kit |
| Adversarial METHOD + shared code shapes | plugin `review/hunt-lists/code-shared.md` | `S1`.. | ship-kit |
| Repo design shapes | repo `review.huntLists.design` | `RD1`.. | adopting repo |
| Repo code shapes | repo `review.huntLists.code` | `R1`.. | adopting repo |

Separate id prefixes mean promoting a shape to the shared list never
renumbers a repo's list, and citations stay valid (18.4).

Each list uses the format in `skills/mining-defect-shapes/hunt-list-format.md`:
per shape, an id, a noun-phrase name, a tag `[generic]` or `[repo]`, one
sentence of mechanism, labelled instances, "Look for:" tells, and "Not an
instance:" exclusions.

### 9.2 How CI reads them

The plan job materializes `.pr-review/hunt/`:

- `design-shared.md` and `code-shared.md` from `.ship-kit-src` (the pinned
  release, 7.1);
- `repo-code.md` and `repo-design.md` with
  `git show "$BASE_SHA:<path from base config>"`, never from the PR head.
  A path absent at the base is a notice in the summary, not an error.

The adversarial seat reads the code lists in every mode and the design
lists too in design-doc mode. The general seat reads none: it is tuned for
precision and a hunt list would pull it toward recall. A PR that edits a
hunt list is reviewed with the list as it was at its base, and the edit
takes effect after merge.

### 9.3 Bootstrap

Setup writes both repo files as seeds containing only their header and
format pointer. A fresh repo therefore hunts the 20 shared design shapes
and the shared METHOD with zero repo-specific code shapes, which is the
owner's bootstrap (R8). The shared code list ships with its METHOD and no
shapes; shapes enter it only by promotion (18.6).

The METHOD section, in brief (the file is canonical): verify every finding
against the repository before reporting; hold the seat's own claims about
dependencies to the pinned version, and say UNVERIFIED when it cannot be
checked; treat a justification comment as a condition to check, not a
settlement; report under the closest shape with a note rather than
withhold; report each defect once, with a concrete failure scenario; say
plainly when nothing is found.

---

## 10. Seats and shadow-then-promote

### 10.1 Seats

| Seat | Skill | Reads | Release |
|---|---|---|---|
| general | `reviewing-for-correctness` | chunk, PR text, CLAUDE.md and the standards it names | 2 |
| adversarial | `hunting-defect-shapes` | chunk, whole repo checkout, hunt lists | 2 |
| security | `reviewing-security` | chunk, repo, credentials/authorization/exposure checklist | 5 |
| test-integrity | `reviewing-test-integrity` | chunk, repo, tests-that-cannot-fail checklist | 5 |

Each seat skill is under 500 words (CLAUDE.md, Skills) and consists of the
seat's stance, what to read, and pointers to `.pr-review/contract/` and
`.pr-review/hunt/`. The test-integrity checklist covers a test that cannot
fail, an assertion restating the preceding action, a loosened shared
fixture, a bug fix without a regression test, duplicated test setup, and a
PR claim no test exercises. The security checklist covers credentials
reachable beyond their consumer, trust keyed on caller-settable values,
authorization reimplemented away from its source of truth, and secrets in
URLs or logs.

### 10.2 Modes

`review.seats.<seat>.mode` in the base config is `required` or `shadow`;
the plan job emits `enforced` from it (strict defaults, 5.3, make it
`true`). The caller's gate passes a shadow seat whatever its status (6.5).
Setup installs general `required` and every other seat `shadow`.

### 10.3 Promotion

`/ship-kit:promoting-shadow-checks <seat>` runs
`scripts/promote/shadow-record.mjs`, which reads the seat's trusted state
markers on merged PRs, newest first, and counts consecutive PRs where the
seat ran complete and the PR does not carry
`review.promotion.falsePositiveLabel`. The maintainer adds that label when
judging a shadow finding false; the judgment stays human, the record
stays mechanical. At `review.promotion.cleanRuns` (default 5, the owner's
bar) the skill proposes a one-line config change to `required` as a PR.
The same skill promotes the coverage gate (12.4).

---

## 11. Finding contract, rebuttal and override

### 11.1 Finding to test

Every BLOCKING finding carries a `failure_scenario`: specific inputs or
state producing a specific wrong result (6.4). A finding with no scenario
cannot be refuted by a test, so the contract makes vagueness the seat's
defect. It resolves exactly one way:

- **Confirmed**: the fix plus a test that fails without the fix.
- **Refuted**: no fix; a test that exercises the stated scenario and
  passes.
- **Accepted**: an override (11.3).

`skills/resolving-review-findings/SKILL.md` teaches this, and that the fix
lands in the same PR, never a follow-up. Seats judge in prose whether an
accompanying test is real; mechanical red/green replay is out of scope
(R9).

### 11.2 Rebuttal

A comment starting `/rebut <finding ref>: <reason>` from a user with at
least `review.override.minPermission` is collected by the plan job into
`.pr-review/rebuttals.json`, labelled untrusted data (20.2). Seats read it
as a claim to check and say whether it changes their verdict. A rebuttal
takes effect on the next run: a re-run of the failed workflow run (by the
author, or by `/ship-kit:ci-watch`). There is no `issue_comment` trigger,
because a run from that event attaches its check to the default branch,
not the PR head (F4), so it could never satisfy the required check.

### 11.3 Override

Valid when, at plan time, all hold:

- the PR carries `review.override.label` (read live through the API, not
  from the frozen event payload, since a re-run replays the original
  payload);
- a comment matches `^/override <seat> <sha>: <reason>$`, where `<sha>` is
  at least 7 hex characters and a prefix of the current head, and
  `<reason>` is non-empty;
- the comment is unedited (`created_at == updated_at`) and its author has
  at least `minPermission`.

Binding the override to a head SHA means a later push needs a new
override, so an override cannot silently cover code written after it. The
plan emits `override=true`, seats are skipped, aggregate posts
"overridden by <login> for <sha>: <reason>" and sets `status=override`.
`scripts/review/override.mjs` holds the parser and predicate;
`tests/review/override.test.mjs` covers each condition failing alone.

---

## 12. Patch-coverage gate

### 12.1 Measure

`scripts/coverage/patch-coverage.mjs`:

- Changed lines: added or modified lines on the head side of
  `git diff -U0 --no-renames base...head`, restricted to
  `coverage.include` minus `coverage.exclude`.
- LCOV from all shards is merged per file, a line's hit count being the
  maximum across shards.
- A changed line in a file present in LCOV is coverable if the file lists
  it (`DA:`); covered if its hit count is positive. Unlisted lines are not
  coverable.
- **A changed, included file absent from LCOV counts every changed line as
  uncovered.** A file with no tests produces no LCOV entry at all, and
  scoring it as covered or skipping it is a false pass.
  `tests/coverage/patch-coverage.test.mjs` pins this case by name.
- Patch coverage = covered / (covered + uncovered). With no coverable lines
  the result is `n/a` and passes.

LCOV is the only input format; the repo's tool must emit it (most
ecosystems' coverage tools can).

### 12.2 Wiring

The repo's own test job produces LCOV, since test toolchains are
repo-specific, and uploads it as artifacts matching a pattern. Setup
inserts a managed block (19.2) at the end of the named test workflow's
`jobs:`:

```yaml
  # ship-kit-managed-begin <<stamp_json>>
  patch-coverage:
    needs: [<<test_jobs>>]
    if: always()
    permissions:
      contents: read
      pull-requests: write
    uses: dacrowlah/ship-kit/.github/workflows/patch-coverage.yml@<<ship_kit_sha>> # ship-kit--v<<ship_kit_version>>
    with:
      lcov_artifact_pattern: '<<lcov_pattern>>'
      runners: '<<runners_json>>'
  patch-coverage-gate:
    name: <<check_name>>
    needs: [patch-coverage]
    if: always()
    runs-on: <<gate_runner_json>>
    steps:
      - name: Require patch coverage to have run and passed
        env:
          ALL_SUCCEEDED: ${{ !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') && !contains(needs.*.result, 'skipped') }}
          STATUS: ${{ needs.patch-coverage.outputs.status }}
          ENFORCED: ${{ needs.patch-coverage.outputs.enforced }}
        run: <<gate_script>>
  # ship-kit-managed-end
```

`<<gate_script>>` is the same script as 6.5, rendered from one template
fragment `templates/blocks/gate-step.sh` so the two gates cannot drift.

### 12.3 `patch-coverage.yml` API

| Kind | Name | Type | Meaning |
|---|---|---|---|
| input | `lcov_artifact_pattern` | string, required | artifacts to download and merge |
| input | `runners` | string (JSON), required | `{"plan":[...]}` |
| input | `config_path` | string, default `.ship-kit/config.json` | base config location |
| output | `status` | string | `pass`, `fail-threshold`, `fail-missing`, `fail-config` |
| output | `enforced` | string | `true` when `coverage.mode` is `required` and a threshold exists |
| output | `percent` | string | the measured value or `n/a` |

No artifact matching the pattern is `fail-missing`. The job posts a
summary comment carrying a state line
`<!-- ship-kit-coverage-state <base64url JSON> -->` with
`{v, head, covered, uncovered, percent}`, trusted under the same rule as
8.2.

### 12.4 Baseline and promotion

The coverage gate installs in shadow with `threshold: null`.
`/ship-kit:measuring-coverage-baseline` runs `scripts/coverage/baseline.mjs`:
take the trusted coverage states on the last 20 merged PRs whose value is
not `n/a`; the threshold is the 20th percentile by nearest rank (the value
at position `ceil(0.2 * n)` in ascending order), floored to a whole
percent. With fewer than 20 such PRs it reports how many exist and
proposes nothing. The skill proposes a config PR setting `threshold`,
recording `baseline: {prs: [...], percentile: 20, computed: <date>}`, and
`mode: "required"`. The percentile model means about four in five recent
PRs would have passed, so the gate starts at the repo's demonstrated
practice rather than an invented number.

---

## 13. Preflight, receipt and hook guards

### 13.1 Runner

`.ship-kit/preflight.mjs` (managed file, inlined because the git hook and
contributors without the plugin must run it):

- `node .ship-kit/preflight.mjs [--fast]` runs `preflight.steps` in order,
  `--fast` selecting only `tier: "fast"` steps, stopping at the first
  failure. Steps are argv arrays run without a shell.
- A step's `requires` names prerequisites; each prerequisite's command runs
  first, and a failing prerequisite **fails** the run. No tier is ever
  skipped, because a skipped tier reporting success is a false pass.
- On success with a clean tree (no staged, unstaged or untracked
  non-ignored changes), it records a receipt. `--fast` runs record a
  receipt with `tier: "fast"`.

Node 22 or later is a prerequisite of adopting ship-kit; setup checks it.

### 13.2 Receipt

At `$(git rev-parse --git-path ship-kit/preflight-receipts.json)`, so each
worktree has its own and nothing lands in the tree:

```json
{ "v": 1, "receipts": [ { "commit": "<40 hex>", "tree": "<40 hex>", "tier": "full",
  "configHash": "<sha256 of the canonical JSON of the preflight section>",
  "steps": [ { "name": "unit", "ok": true, "ms": 5123 } ], "at": "<ISO time>" } ] }
```

The newest 20 receipts are kept. The receipt is keyed to the commit, not a
time, so "I ran it earlier" cannot stand in for this commit.

### 13.3 Pre-push verification

`.githooks/pre-push` (managed file) is
`exec node .ship-kit/preflight.mjs verify-push "$@"`. For each stdin line
whose remote ref is under `refs/heads/` and whose local SHA is not all
zeros, it requires a receipt with `commit` equal to that SHA, a `tier` at
least `preflight.prePushTier` (`full` satisfies `fast`), and a
`configHash` equal to the current preflight section's. Otherwise it
refuses the push and prints the one command to run.
`tests/preflight/verify-push.test.mjs` covers each condition failing alone.

### 13.4 Installation and limits

Setup sets `git config core.hooksPath .githooks` only when `core.hooksPath`
is unset; when it is set to anything else it changes nothing and prints the
line to add to the existing hook. The CLAUDE.md template (19.6) carries the
bootstrap command for other contributors. `git push --no-verify` bypasses
the hook for a human; preflight is a latency optimization backed by CI,
never a replacement for it.

### 13.5 The `--no-verify` guard for agent sessions

`hooks/hooks.json`:

```json
{
  "description": "Blocks git commit/push with --no-verify (or git commit -n) in Claude Code sessions so agents cannot skip the repository's git hooks.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "if": "Bash(*--no-verify*)", "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/deny-hook-bypass.mjs"], "timeout": 5 },
          { "type": "command", "if": "Bash(git commit *)", "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/deny-hook-bypass.mjs"], "timeout": 5 }
        ]
      }
    ]
  }
}
```

Scoped with `if` rules and exec form (CLAUDE.md, Hooks and scripts; F9).
The script reads the tool input, tokenizes the command, and for each `git`
invocation whose subcommand is `commit`, `push`, `merge`, `cherry-pick`,
`revert` or `am` with `--no-verify`, or `commit` with a short-flag cluster
containing `n`, prints a PreToolUse deny with the reason and exits 0; for
anything else it prints nothing and exits 0. `git push -n` is a dry run and
is allowed. It never blocks by `exit 2` (CLAUDE.md, Hooks and scripts:
exit 0 plus JSON decision). Whether the first rule's leading wildcard
catches compound commands is F10; PR 3.2 records the live result. If it
does not, the README states that the guard covers commands that begin
with `git`, and the rule is not widened to fire on every Bash call
(CLAUDE.md, Hooks and scripts); the pre-push receipt check and CI remain
the backstop.

---

## 14. `/ship-kit:develop` and the change classifier

### 14.1 Classifier

`node ${CLAUDE_PLUGIN_ROOT}/scripts/classify/classify.mjs --base <ref>`
prints one JSON line `{class, files, hubFiles}` and exits 0:

- `trivial` when every changed file matches `classify.trivial`;
- `hub` when any changed file matches `classify.hub`;
- `standard` otherwise.

`hub` wins over `trivial` if a file matches both. The same script runs in
CI (14.4), so local routing and CI enforcement cannot disagree.

### 14.2 Routing

`/ship-kit:develop` (model-invocable, no side effects) runs the classifier
against the merge base and routes:

- `trivial`: make the change, then `/ship-kit:ship`.
- `standard`: superpowers brainstorming, then TDD, then `/ship-kit:ship`.
- `hub`: brainstorming, a design doc under a spec dir, a plan under a plan
  dir (`planning-deployable-pr-sequences`), each merged through design-doc
  review, then per-task implementation with TDD, then `/ship-kit:ship`.

It also checks `core.hooksPath` and the installed plugin version against
`config.shipKit.version` and reports a mismatch.

### 14.3 Superpowers dependency

ship-kit names superpowers skills as `**REQUIRED SUB-SKILL:** Use
superpowers:<name>` (CLAUDE.md, Skills). Invocation across plugins is not a
documented contract (F14): if the named skill is unavailable, the routing
step says so and continues with ship-kit's own steps rather than stalling.
The dependency stays unversioned until ship-kit has shipped against a
second superpowers minor version, then gains an explicit range (CLAUDE.md,
Versioning and releases).

### 14.4 Change-class check

Optional (`render.changeClassCheck`). `change-class.yml` (inputs `runners`,
`config_path`; outputs `status`, `class`, `enforced`) runs the classifier
on the base config. For `hub`, the PR body must name a path under a spec
dir and, when `hubRequires` includes `plan`, a path under a plan dir, each
existing at the base commit (a merged design and plan). The caller
triggers on `edited` as well, since the PR body is the input; the
workflow is cheap, so re-running on edits costs little. It installs in
shadow and promotes like a seat (10.3).

---

## 15. `/ship-kit:ship`

### 15.1 Contract

Converge deterministic checks and every enabled seat **jointly**, then
commit once, run full preflight on the commit, and push. It never amends
(CLAUDE.md, Repo rules) and never accumulates "address review" commits:
fixes stay in the working tree until convergence, then land in one commit
whose message is written once.

### 15.2 Loop

With `N = ship.maxIterations`:

1. Refuse on the default branch.
2. For `i = 1..N`:
   1. `node .ship-kit/preflight.mjs --fast`; on failure, fix and restart
      the iteration.
   2. Snapshot the working tree: `T = tree id` via a temporary index
      (`GIT_INDEX_FILE=<tmp> git add -A && git write-tree`), then
      `C = git commit-tree T -p HEAD -m snapshot` (an unreferenced object;
      no branch moves).
   3. Run every enabled seat locally against `merge-base..C` (15.3).
   4. Converged when the aggregate status is `pass` and the tree id is
      still `T`. Otherwise fix the findings and continue.
3. Not converged after `N`: stop, report the open findings and what
   changed, do not commit, do not push.
4. Cold pass: a fresh adversarial run (and test-integrity when enabled)
   over the final tree with no priors and no memory of the loop. A finding
   re-enters step 2.
5. `git add` the changed files by name, commit once, run
   `node .ship-kit/preflight.mjs` (full) on the clean tree, push. The
   pre-push hook verifies the receipt (13.3).

The joint loop exists because running reviewers, then fixing, then
testing leaves the last fix unreviewed; convergence is "clean and stable",
not "all PASS once".

### 15.3 Local seats

`scripts/review/local-seats.mjs --base <merge-base> --head <C>` runs
`plan.mjs --local` into `$(git rev-parse --git-path ship-kit/review)` (no
PR comments, no priors, full scope), then for each enabled seat and chunk
spawns in parallel:

```
claude -p "/ship-kit:<seat skill> <review dir>" \
  --allowedTools "Read,Grep,Glob,TodoWrite" \
  --max-turns <review.maxTurns> --json-schema '<schema>' --output-format json
```

It writes receipts in the CI format and runs `aggregate.mjs --local`. The
seats are the same skills, contract and hunt lists CI uses; the base
config and repo hunt lists come from the merge base, as in CI. Each run is
a separate process, so the cold pass is cold by construction. F13 is
settled for `claude -p` in PR 3.4.

---

## 16. `/ship-kit:ci-watch`, watchers and merge

### 16.1 `/ship-kit:ci-watch <pr>`

After push, up to `ciWatch.maxIterations`:

1. Wait with `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh <pr>`
   (under the Monitor tool when available).
2. All green: report; in design-doc mode with NON-BLOCKING findings open,
   fold them once in one commit, confirm with one round, and stop (17.1).
3. Otherwise collect failed job logs (`gh run view --log-failed`) and the
   aggregate comments' findings, fix locally, run
   `node .ship-kit/preflight.mjs --fast`, commit the fix as its own commit
   (once pushed, history is not rewritten), run full preflight, push,
   re-arm.
4. Exhausted: stop, report, leave the PR red.

Guards against optimizing for a silenced reviewer: the cap; CI seats read
each round cold; every round is a visible pushed commit; the engineer can
stop the session. It never merges and never overrides.

### 16.2 Watchers

`watch-pr-checks.sh <pr> [poll] [max-empty]` emits exactly one summary line
when no check is pending, plus one `FAILED: <name>` per failure, and exits
1 with an alarm when no checks appear within the window (a conflicting PR
or a dead trigger, F4): silence is never reported as success.
`watch-merge-deploy.sh <full-sha> [poll] [max-empty]` requires the full
40-character SHA and exits 2 otherwise, because `gh run list --commit`
silently matches nothing for a short SHA. `skills/watching-pr-checks`
describes both.

### 16.3 Required checks only

The watcher reports every check; `/ship-kit:ci-watch` and
`/ship-kit:merge` decide on the required contexts read from
`gh api repos/<r>/branches/<default>/protection`.

### 16.4 `/ship-kit:merge <pr>`

User-invoked (dmi). It verifies every required context is green on the
current head, then merges with `merge.method`. When `merge.adminRitual` is
true (a repo whose protection requires approvals a solo maintainer cannot
give), `scripts/merge/admin-merge.sh` lifts `enforce_admins`, merges with
`--admin`, restores `enforce_admins` in an `EXIT` trap so a failed merge
still restores it, and reads the setting back, failing loudly unless it is
true. It then arms `watch-merge-deploy.sh` with the merge commit's full SHA.

---

## 17. Practice skills

### 17.1 `reviewing-design-documents`

Owns the design method, in the order: gather rulings before drafting;
draft to the document shape (mechanism sections canonical, rulings in the
owner's words with pointer and test, no history, transcribable content as
executable text, derived numbers with their model, each test specified
once, toolchain facts cited to the pinned artifact, repository facts to
file and line); set the review budget out loud (dual review every tier;
drafter does the first pass only; after PASS/PASS fold once, one scoped
confirmation round, remaining NON-BLOCKING findings become notes on plan
tasks; a second instance of a defect class means redesign); the pattern
method for stalled rounds in `pattern-method.md`; when to stop. It points
at `review/hunt-lists/design-shared.md` through `${CLAUDE_PLUGIN_ROOT}`.

### 17.2 `planning-deployable-pr-sequences`

A plan is a sequence of PRs, each with its own review and CI, each stating
why it is safe to deploy alone (additive before use, new behavior dark
until switched, no dependency on a later PR); independent tasks shown as
parallel waves; a model tier per task, lowest that fits (mechanical edits
to the smallest tier, standard code to the middle, design-heavy work to
the top); the plan's own review fixes blockers only.

### 17.3 `proving-tests-can-fail`

For a test that claims to guard a behavior: name the one production line
whose reversal must turn it red, apply that mutation from a scratch copy,
watch it fail, restore from the scratch copy (never `git checkout`, which
would also discard real work). Discipline skill: prohibition plus
rationalization table plus red flags (CLAUDE.md, Skills).

### 17.4 `resolving-review-findings`

11.1's three outcomes; fix in the same PR; a justification is a checkable
claim; rebut with a test rather than argument.

---

## 18. Mining defect shapes

`skills/mining-defect-shapes/SKILL.md`, one method, two targets.

### 18.1 Targets

| Target | Evidence | Writes to |
|---|---|---|
| CODE | merged PRs, commit subjects, review comments (issue, inline, review bodies) | repo `review.huntLists.code` |
| DESIGN | design-doc PRs' trusted state markers (structured findings with severity and RESOLVED/UNRESOLVED dispositions) and their review comments | repo `review.huntLists.design` |

`scripts/mining/collect.mjs --target code|design --since <date>` writes the
evidence to the session scratchpad, decoding state markers with
`review-mode.mjs`. It paginates every API call, stops on the first failed
call (a rate-limit 403 must not leave a silent gap), and prints a
reconciliation: PRs listed versus PRs with at least one aggregate comment,
and a warning when the PR count equals the list limit (truncation).

### 18.2 Method

1. **Window**: from the last commit that changed the target list's shapes
   (not a METHOD-only edit) to now.
2. **Pass one**: PR bodies and commit subjects. One line per described
   defect: PR, one sentence, mechanism, existing shape id or NEW.
3. **A mutation is not an incident.** A deliberate break described in a
   review section is evidence about the tests, not about shipped code;
   record what its survival said about the suite.
4. **Name the commits.** For each instance, the commit where the defective
   state existed and the commit that fixed it (`git log --all -S
   '<literal>'` settles existence). No commit ever contained it: drop it.
   Label each kept instance "Reached main" or "Caught in review"; one fixed
   before any review saw it is dropped, since the list records what gets
   past reviewers. Under squash merges, ancestry says no for every branch
   commit; read the tree at the merge commit instead.
5. **Pass two**: review comments, which carry shapes reviewers caught and
   reviewers' own false positives. False positives feed METHOD, not
   shapes.
6. **Cluster by mechanism**, not by where a defect surfaced.
7. **Amend before add.** An existing shape's mechanism covers the cluster:
   add labelled instances and any new tell, and re-read the shape's text.
   A new shape needs a mechanism no shape covers and at least two
   instances; a singleton is listed as left out. Reviewer-side mistakes
   become METHOD sentences.
8. **Tag** each new shape `[generic]` (the mechanism names nothing specific
   to this repo) or `[repo]`.

DESIGN-target specifics: an instance is a BLOCKING finding in a design
PR's markers; "recurring after fix" means a finding of the same shape
appears in a later round of the same PR after an earlier instance was
marked RESOLVED, or appears in two or more design PRs. Those are the
clusters worth a shape.

### 18.3 Writing the change

Never renumber or re-title a shape (ids are cited from tests and other
lists); ASCII only; no ticket numbers, PR numbers or review labels in list
text; describe incidents in the repo's own words. The change is a PR to the
adopting repo; because seats read lists from the base (9.2), the PR is
reviewed by the list it replaces and takes effect after merge.

### 18.4 Id stability

Repo ids (`R`, `RD`) and shared ids (`S`, `D`) never collide (9.1).

### 18.5 Triggers

- A shipped defect, or a BLOCKING design finding, that fits no shape.
- A design PR with more than 3 complete review runs (8.4 prints the hint).
- On request.

### 18.6 Promotion to the shared list

A `[generic]` shape mined independently in two or more adopting repos is
proposed to ship-kit as a PR adding it to the shared list, written as
mechanism, tells and exclusions only, with no instance text from any repo
(CLAUDE.md, Repo rules: everything generic). After it ships, each repo's
next mining pass replaces its local copy with a pointer to the shared id,
so the fact has one site.

---

## 19. `/ship-kit:setup`: install, update, drift

### 19.1 Structure

The skill is thin (dmi, side effects): it gathers answers with the user
and calls `node ${CLAUDE_PLUGIN_ROOT}/scripts/setup/cli.mjs <verb>
--answers <file>`, which does all deterministic work and is testable
without a model (21.3). Verbs: `detect`, `plan`, `write`, `check`.

### 19.2 Managed files, blocks and stamps

A managed file's first line (second after a shebang) is
`ship-kit-managed: {"template":"<name>","version":"<x.y.z>","sha":"<40 hex>","body":"<sha256>"}`
in the file's comment syntax; `body` is the SHA-256 of everything after
that line. A managed block is delimited by
`ship-kit-managed-begin <stamp>` and `ship-kit-managed-end` lines, `body`
covering the lines between. The config carries `shipKit.version` and
`shipKit.sha` and no body hash, since it is user data.

### 19.3 Install

1. **Preconditions**: a git repo with a clean tree, `gh` authenticated,
   Node 22 or later, not on the default branch (setup creates
   `ship-kit/setup` otherwise).
2. **Detect**: lockfiles and manifests (to propose preflight steps and a
   coverage tool), existing workflow `runs-on` labels, existing secret
   names (`gh secret list`, names only), `core.hooksPath`, current
   required checks, whether `.claude/` is ignored (`git check-ignore`).
3. **Ask** for every config key the detection could not settle (5.1's
   per-repo list).
4. **Render** everything into a staging dir under the git dir: config,
   callers, preflight, pre-push, seed hunt lists, CLAUDE.md block, coverage
   block, `.claude/settings.json` merge, `.gitignore` negations.
5. **Show a diff** of every file against the working tree; write only on
   approval.
6. **Validate**: config against the schema; the rendered YAML with
   `actionlint` when present.
7. **Print the manual steps**, and offer each as a separately approved
   action: add the auth secret; create the override and false-positive
   labels; add the required contexts to branch protection; add CODEOWNERS
   lines for `.github/workflows/ship-kit-*.yml` and `.ship-kit/` (20.1).

Setup never commits or pushes.

### 19.4 Local plugin pinning

`.claude/settings.json` gains, merged with existing keys:

```json
{
  "extraKnownMarketplaces": {
    "ship-kit": { "source": { "source": "github", "repo": "dacrowlah/ship-kit", "ref": "ship-kit--v0.2.0" } }
  },
  "enabledPlugins": { "ship-kit@ship-kit": true }
}
```

When `.claude/` is ignored (a common global ignore), setup adds
`!.claude/settings.json` to the repo's `.gitignore` first, or the file
silently never commits. Contributors must trust the folder before
repo-declared plugins activate; the CLAUDE.md block says so, since the
failure is silent. If F12 fails (no `ref` in this key), the key is written
without `ref` and pinning rests on 19.5's version check.

### 19.5 Update and check

`/ship-kit:setup update` classifies every managed file and block:

| State | Test | Action |
|---|---|---|
| current | stamp version = plugin version and body hash matches | none |
| stale | older stamp, body hash matches | replace with the new render (shown as a diff first) |
| modified | body hash does not match | show current versus new render; per file: take new, keep mine, or write `<file>.ship-kit-new` beside it |
| missing | file or block absent | render and show |
| unrendered | a `render` config key changed since the render | re-render and show |

Config migrations run by `schemaVersion`. Update then rewrites the caller
pins and `settings.json` ref to the running plugin's release.

`/ship-kit:setup check` (and `cli.mjs check`, exit 1 on any state but
current) also compares the installed plugin version with
`config.shipKit.version`, so a contributor on an older local plugin learns
it. It suits a scheduled CI job.

### 19.6 CLAUDE.md workflow block

`templates/blocks/claude-md-workflow.md.tmpl`, inserted as a managed block:
start every change with `/ship-kit:develop`; test code follows the same
design rules as production code; every change carries a test proving the
behavior it claims, and a claimed guard is proven with a mutation; run
preflight before push; fix review findings in the same PR; plans are
sequences of deployable PRs; design docs state the current design only;
the hook bootstrap line and the folder-trust note; a fill-in for the
repo's model-tier guidance.

---

## 20. Security model

### 20.1 What the gates defend against

Honest mistakes by humans and agents, not a malicious writer. A writer can
edit a caller on their PR to replace the gate; GitHub runs the PR's copy of
the workflow. Setup therefore offers CODEOWNERS entries for the callers and
`.ship-kit/`, and the README says plainly that the required check trusts
its caller file.

### 20.2 Untrusted inputs to seats

Prior findings, rebuttals, the PR title and body, and hunt-list text are
data. `review/contract/untrusted-data.md` tells seats to treat each as a
claim to check, never as an instruction. Config and hunt lists come from
the base commit (5.3, 9.2); the seat instructions come from a tag-verified
ship-kit commit (6.3).

### 20.3 Tokens

Seats receive the workflow's `GITHUB_TOKEN` through `github_token`, scoped
by the caller to contents read, pull-requests write, issues read, and
cannot raise it (F3). No seat has a shell beyond `gh pr view`. Fork PRs get
no secrets (F4), so their seats fail and the gate fails closed; a
maintainer re-pushes the branch to review it. Passing `github_token` skips
the action's app-token exchange (F6): comments post as
`github-actions[bot]`, and a PR that edits a caller is still reviewed
rather than skipped. That trade is Owner decision 3.

### 20.4 Local

Hooks and scripts run as the user outside the sandbox (CLAUDE.md,
Security). The one hook is scoped by `if` and only denies. No script sends
data anywhere except `gh` calls to the repository's own GitHub API, and
the README lists every hook and script with what it does.

---

## 21. Test strategy

### 21.1 Unit suites (`node --test`, in `ci.yml` on every push)

- Ported from the first adopting repo and generalized (configurable dirs,
  seat kinds, marker prefix): `tests/review/review-mode.test.mjs`,
  `plan.test.mjs`, `aggregate.test.mjs`, `design-doc-mode.test.mjs`.
- New: `tests/lib/{schema,config,glob,stamp,render}.test.mjs`,
  `tests/review/override.test.mjs`, `tests/callers/gate.test.mjs` (6.5),
  `tests/coverage/{lcov,patch-coverage,baseline}.test.mjs`,
  `tests/classify/*.test.mjs`, `tests/preflight/*.test.mjs` (importing
  `templates/files/preflight.mjs`), `tests/hooks/deny-hook-bypass.test.mjs`,
  `tests/watch/*.test.mjs` (the shell watchers run against a fake `gh` on
  `PATH`), `tests/setup/*.test.mjs`, `tests/promote/*.test.mjs`.
- Every test named for a guard is proven able to fail: its PR description
  names the mutation applied and the red run (`proving-tests-can-fail`).

### 21.2 Plugin validation (`ci.yml`)

- `claude plugin validate --strict .`
- `claude --plugin-dir . plugin details ship-kit`, compared by
  `tests/inventory.test.mjs` against `tests/expected-inventory.txt` (no
  `bin/`, no unexpected hook).
- `actionlint` over `.github/workflows/` and every rendered caller from
  21.3's fixtures.
- An ASCII gate: any byte outside printable ASCII, tab or newline in a
  tracked text file fails (`tests/ascii.test.mjs`).
- A skill-size gate: each SKILL.md under 500 lines; each model-invocable
  skill description plus `when_to_use` under 1,536 characters.

### 21.3 Setup fixture

`tests/fixtures/repo/` is materialized into a temp git repo per test.
`cli.mjs` runs with `--answers tests/fixtures/answers.json`. Cases: fresh
install writes exactly the expected tree; a second run is a no-op; editing
a managed file reports `modified`; bumping the template version reports
`stale` and replaces cleanly; a preset `core.hooksPath` is left alone; an
ignored `.claude/` gains the negation; an invalid answer is refused before
any write; the rendered callers pass `actionlint`.

### 21.4 Live workflow dogfood

ship-kit's own repo runs its general and adversarial callers:

- The required ones call `review.yml` at the **latest release SHA**, so a
  PR cannot weaken the review of itself.
- A canary job calls `./.github/workflows/review.yml` from the PR head,
  non-required, with `allowUntaggedShipKit` set in ship-kit's own config;
  it proves a changed workflow runs end to end before release. This run
  settles F13 and F15.

Before a release that changes a reusable workflow, the owner also runs it
from a scratch adopting repo under a different owner account, which
exercises explicit secrets (F2) and cross-repo `uses:` (Owner decision 4).

### 21.5 Skill pressure tests

Per CLAUDE.md, Skills. Discipline skills (`proving-tests-can-fail`,
`resolving-review-findings`, `ship`, `ci-watch`,
`reviewing-design-documents`' stop rules, `mining-defect-shapes`' drop
rules) get RED, GREEN, REFACTOR: a subagent scenario combining at least
three pressures with real paths and no escape to a human, run without the
skill (rationalizations recorded verbatim), then with it, loopholes closed.
Output-shaping skills (seat skills, hunt-list format, plan format) get a
positive recipe and an output check instead of prohibitions. Artifacts live
in `tests/skills/<skill>/{scenario,baseline,result}.md`, and a skill change
reruns its scenario in the same PR.

---

## 22. Release plan

Each PR is its own branch, review and CI run, and is safe to merge alone:
nothing is consumed by an adopting repo until a release tag exists, and
adopting repos pin tagged SHAs only (6.3 step 3). Tags are created with
`claude plugin tag --push` after the owner approves (CLAUDE.md,
Versioning and releases). `plugin.json` `version` is bumped in the last PR
of each release. Model tiers: S = smallest, M = middle, L = largest.
While ship-kit is 0.x, a breaking change bumps the minor version.

### 22.1 Release 1 (0.1.0): skeleton, dependency, skills including mining

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 1.1 | `ci.yml` (21.1, 21.2 gates), `scripts/lib/{glob,stamp}.mjs` with tests, README hook/script inventory section, CLAUDE.md: replace the `${CLAUDE_PLUGIN_ROOT}` rule with F8's verified behavior | no user-visible component | M | 1 |
| 1.2 | `reviewing-design-documents` + `pattern-method.md`, `review/hunt-lists/design-shared.md`, `planning-deployable-pr-sequences`, `proving-tests-can-fail`, with pressure tests | skills only, read-only | L | 2 |
| 1.3 | `watching-pr-checks` + `scripts/watch/*` + fake-`gh` tests | read-only scripts | S | 2 |
| 1.4 | `mining-defect-shapes` + `hunt-list-format.md` + `review/hunt-lists/code-shared.md` (METHOD only) + `scripts/mining/collect.mjs` + tests; version 0.1.0 | reads APIs, writes scratch only | L | 3 |

### 22.2 Release 2 (0.2.0): gate, general and adversarial workflows, design-doc mode, setup

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 2.1 | `schemas/config.schema.json`, `scripts/lib/{schema,config}.mjs`, tests | library, no consumer yet | M | 1 |
| 2.2 | `scripts/review/{review-mode,plan,aggregate}.mjs` ported and generalized, suites ported | scripts not yet called by any workflow | M | 2 |
| 2.3 | `reviewing-for-correctness`, `hunting-defect-shapes`, `review/contract/*` | dmi skills, invisible until named | L | 2 |
| 2.4 | `.github/workflows/review.yml`, `templates/callers/review.yml.tmpl`, gate test, ship-kit's dogfood callers (canary only) | untagged; only ship-kit's canary calls it | L | 3 |
| 2.5 | `skills/setup` + `scripts/setup/*` (install, check, update, settings merge, gitignore) + CLAUDE.md block template + fixture tests | writes only after a shown diff | M | 4 |
| 2.6 | `promoting-shadow-checks` + `scripts/promote/shadow-record.mjs`; version 0.2.0 | read-only, proposes a PR | S | 4 |

After the 0.2.0 tag: ship-kit's own required callers move to the 0.2.0 SHA
(one PR), then migration 23 begins.

### 22.3 Release 3 (0.3.0): preflight, `/ship`, `/develop`

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 3.1 | `templates/files/{preflight.mjs,pre-push}`, receipt, verify-push, setup renders them | setup-installed only on update | M | 1 |
| 3.2 | `hooks/hooks.json` + `deny-hook-bypass.mjs` + tests + live-match record (F10) | only denies | S | 1 |
| 3.3 | `classify.mjs` + `/ship-kit:develop` | read-only | M | 1 |
| 3.4 | `local-seats.mjs`, `plan.mjs --local`, `aggregate.mjs --local`, `/ship-kit:ship`, pressure test; version 0.3.0 | user-invoked | L | 2 |

### 22.4 Release 4 (0.4.0): coverage gate

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 4.1 | `lcov.mjs`, `patch-coverage.mjs`, tests incl. the absent-file case | library | M | 1 |
| 4.2 | `patch-coverage.yml`, coverage block template, setup support (shadow) | untagged until release; installs shadow | M | 2 |
| 4.3 | `baseline.mjs`, `measuring-coverage-baseline`, promotion support; version 0.4.0 | proposes a PR | S | 3 |

### 22.5 Release 5 (0.5.0): extra seats, finding contract, override

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 5.1 | full-mode `findings[]` with `failure_scenario` (additive schema; outputs unchanged), `resolving-review-findings` | additive | M | 1 |
| 5.2 | `reviewing-security`, `reviewing-test-integrity`, setup offers their callers in shadow | dmi, shadow | L | 2 |
| 5.3 | `override.mjs`, rebuttals, plan and aggregate support | inert without the label and comment | M | 2 |
| 5.4 | `change-class.yml`, `change-class-check.mjs`, caller template; version 0.5.0 | optional, installs shadow | M | 3 |

### 22.6 Release 6 (1.0.0): `/ci-watch` and merge

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 6.1 | `/ship-kit:ci-watch` + pressure test | user-invoked | L | 1 |
| 6.2 | `/ship-kit:merge` + `admin-merge.sh` + trap test against a fake `gh`; version 1.0.0 | user-invoked | M | 1 |

### 22.7 Why this order

Release 2 is the first an adopting repo installs, and it delivers the
required dual review the owner already runs. Release 3 makes every later
seat runnable locally the day it ships. Coverage comes before extra seats
because it is deterministic and cheaper to trust.

### 22.8 Per-release checklist

CLAUDE.md's pre-release checklist, plus: every UNVERIFIED row in 2 that the
release depends on is settled, and 21.4's cross-owner run passed.

---

## 23. Migrating the adopting repos

### 23.1 The first adopting repo

It runs hand-built general and adversarial workflows with a shared matrix
engine, self-hosted runners behind a boot workflow, its code hunt list
inside the adversarial prompt, and a design hunt list in a repo skill.

| Step | Change (a PR in that repo unless noted) | Exit criterion |
|---|---|---|
| M1 | `/ship-kit:setup` at 0.2.0: config with its runner labels and `bootWorkflow`, its spec and plan dirs, new check names (defaults), both seats `required`; its code shapes moved to `.ship-kit/hunt-lists/code.md` as `R` ids and its design list reduced to repo-only shapes (the 20 generic ones now come from the plugin) | new checks run beside the old; branch protection unchanged |
| M2 | Observe | 5 consecutive PRs where the new gate's verdict matches the old, or differs in a way the owner judges correct |
| M3 | Branch protection (admin action, not a PR): add the new contexts and remove the old in one change | protection reads back with only the new names |
| M4 | Delete the old workflows, their scripts and tests, and its repo copies of the design-review and mining skills | the next PR shows only ship-kit checks |

Mining is frozen from M1 to M4: until M4 the code list exists in two
places, and a pass that edits one would leave the other behind. Old state
markers use a different prefix, so the first design PR after M1 gets a
full review. Side by side doubles review cost for the M2 window only.

### 23.2 A second adopting repo

It has a proposal and a partly retuned general review, with its hunt list
in a design document.

| Step | Change | Exit criterion |
|---|---|---|
| N1 | Setup at 0.2.0 on hosted runners: general `required`, adversarial `shadow`; its hunt list moved into `.ship-kit/hunt-lists/code.md` | new checks run beside its existing review check |
| N2 | Observe, as M2 | 5 consecutive matching PRs |
| N3 | Switch protection, as M3; delete its old review workflow | only ship-kit contexts required |
| N4 | Adopt releases 3 to 6 as they ship, via `/ship-kit:setup update`, each seat and the coverage gate promoted by 10.3 and 12.4 | per release |

Its own proposal's phases map onto ship-kit's releases, so it stops
building any mechanism ship-kit provides.

---

## 24. Self-check

### 24.1 Against the 20 design shapes

| Shape | Check against this document |
|---|---|
| D1 prose-specified executable | Config, caller, gate script, coverage block and hook are given as text; the gate script and config were run (5.1, 6.5). Script behavior is specified as contracts that tests pin (21.1), not as steps to transcribe. |
| D2 derived number without its model | The coverage threshold carries its model (12.4); the round-count hint states its source (8.4); config defaults are marked as carried values with nothing derived from them (5.1). |
| D3 twin left behind | Each fact has one site: platform facts in 2, severity rule in `design-doc.md` (8.3 is marked a brief), gate script in one fragment (12.2), schema in one file (5.2), preflight code in one file (4.5). |
| D4 summary contradicts detail | Section 3's summary cites 5.3, 7 and 15.3 rather than restating them. |
| D5 enumeration at fewer sites | The seat list appears in 6.2 (input values), 10.1, 4.1 and 5.1 (`checks`); all four name the same four seats. Status values in 6.2 match 6.3 and 11.3. |
| D6 vendor page, wrong version | Action behavior is cited to the v1.0.236 source (F5 to F7), not its README. |
| D7 check that cannot fail for its claim | The gate test runs the rendered script (6.5); guard tests are mutation-proven (21.1). |
| D8 repository fact assumed | Facts about the first adopting repo are described generically and were read from its main branch; ship-kit facts cite CLAUDE.md sections. |
| D9 stale provenance | The only provenance claims are "was run" statements in 5.1 and 6.5. |
| D10 test stated three times | Each test is named once, at the mechanism it pins; 1 and 21 point to files. |
| D11 mutation that cannot redden | No mutation is specified with fixture values here; 17.3 and 21.1 require the red run be observed. |
| D12 interface frozen against its dependency | The plugin-load design is fitted to the action's actual URL regex (F5), and the self-pin to F1's context. |
| D13 rulings by accretion | Rulings in 1 are quotes with pointers; consequences live in mechanism sections. |
| D14 fix-round residue | Not applicable to a first draft. |
| D15 unreported stall | Every non-convergence ends in a report: `/ship` (15.2 step 3), `/ci-watch` (16.1 step 4), empty checks (16.2), baseline with too few PRs (12.4). |
| D16 time-order dependence | Overrides bind to a head SHA and read labels live (11.3); rebuttals avoid `issue_comment` (11.2); review base is chosen by ancestry, not comment order (8.2). |
| D17 guard that admits a state | Gate states enumerated and tested (6.5); strict defaults for absent or invalid config (5.3); unknown severity is BLOCKING (8.3). |
| D18 declared cost that is not | Costs stated are only relative (the change-class workflow is cheap; side-by-side doubles review for a bounded window). |
| D19 standard departed silently | Departures from CLAUDE.md are surfaced: the command names (Owner decision 1), the plugin-root rule (PR 1.1). |
| D20 history in the specification | None; no changelog or version narrative. |

### 24.2 Against CLAUDE.md

| Rule (CLAUDE.md section) | Where honored |
|---|---|
| Skills under 500 lines; references one level deep (Skills) | 4.1, 21.2 size gate |
| Always-loaded skills under ~200 words; others under ~500 (Skills) | no skill loads every turn; seat skills 10.1 |
| Descriptions are triggering conditions only (Skills) | 21.2 description gate; authoring rule in each skill PR |
| Gerund names (Skills) | model-invocable skills comply; command skills are Owner decision 1 |
| Cross-reference by name, no `@` links (Skills) | 14.3 |
| Side-effect skills are dmi (Skills) | setup, ship, ci-watch, merge, promotion, baseline (4.1) |
| TDD for discipline skills; recipes for output-shaping (Skills) | 21.5 |
| One excellent example (Skills) | one example per skill |
| Commands are skills (Commands) | 4.1 |
| Namespaced `/ship-kit:<name>` (Commands) | every invocation in this document |
| Hooks scoped with `if`, exec form, exit 0 JSON (Hooks and scripts) | 13.5 |
| No `bin/`; scripts invoked via interpreter (Hooks and scripts) | 4.3 |
| `${CLAUDE_PLUGIN_ROOT}` rule (Hooks and scripts) | superseded by the live doc (F8); amended in PR 1.1 |
| `name` permanent; no dual `version` (Manifests and naming) | `name` unchanged; version only in `plugin.json` (22) |
| Cross-marketplace allowlist kept (Manifests and naming) | F15 |
| Bump version every release; tag `ship-kit--v<version>` (Versioning and releases) | 22 |
| Superpowers range after a second minor (Versioning and releases) | 14.3 |
| Breaking-change list (Versioning and releases) | 5.2, 6.2, 6.6 |
| Thin callers pinned by SHA or tag (Workflow templates) | 6.5, 7.1 |
| Inlined files stamped with an update mode (Workflow templates) | 19.2, 19.5 |
| Secrets as `${{ secrets.NAME }}`, documented in the header (Workflow templates) | 6.5 |
| Hooks documented in the README; no phone-home (Security) | 20.4, PR 1.1 |
| `validate --strict` in CI; `--plugin-dir` details before release (Testing and validation) | 21.2 |
| CI pins `plugin_marketplaces` and `plugins` explicitly (Testing and validation) | 7.2 |
| Everything generic (Repo rules) | 18.6, 23 |
| No changelogs in design docs (Repo rules) | this document |
| Discrete PRs, each safe alone (Repo rules) | 22 |
| No push or tag without approval; stage by name; no amend; no `--no-verify` (Repo rules) | 15.1, 13.5, 22 |
| ASCII only (Repo rules) | 21.2 ASCII gate |

---

## 25. Owner decisions needed

1. **Command names versus the gerund rule.** CLAUDE.md requires gerund
   skill names; the approved scope names `/ship-kit:setup`, and the
   practice uses `ship`, `develop`, `ci-watch`, `merge`. Recommendation:
   amend the rule in PR 1.1 so it applies to model-invocable skills and
   exempts user-invoked commands, keeping the imperative names.
2. **User-only `ship` and `ci-watch`.** CLAUDE.md makes any skill that
   commits or pushes `disable-model-invocation`, so an orchestrating agent
   cannot start `/ship-kit:ship` or `/ship-kit:ci-watch` itself; a human
   types the command. Keep that (the design's default), or amend the rule
   to allow model invocation when the skill's last step is the push.
3. **Seat GitHub identity.** Seats use the workflow's `GITHUB_TOKEN` (20.3):
   PRs that edit a caller are still reviewed and comments post as
   `github-actions[bot]`, but the Claude GitHub App's refusal to run a
   workflow that differs from the default branch no longer applies. The
   alternative keeps the app exchange and accepts that such PRs fail their
   gate and need an admin merge.
4. **A scratch adopting repo under another account** for the cross-owner
   release test (21.4), since only the owner can create it.
