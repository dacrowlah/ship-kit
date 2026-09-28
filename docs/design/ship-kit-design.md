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
| R13 | "Command names: keep setup/ship/develop/ci-watch/merge; the gerund naming rule applies only to model-invoked skills. Include the CLAUDE.md amendment in release 1's first PR." | 4.1, 22.1 | `tests/skills/naming.test.mjs` (gerund check exempts exactly the five command skills) |
| R14 | "Agents MAY commit and push, with a per-repo opt-out: ship and ci-watch are model-invocable (no disable-model-invocation). setup asks one question ("Allow agents to commit and push without asking?"), default yes, stored as one boolean in the ship-kit config ... When false, the skill runs but stops before each commit/push to ask the user, and never pushes when no user can be asked (CI/headless). Enforcement lives in the skill, since disable-model-invocation is static frontmatter. Amend the CLAUDE.md rule on side-effecting skills to "must honour this setting" (release 1 first PR). setup and any release/tag command stay disable-model-invocation." Merge scope is narrowed by R17. | 5.4, 15, 16, 19.3, 22.1 | `tests/lib/agent-policy.test.mjs`; pressure tests for `ship` and `ci-watch` (21.5) |
| R15 | "Review jobs use the workflow GITHUB_TOKEN, not the Claude GitHub App." | 6.3, 20.3 | `tests/workflows/review-yml.test.mjs` (seat step passes `github_token` from `secrets.GITHUB_TOKEN`) |
| R16 | "No cross-account scratch repo for now: remove it from the plan; cross-owner behaviour stays UNVERIFIED with a note naming what would test it later." | 2 (F17), 21.4 | none |
| R17 | "agents.commitAndPush covers commit, push and NORMAL merge only. An agent may merge only via a normal (non-admin) merge, bound to the exact head SHA it verified (--match-head-commit), and only when required checks read from BOTH rulesets and classic protection are all green and the required set is non-empty (empty or unreadable set = refuse)." Amended: "admin merge becomes a SEPARATE opt-in setting (e.g. agents.adminMerge, default false), asked at setup as its own question after the commit/push one, read only from the default branch's config like the other agent setting (missing/unreadable = false) ... When agents.adminMerge is true, an agent may run the admin-merge path, but only: (1) when every required check (from rulesets AND classic protection, non-empty set) is green on the exact head SHA; admin only bypasses the branch-up-to-date/strict requirement, never a failing, pending or missing check; (2) bound to that SHA (--match-head-commit); (3) if the path toggles enforce_admins or a ruleset bypass, it restores it in a finally-style step and verifies the protection afterwards, reporting failure loudly if restore fails; (4) it states in its output that it used admin. When false, agents never use --admin or toggle protection; they report that an admin merge is needed and stop." Further: "Remove the enforce_admins/protection TOGGLE entirely. Admin merge uses a ruleset bypass actor ... so `gh pr merge --admin --match-head-commit <sha>` works without mutating protection." "Admin scope ... bypass ONLY the branch-up-to-date/strict requirement ... never past failing/pending/missing checks, and never past required code-owner review. The same refusal list as normal merge ... applies to admin merges too." The two settings are "a BEHAVIOURAL contract enforced by the skills (plus a best-effort hook as a tripwire, explicitly not a boundary) ... The real boundary is GitHub-side: rulesets, required checks, CODEOWNERS, and which identity holds admin." | 5.1, 5.4, 16.3, 16.4, 19.3, 20.1 | `tests/lib/agent-policy.test.mjs`, `tests/merge/required-checks.test.mjs`, `tests/merge/merge.test.mjs`, `tests/hooks/admin-tripwire.test.mjs` (16.3, 16.4) |

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
| F4 | `issue_comment` runs with `GITHUB_SHA` = last commit on the default branch; a check it creates does not attach to the PR head. `pull_request` runs the PR merge commit's copy of the workflow, does not run while the PR has a merge conflict, and gives fork PRs no secrets and a read-only token. | docs.github.com, events that trigger workflows | Verified |
| F5 | claude-code-action accepts in `plugin_marketplaces` either an `https://...git` URL (regex requires the string to end in `.git`, so a `#ref` suffix is rejected) or a local path starting with `./`, `../` or `/`; `plugins` takes `name@marketplace`. It runs `claude plugin marketplace add` then `claude plugin install`. | claude-code-action v1.0.236, `base-action/src/install-plugins.ts` lines 7-8, 15-23, 30-53 | Verified |
| F6 | When the `github_token` input is set, the action uses it and skips the OIDC-to-app-token exchange. The exchange is where the server refuses a run whose workflow file differs from the default branch. | claude-code-action v1.0.236, `src/github/token.ts` `setupGitHubToken`, `isWorkflowValidationError` | Verified |
| F7 | The action outputs `structured_output` when `--json-schema` is passed in `claude_args`. | claude-code-action v1.0.236, `action.yml` line 183 | Verified |
| F8 | SKILL.md content substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` (plugin skills only) and `${CLAUDE_PROJECT_DIR}`; `disable-model-invocation: true` removes a skill from Claude's context listing and leaves it user-invocable. | code.claude.com/docs/en/skills | Verified; contradicts the current CLAUDE.md rule, see 22.1 PR 1.1 |
| F9 | Hook `if` takes one permission rule (`Bash(git *)`); exec form is `command` + `args`; a PreToolUse deny is `hookSpecificOutput.permissionDecision: "deny"` with a reason; `hooks/hooks.json` has an optional top-level `description`. | code.claude.com/docs/en/hooks | Verified |
| F10 | Whether a leading wildcard in an `if` rule (`Bash(*--no-verify*)`) matches a compound command such as `cd x && git push --no-verify`. | code.claude.com/docs/en/hooks says matching "depends on the shape of the pattern" | UNVERIFIED; settled by `tests/hooks/live-match.md` in PR 3.2 |
| F11 | Plugin sources in `marketplace.json` support `ref` and `sha` pins. | code.claude.com/docs/en/plugin-marketplaces | Verified |
| F12 | `extraKnownMarketplaces` in a repo's `.claude/settings.json` accepts a `github` source with a `ref`. | plugin-facts research note ("Pin via ref/sha") | UNVERIFIED for the settings key; settled by the fixture test in PR 2.5; fallback in 19.4 |
| F13 | A prompt beginning `/ship-kit:<skill>` passed to `claude -p` or to the action's `prompt` input invokes that skill, with no `Skill` tool in the allowlist, including for a skill marked `disable-model-invocation` (the skills page says dmi also blocks prompt invocation from a scheduled task since v2.1.196). | plugin-facts research note; code.claude.com/docs/en/skills | UNVERIFIED; settled by the canary in PR 2.4 (CI) and PR 3.4 (`claude -p`). A later action or CLI bump that breaks it fails closed through `skill_marker` (6.3) |
| F14 | Cross-plugin skill invocation by name (ship-kit naming a superpowers skill) works in practice and is not a documented contract. | ship-kit CLAUDE.md, "Unverified" | UNVERIFIED by design; 14.3 degrades when it fails |
| F15 | Installing ship-kit auto-installs its declared dependency `superpowers` from `claude-plugins-official`, which must be allow-listed in `allowCrossMarketplaceDependenciesOn` (already set). Whether the dependency resolves from a local-path copy of that marketplace named in `plugin_marketplaces` (7.2). | code.claude.com/docs/en/plugins/dependencies | First part verified; second UNVERIFIED, settled by the canary in PR 2.4 |
| F16 | A called workflow "is automatically granted access to `github.token` and `secrets.GITHUB_TOKEN`", with at most the caller's permissions. | docs.github.com, reusing workflow configurations | Verified |
| F17 | End-to-end behaviour of a caller owned by a different account from ship-kit: explicit secrets (F2), cross-owner `uses:` of a public reusable workflow, and `job.workflow_*` (F1) resolving to ship-kit. | docs cover each piece separately | UNVERIFIED. Would be tested by a scratch adopting repo under another account, or by the first run of an adopting repo owned by a different account than ship-kit (the second adopting repo's step N1, 23.2 is one) |
| F18 | `pull_request_target` runs the workflow file from the base repository's default branch, with `GITHUB_SHA` = last commit on the default branch; it gets the base repository's secrets and a read/write-capable `GITHUB_TOKEN`, fork PRs included; it runs even when the PR has a merge conflict; checks created by its jobs are evaluated for the PR and can satisfy a required status check. Safe only while PR content is inspected as data and never executed. | docs.github.com: events that trigger workflows; "Securely using pull_request_target"; "Troubleshooting required status checks" (eligible events list) | Verified |
| F19 | Public repositories get a default Actions event policy that blocks `pull_request_target` (evaluate mode now; enforced on 2026-11-02 for repos on the default policy); an explicit event policy must allow it. `actions/checkout` refuses to check out a fork PR's ref under `pull_request_target` unless `allow-unsafe-pr-checkout` is set. | docs.github.com, "Securely using pull_request_target"; actions/checkout `src/unsafe-pr-checkout-helper.ts` (default branch, 2026-09-28) | Verified |
| F20 | The ruleset rule "Require workflows to pass before merging" is configured only in organization (or enterprise) rulesets, on GitHub Enterprise Cloud and GHES 3.12+. A personal-account repository cannot use it. | docs.github.com, available rules for rulesets; `data/features/repo-rules-required-workflows.yml` | Verified |
| F21 | A required status check is matched by name, optionally restricted to a source app; every workflow job reports under the same GitHub Actions app. "If a check and a commit status have the same name, both must pass." A job skipped by its `if` condition reports success. Which of two same-named check runs on one commit GitHub evaluates is not documented. | docs.github.com, troubleshooting required status checks | First three sentences verified; the last is UNVERIFIED. The forged-check residual (20.1) assumes the worst; re-runs and the reopen route (6.3, 6.5) rely on the newer same-named run deciding, which the private-repo exit check (22.8) observes |
| F22 | claude-code-action loads setting sources `user, project, local` unless `claude_args` carries `--setting-sources`; its `settings` input is merged into `~/.claude/settings.json` (user scope); on PR events it restores `.claude/`, `CLAUDE.md`, `.mcp.json` and similar paths from the PR base before starting; it refuses to run Claude when the event's actor (the sender, not the PR author) lacks write access; it sets `GITHUB_TOKEN` and `GH_TOKEN` in Claude's environment and, in agent mode, writes the token into the workspace's `.git/config` remote URL. `github.actor` is the user whose event started the run; a re-run keeps it (only `github.triggering_actor` changes) and uses its privileges. | docs.github.com contexts reference (`github.actor`); claude-code-action v1.0.236: `base-action/src/parse-sdk-options.ts` 338-344, `base-action/src/setup-claude-code-settings.ts`, `src/github/operations/restore-config.ts`, `src/github/validation/permissions.ts` 33-47, `src/github/operations/git-config.ts` 132-133, `src/entrypoints/run.ts` 189-191, `docs/security.md` | Verified |
| F23 | Claude Code CLI: `--setting-sources` limits loaded sources; `--tools` restricts the built-in tools that exist (not MCP tools); `--permission-mode dontAsk`; `--add-dir`; `--settings` overrides settings files for the session. `disableAllHooks: true` outside managed settings turns off user, project, local and plugin hooks. | code.claude.com/docs/en/cli-reference; settings-reference `disableAllHooks`; settings precedence | Verified for the CLI. That the action passes `--tools`, `--permission-mode`, `--disallowedTools` and `--add-dir` through `claude_args` unchanged is UNVERIFIED; settled by the canary in PR 2.4 |
| F24 | The `claude-plugins-official` marketplace entry for `superpowers` pins its source by `sha`, so a copy of that marketplace at a fixed commit fixes the superpowers commit. superpowers registers a `SessionStart` hook that injects instructions into every session, and `SessionStart` fires under `-p`. | local clone of claude-plugins-official at `fbe07fb6`; superpowers 6.4.1 `hooks/hooks.json` and `session-start`; code.claude.com/docs/en/hooks | Verified |
| F25 | Which definition wins when a CLI-added local marketplace and the working directory's `.claude/settings.json` `extraKnownMarketplaces` both use the name `ship-kit`. | no doc found | UNVERIFIED; settled by the canary in PR 2.4 against the adopter-shaped settings fixture (21.4); a wrong resolution fails closed through `skill_marker` (6.3) |
| F26 | `gh pr merge --admin` only skips gh's own client-side refusal for merge states `BLOCKED` and `BEHIND`; it then calls the same merge mutation, passing `--match-head-commit` as `expectedHeadOid`, and GitHub decides whether the caller may bypass. A branch ruleset's bypass list names actors (including a repository role) with `bypass_mode` `always`, `pull_request` (bypass only when merging a PR; branch rulesets only) or `exempt`; a bypass actor bypasses the rules of that ruleset. Rulesets and classic protection targeting one branch aggregate, and every applicable rule applies. | cli/cli `pkg/cmd/pr/merge/merge.go` at v2.101.0 (`blockedReason`, `expectedHeadOid`); REST description schema `repository-ruleset-bypass-actor`; docs.github.com creating rulesets (bypass, "For pull requests only") and about rulesets (rule layering) | Verified |
| F27 | `GET /repos/{o}/{r}/collaborators/{user}/permission` returns the user's base permission and is enabled for GitHub App tokens. Which job-token permission it needs, and its answer for a private repo, are not stated. | REST description (`x-github.enabledForGitHubApps: true`) | First sentence verified; the rest UNVERIFIED, settled by the canary and the private-repo exit check (22.8); a failed call counts as "no write access" (6.3) |
| F28 | `permissions.blockReadsOutsideWorkingDirectories: true` makes Read, Grep, Glob and LSP refuse paths outside the working directories in every permission mode (Claude Code v2.1.257 or later); `Read` deny rules apply to Grep and Glob on a best-effort basis; `--disallowedTools "mcp__*"` removes every MCP tool. | code.claude.com/docs/en/settings-reference; permissions; cli-reference | Verified |
| F29 | With two branch rulesets on one branch, (a) requiring the contexts with the strict up-to-date policy off and no bypass actor, and (b) requiring the same contexts with strict on and the repository admin role as a `pull_request`-mode bypass actor, an admin merge of a PR that is behind but green is accepted, and an admin merge of a PR with a red, pending or missing required context is refused by (a). The docs state that rules aggregate and that a bypass actor bypasses the rules of its ruleset (F26), but not how a per-ruleset bypass interacts with aggregation. | docs.github.com about rulesets (rule layering), creating rulesets (bypass) | UNVERIFIED. Settled by the live test `tests/live/ruleset-bypass.md` on ship-kit's own repository before release 2 is tagged (22.8): create both rulesets and a review ruleset requiring an approval, with no bypass, on a scratch branch pattern, then record GitHub's answer to `gh pr merge --admin --match-head-commit` for (1) a behind PR with all contexts green and approved, (2) a behind PR with one context failing, (3) one pending, (4) one missing, (5) a behind, green PR without the required approval; and record the `mergeStateStatus` the bypass actor sees for (1). Expected: (1) merges, (2) to (5) refused. If any of (2) to (5) merges, setup never adds the bypass to (b), admin merge is unavailable, and 16.4 says so |

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
the default branch in both places (5.3, 9.2). What a PR may and may not
influence in its own review is one invariant, stated in 20.1.

---

## 4. Component inventory

Paths are relative to the plugin root. "dmi" marks
`disable-model-invocation: true`. Only `setup` and the seat skills are dmi:
`setup` because it installs files and settings into a repo (and any future
release or tag command would be dmi for the same reason), the seat skills so
they cost nothing in a session's context listing (F8) and run only when
named in a prompt. Skills that commit, push or normally merge are
model-invocable and honour the agent settings (5.4), a behavioural contract; the admin
merge is a separate opt-in (`agents.adminMerge`, 16.4).

### 4.1 Skills

| Path | Invoked as | dmi | Release |
|---|---|---|---|
| `skills/setup/SKILL.md` | `/ship-kit:setup [install\|update\|check]` | yes | 2 |
| `skills/develop/SKILL.md` | `/ship-kit:develop` | no | 3 |
| `skills/ship/SKILL.md` | `/ship-kit:ship` | no | 3 |
| `skills/ci-watch/SKILL.md` | `/ship-kit:ci-watch <pr>` | no | 6 |
| `skills/merge/SKILL.md` | `/ship-kit:merge <pr>` | no | 6 |
| `skills/reviewing-design-documents/SKILL.md` + `pattern-method.md` | model | no | 1 |
| `skills/planning-deployable-pr-sequences/SKILL.md` | model | no | 1 |
| `skills/proving-tests-can-fail/SKILL.md` | model | no | 1 |
| `skills/watching-pr-checks/SKILL.md` | model | no | 1 |
| `skills/mining-defect-shapes/SKILL.md` + `hunt-list-format.md` | model | no | 1 |
| `skills/reviewing-for-correctness/SKILL.md` | seat prompt | yes | 2 |
| `skills/hunting-defect-shapes/SKILL.md` | seat prompt | yes | 2 |
| `skills/promoting-shadow-checks/SKILL.md` | model | no | 2 |
| `skills/measuring-coverage-baseline/SKILL.md` | model | no | 4 |
| `skills/resolving-review-findings/SKILL.md` | model | no | 5 |
| `skills/reviewing-security/SKILL.md` | seat prompt | yes | 5 |
| `skills/reviewing-test-integrity/SKILL.md` | seat prompt | yes | 5 |

The command skills (`setup`, `develop`, `ship`, `ci-watch`, `merge`) keep
the owner's imperative names (R13). `ship`, `ci-watch`, `merge` and
`develop` are also model-invocable (R14), so the PR 1.1 amendment scopes
the gerund rule by role, not by frontmatter: it applies to every skill
except a command skill, meaning one whose documented entry point is
`/ship-kit:<name>`; the five command skills are listed by name in the rule
and in the naming test.

### 4.2 Hooks

| Path | Event | Scope |
|---|---|---|
| `hooks/hooks.json` | PreToolUse, matcher `Bash` | 13.5 (`--no-verify` guard, admin tripwire) |

### 4.3 Scripts

| Path | Purpose | Section |
|---|---|---|
| `scripts/lib/config.mjs` | load, validate, default the config | 5 |
| `scripts/lib/schema.mjs` | JSON Schema subset interpreter | 5.2 |
| `scripts/lib/glob.mjs` | `*`, `**`, `?` path matching | 5, 12, 14 |
| `scripts/lib/stamp.mjs` | managed-file stamps and hashes | 19.2 |
| `scripts/lib/render.mjs` | `<<key>>` template rendering | 19.3 |
| `scripts/lib/agent-policy.mjs` | read the agent settings from `origin/<default>`; decide proceed, ask or refuse | 5.4 |
| `scripts/lib/state-marker.mjs` | encode and decode state markers (codec only) | 8.2, 18.1 |
| `scripts/review/review-mode.mjs` | modes, schemas, severity, state-marker trust (run-bound) | 8 |
| `scripts/review/plan.mjs` | partition, scope, priors, materialize the review directory | 6.3, 8 |
| `scripts/review/aggregate.mjs` | fail-closed verdict, comment, state | 6.3, 8 |
| `scripts/review/override.mjs` | parse and authorize overrides and rebuttals | 11 |
| `scripts/review/local-seats.mjs` | run seats headless for `/ship` | 15.3 |
| `scripts/review/extract-tree.mjs` | write the PR head tree as plain files, symlinks as placeholders | 6.3 |
| `scripts/review/receipt.mjs` | write a seat receipt from the environment | 6.3 |
| `scripts/release/bump-version.mjs` | bump `plugin.json` and regenerate seat marker tokens | 6.4 |
| `scripts/coverage/lcov.mjs` | parse and merge LCOV | 12 |
| `scripts/coverage/patch-coverage.mjs` | changed-line coverage | 12 |
| `scripts/coverage/baseline.mjs` | threshold from shadow runs | 12.4 |
| `scripts/classify/classify.mjs` | trivial / standard / hub | 14 |
| `scripts/classify/change-class-check.mjs` | CI check for hub changes | 14.4 |
| `scripts/setup/cli.mjs` | detect, render, diff, write, check | 19 |
| `scripts/mining/collect.mjs` | fetch PRs, comments and state markers | 18 |
| `scripts/promote/shadow-record.mjs` | count clean shadow runs | 10.3 |
| `scripts/hooks/deny-hook-bypass.mjs` | the `--no-verify` guard | 13.5 |
| `scripts/hooks/admin-tripwire.mjs` | best-effort tripwire: denies direct `gh pr merge --admin` and protection or ruleset writes in agent sessions; not a boundary | 13.5 |
| `scripts/watch/watch-pr-checks.sh` | poll PR checks to one summary line | 16.2 |
| `scripts/watch/watch-merge-deploy.sh` | poll a merge commit's runs | 16.2 |
| `scripts/merge/required-checks.mjs` | read required contexts from rulesets and classic protection; verify provenance | 16.3 |
| `scripts/merge/merge.mjs` | the merge decision and the merge call, normal and admin, with one refusal list | 16.4 |

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
| `templates/callers/review.yml` | `.github/workflows/ship-kit-<seat>.yml` | managed file |
| `templates/callers/change-class.yml` | `.github/workflows/ship-kit-change-class.yml` | managed file |
| `templates/blocks/gate-step.sh` | the `run:` body of every rendered gate (6.5, 12.2) | fragment, not written alone |
| `templates/blocks/coverage-jobs.yml` | inside the repo's test workflow | managed block |
| `templates/blocks/claude-md-workflow.md` | inside the repo's `CLAUDE.md` | managed block |
| `templates/files/preflight.mjs` | `.ship-kit/preflight.mjs` | managed file |
| `templates/files/pre-push` | `.githooks/pre-push` | managed file |
| `templates/files/config.json` | `.ship-kit/config.json` | user-owned, stamped |
| `templates/files/hunt-list-code.md` | `.ship-kit/hunt-lists/code.md` | user-owned seed |
| `templates/files/hunt-list-design.md` | `.ship-kit/hunt-lists/design.md` | user-owned seed |

`templates/files/preflight.mjs` is itself a runnable module; its tests
import it directly, so the inlined copy and the tested code are the same
file. Every template keeps its real extension (`.yml`, `.md`, `.mjs`), so
`scripts/check-template-secrets.mjs`, which scans `templates/` and
`.github/workflows/` by extension, reads every template and every reusable
workflow (20.5); its extension list includes `.sh`.

### 4.6 Repository files (not part of the plugin payload)

| Path | Purpose |
|---|---|
| `.github/workflows/review.yml` | reusable review workflow (6) |
| `.github/workflows/patch-coverage.yml` | reusable coverage workflow (12) |
| `.github/workflows/change-class.yml` | reusable change-class workflow (14.4) |
| `.github/workflows/ci.yml` | ship-kit's own CI (21) |
| `.github/workflows/secret-scan.yml` | gitleaks plus `scripts/check-template-secrets.mjs`; required check `gitleaks` (20.5) |
| `.github/workflows/ship-kit-general.yml`, `ship-kit-adversarial.yml` | ship-kit's own required dogfood callers (21.4) |
| `.github/workflows/ship-kit-canary.yml` | the non-required canary caller (21.4) |
| `.ship-kit/config.json` | ship-kit's own config, read by its callers (21.4) |
| `.claude/settings.json` | the adopter-shaped settings fixture the canary runs against (21.4, F25) |
| `schemas/config.schema.json` | the config schema, single source (5.2) |
| `tests/` | all tests (21); `tests/live/` holds recorded live platform checks such as `ruleset-bypass.md` (F29) |

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
  scripts, from the default branch (5.3).

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
    "promotion": { "cleanRuns": 5, "falsePositiveLabel": "ship-kit-false-positive" }
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
  "agents": { "commitAndPush": true, "adminMerge": false },
  "ship": { "maxIterations": 5 },
  "ciWatch": { "maxIterations": 3, "pollSeconds": 30 },
  "merge": { "method": "squash", "humanOnlyPaths": ["docs/standards/**"] }
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
repo-specific hunt list location (`review.huntLists`), whether agents
may commit and push without asking (`agents.commitAndPush`, 5.4), and
whether agents may use the admin-merge path (`agents.adminMerge`, 5.4,
16.4), and the repo's standards paths that only a human merges
(`merge.humanOnlyPaths`, 16.4).

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

`config.mjs` applies the migration chain in memory before validating, so
a workflow or local script at release N reads a config written for any
earlier `schemaVersion` as valid. A `schemaVersion` newer than the running
code knows is invalid (strict defaults, 5.3). `tests/lib/config.test.mjs`
covers an N-1 config read by N and an N+1 config read by N.

### 5.3 Reading config from the trusted commit

The review and change-class plan jobs (6.3, 14.4) read the config with
`git show "$TRUSTED_SHA:.ship-kit/config.json"`, where `TRUSTED_SHA` is
the default-branch commit the run was triggered at (6.3, 20.1), never from
the PR head, so a PR cannot move itself into design-doc mode, demote a
seat to shadow, or change who may override. A PR that edits the config
takes effect for the PRs after it merges. The coverage plan (12.3) reads
it at the PR's base commit, under the weaker guarantee 20.1 states for
coverage.

**Absent or invalid trusted config yields strict defaults**: every seat whose
caller exists is enforced, design-doc mode is off (no dirs), coverage is
enforced only if a threshold exists, override is disabled. The run posts a
notice saying which. Strict defaults fail closed without deadlocking: the
PR that fixes a broken config is reviewed in full mode and can pass. A
setup update cannot reach this state by itself: the PR that moves the
caller pins and migrates the config is reviewed by the callers and config
already on the default branch (6.5), and both change together at merge;
`setup check` fails when any caller pin differs from `config.shipKit.sha`
(19.5).

Local scripts read the config at `origin/<default>` after
`git fetch origin <default>` (15.3, 5.4), the local equivalent of CI's
`TRUSTED_SHA`, so local and CI classify a change the same way when the
local fetch is current.

### 5.4 Agent settings

Two booleans, both answers to setup questions (19.3):

- `agents.commitAndPush` (default `true`), "Allow agents to commit and push
  without asking?", governs every ship-kit skill step that commits,
  pushes, normally merges or opens a PR: `ship` (15.2), `ci-watch` (16.1),
  `merge` (16.4), `promoting-shadow-checks` (10.3),
  `measuring-coverage-baseline` (12.4) and `mining-defect-shapes` (18.3,
  from release 2). A normal merge counts because it publishes to the
  default branch, which is a push by another route.
- `agents.adminMerge` (default `false`), asked after it, governs the one
  admin step, `gh pr merge --admin` inside `/ship-kit:merge` (16.4). When
  it is not `true`, agents never use `--admin` or change protection; they
  report that an admin merge is needed and stop.

**These are a behavioural contract, not a security boundary.** A local
agent runs with the user's own `gh` credentials, and nothing on the
user's machine can stop a process holding those credentials from doing
what they allow: it can call `gh api` or `curl` directly, drive a
terminal, or skip a script. The skills honour the settings, and a
best-effort hook (13.5) catches the common direct commands as a tripwire.
What actually limits an agent is GitHub-side: the rulesets and required
checks, CODEOWNERS with required review, and which identity holds admin
and appears in a ruleset's bypass list (16.4, 20.1). An agent that runs
as a separate identity that is not a repository admin cannot bypass a
ruleset or edit protection at all; setup offers that (19.3).

Before each governed step a skill runs
`node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/agent-policy.mjs`, which runs
`git fetch origin <default>` and reads `agents.commitAndPush` from the
config at `origin/<default>` (an agent's own branch cannot grant it
permission; a failed fetch counts as unreadable) and prints `proceed` or
`ask`. With `--admin` it reads `agents.adminMerge` and prints `proceed`
or `refuse`; anything but an explicit `true` is `refuse`:

- `proceed`: the step runs.
- `ask`: the skill stops before the step and asks the user, naming the
  exact commit or push. It proceeds only on an explicit yes. No answer, an
  unavailable question tool, or a run with `CI` or `GITHUB_ACTIONS` set
  (CI or headless) is a no: the skill reports what it would have done and
  stops without committing or pushing.
- `refuse`: the skill reports that an admin merge is needed, with the
  state that makes it so, and stops.

`tests/lib/agent-policy.test.mjs` covers: true proceeds; false asks; false
under `CI` never proceeds; a branch-local edit to `true` is ignored when
`origin/<default>` says `false`; an absent or invalid config there, or a
failed fetch, counts as `false`; `--admin` proceeds only on an explicit
`true` and refuses on `false`, absent, invalid, unreadable, or a
branch-local edit to `true`.

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
| input | `config_path` | string | no, default `.ship-kit/config.json` | where the trusted commit's config lives |
| input | `canary` | boolean | no, default `false` | skip the release-tag check and add the canary-only behaviour; honoured only under the canary conditions in 6.3 |
| secret | `claude_code_oauth_token` | secret | no | OAuth auth for seats |
| secret | `anthropic_api_key` | secret | no | API-key auth for seats |
| output | `status` | string | | `pass`, `fail-findings`, `fail-coverage`, `fail-config`, `needs-maintainer`, `override` |
| output | `enforced` | string | | `true` or `false`; from the trusted config's seat mode |
| output | `mode` | string | | `full` or `design-doc` |

Exactly one secret must be non-empty; otherwise plan reports
`fail-config` naming both (fail closed, 6.3). Every input, output, secret and the
meaning of each `status` value is API: changing any of them is a breaking
change (CLAUDE.md, Versioning and releases).

Secrets are passed explicitly, never `secrets: inherit`, because adopting
repos may be owned by other accounts than ship-kit (F2).

### 6.3 Jobs inside `review.yml`

All third-party actions are pinned by full commit SHA with the tag in a
trailing comment. Node for the scripts is set up at a version fixed in
`review.yml` (24), not the caller's, so scripts run under the version they
were tested on. `review.yml` also fixes `PLUGINS_OFFICIAL_SHA`, the commit
of `claude-plugins-official` its seats install from (7.2); moving it is a
ship-kit release.

**Trusted commit.** Every job computes `TRUSTED_SHA` the same way:

- event `pull_request_target`: `github.sha`, the default-branch commit the
  event ran at (F18);
- event `pull_request`: accepted only for ship-kit's own canary, when
  `inputs.canary` is true and `job.workflow_repository ==
  github.repository`; `TRUSTED_SHA` is
  `github.event.pull_request.base.sha`;
- anything else: `status=fail-config` ("unsupported trigger").

**Layout** (every job). The workspace root holds the adopting repo at
`TRUSTED_SHA` (`actions/checkout` with `ref: TRUSTED_SHA`,
`persist-credentials: false`; `fetch-depth: 0` in plan, which needs
history for merge bases and ancestry (8.2), and 1 elsewhere). Everything
else lives under `$RUNNER_TEMP/ship-kit/`, outside the checkout, each
directory deleted and recreated before it is written:

| Directory | Content | How |
|---|---|---|
| `src/` | ship-kit at `job.workflow_sha` | `git init`, `git fetch --depth 1 https://github.com/<job.workflow_repository> <job.workflow_sha>`, checkout `FETCH_HEAD` (ship-kit is public; no credential) |
| `deps/claude-plugins-official/` | the official marketplace at `PLUGINS_OFFICIAL_SHA` | same, from its public repository |
| `review/` | the materialized review directory the seats read | written by `plan.mjs`, carried as the `ship-kit-plan` artifact |
| `expect/` | `run.json`: the nonce, the plugin version and the superpowers `sha` (the expected markers are read from `src/`, 6.4) | written by `plan.mjs`, carried as the `ship-kit-expect` artifact, which only aggregate downloads |
| `pr/` | the PR head tree, as files | `scripts/review/extract-tree.mjs`: walks `git ls-tree -r -z <head>` and writes each blob with `git cat-file`; a symlink becomes a text file holding `symlink to <target>`, a submodule a text file naming its commit; no `.gitattributes` from the PR is applied (unlike `git archive`); nothing ever runs with this as its working directory |

**Fetching the PR head.** The head is fetched as objects only, with the
job token supplied for that one command and never written to git config,
so it works on a private repository:
`git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$FETCH_TOKEN" | base64 -w0)" fetch --no-tags origin +refs/pull/<n>/head:refs/ship-kit/head`,
with `FETCH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in that step's `env`
only; plan fetches full history, seats `--depth 1`. The fetched commit
must equal `github.event.pull_request.head.sha` in plan and in every seat
(a seat that finds another commit exits non-zero before extracting `pr/`,
so its receipt is null; in plan it is `fail-config`,
"head moved"; the newer event's run supersedes it through the caller's
concurrency group). Diffs use `git diff --no-ext-diff --no-textconv
--no-renames TRUSTED_SHA...head` in plan, so they work while the PR has a
merge conflict (F18). No step installs, builds or runs anything from the
PR. `tests/workflows/review-yml.test.mjs` asserts the header form, that no
step sets `persist-credentials: true`, and that the token appears only in
that step's `env`; the private-repo exit check (22.8) runs it live.

**Expressions never reach a shell.** No `run:` body in `review.yml`, the
other reusable workflows or any template contains `${{`. Every value from
an event, an input, another step's output or model output reaches a
script through `env:` and is read from the environment by the script (for
example `node -e 'fs.writeFileSync(p, process.env.OUT)'`), never by
interpolation into shell text. `tests/workflows/no-expression-in-run.test.mjs`
parses every workflow and template in the repository and fails on any
`run:` body containing `${{`.

**Secrets by job.**

| Job | Job token permissions | Claude auth secret |
|---|---|---|
| plan | contents, pull-requests, issues, actions: read | only `HAS_AUTH: ${{ secrets.<x> != '' }}` booleans in one step's `env`; never the value |
| seat | contents: read | in the claude-code-action step's inputs only |
| aggregate | contents read, pull-requests write, issues read, actions read | none |
| caller gate | none (`permissions: {}` in the caller) | none |

**plan** (`runs-on: ${{ fromJSON(inputs.runners).plan }}`):

1. Shell steps: check out, fetch `src/`, fetch the PR head. A failure here
   fails the job, which the gate treats as a failure (6.5).
2. `plan.mjs preflight`: the trigger rule above; the release pin, unless
   the canary conditions hold (`git ls-remote
   https://github.com/<job.workflow_repository> 'refs/tags/ship-kit--v*'`
   must list a tag whose peeled commit, its `^{}` line or the tag line for
   a lightweight tag, equals `job.workflow_sha`; the pin itself comes from
   the default-branch caller (20.1), so this check confirms setup wrote a
   release and is not what keeps a PR out of its own review); exactly one
   auth secret present; the head check.
3. `plan.mjs author`: seats run only when both hold, else status
   `needs-maintainer`:
   - the event's sender (`github.actor`, the account the action checks,
     F22) has write, maintain or admin permission (F27); and
   - either the PR's head repository is this repository and the PR's
     author (`pull_request.user.login`) has write or higher, or a
     maintainer has approved the current head: an unedited comment
     `/ship-kit-review <sha>` whose `<sha>` is the full 40-hex head SHA,
     equal to `pull_request.head.sha`, by an author with at least
     `review.override.minPermission` and never a bot login.
   A re-run keeps the original run's `github.actor` (F22), so re-running a
   run a contributor's push started can never satisfy the first
   condition. The approval therefore takes effect on the next event a
   maintainer sends; the reason text says exactly that: "This PR comes
   from a fork or from an author without write access, or its last event
   was sent by one. A maintainer who has read the diff comments
   `/ship-kit-review <full head sha>` and then closes and reopens the PR;
   the reopen runs the review with the maintainer as sender." A reopen is
   a `pull_request_target` event type the caller already listens to
   (6.5), its sender is the maintainer, and its checks attach to the PR
   like any other `pull_request_target` run (F18). A comment whose `<sha>`
   is shorter than 40 hex characters or differs from the head is
   rejected, and the summary prints the full head SHA to paste. A
   permission read that fails counts as no permission.
   `tests/review/plan.test.mjs` covers: a same-repo writer's PR; a fork
   PR with no approval; an approval by a writer followed by a reopen from
   that writer; the same approval on a re-run whose `github.actor` is the
   contributor; a 7-hex and a 39-hex prefix of the head; an approval for
   an older head; an edited approval; a bot's approval.
4. `plan.mjs plan --trusted <TRUSTED_SHA> --head <head>`: reads the
   config at `TRUSTED_SHA` (5.3), classifies the mode (8.1), evaluates
   overrides (11.3), partitions the diff and writes `review/`:
   `seat-N.patch`, `seat-N.stat`, `pr.txt`, `scope.txt`,
   `seat-N.prior.json` (design-doc mode), `rebuttals.json` (11.2),
   `contract/*.md` copied from `src/review/contract/` with a fresh random
   `contract_nonce` substituted into `output.md`, and `hunt/` (9.2). It
   writes `expect/run.json`: the nonce, the plugin version, and the
   superpowers `sha` read from `deps/`'s `marketplace.json`. It asserts
   every changed file lands in exactly one seat.
5. Every recognized failure in steps 2 to 4 writes `review/status.json`
   `{status, reason}` (`fail-config` or `needs-maintainer`) and sets
   `count=0`. Outputs: `matrix`, `count`, `empty`, `mode`, `json_schema`,
   `enforced`, `override`.
6. Upload `review/` as `ship-kit-plan` and `expect/` as `ship-kit-expect`.

**seat** (matrix over `plan.outputs.matrix`, `fail-fast: false`, skipped
when `count` is 0, `empty` is true or `override` is true):

1. Check out, fetch `src/` and `deps/`, fetch the PR head, extract `pr/`.
2. Download `ship-kit-plan` into `review/`; copy this seat's chunk to
   `diff.patch`, `stat.txt`, `prior.json`.
3. Run `anthropics/claude-code-action` with:
   - `github_token: ${{ secrets.GITHUB_TOKEN }}` (F6, F16, R15), which is
     contents-read here, so the copy the action writes into the
     workspace's `.git/config` (F22) can only read;
   - the auth secret from 6.2;
   - `settings`: `{"disableAllHooks": true, "permissions":
     {"blockReadsOutsideWorkingDirectories": true, "deny":
     ["Read(./.git/**)", "Read(//proc/**)", "Read(~/.ssh/**)",
     "Read(~/.config/**)", "Read(~/.claude/**)", "Read(~/.gitconfig)",
     "Read(~/.git-credentials)"]}}` (user scope, F22, F23, F28). The
     block fences off everything outside the working directories except
     the skill, plugin, rule, agent, command and memory files under
     `~/.claude/`, which the settings reference exempts from it, so
     `Read(~/.claude/**)` is the only guard for that tree and must stay;
     the other denies name credential locations as a second layer, and
     none of them may cover a working directory: on hosted runners the
     workspace and `$RUNNER_TEMP` both sit under `$HOME`, so a deny of
     `~/**` would refuse the seat's own inputs.
     `tests/workflows/review-yml.test.mjs` asserts that no deny pattern
     matches `$GITHUB_WORKSPACE`, `review/` or `pr/` or any ancestor of
     them;
   - `plugin_marketplaces` and `plugins` per 7.2;
   - `prompt: /ship-kit:<skill for inputs.seat> <review dir>`;
   - `claude_args`: `--setting-sources user --permission-mode dontAsk
     --tools "Read,Grep,Glob,TodoWrite" --allowedTools
     "Read,Grep,Glob,TodoWrite" --disallowedTools "mcp__*" --add-dir
     <review dir> <pr dir> --max-turns <review.maxTurns> --json-schema
     '<plan json_schema>'`, plus `--model <model>` when the seat's config
     names one.
   The working directories are the workspace root (the default branch),
   `review/` and `pr/`; reads anywhere else, including the rest of
   `$RUNNER_TEMP`, the rest of `$HOME` and `/proc`, are refused (F28). The seat has no
   shell, no MCP tool, no write tool and no subagents (`Task` is absent
   because a seat is already one shard and headless CI orphans in-agent
   subagents).
4. Always write and upload a receipt: a step with
   `env: OUT: ${{ steps.claude.outputs.structured_output }}` runs
   `node $RUNNER_TEMP/ship-kit/src/scripts/review/receipt.mjs <index>`,
   which writes `{index, seat, body}` from `process.env.OUT` (`body` is
   `null` when `OUT` is empty or not JSON) to an artifact named
   `ship-kit-receipt-<index>`.

**aggregate** (`needs: [plan, seat]`, `if: always()`, on the `aggregate`
runner so it does not share fate with the seat machines):

1. Fetch `src/`; download `ship-kit-plan`, `ship-kit-expect` and the
   receipts.
2. `node $RUNNER_TEMP/ship-kit/src/scripts/review/aggregate.mjs` decides
   `status`, in order:
   - a `status.json` from plan: its status (`fail-config` or
     `needs-maintainer`);
   - no plan artifact: `fail-coverage`;
   - `override` true: `override`;
   - `empty` true (the PR changes no file): `pass`;
   - coverage, for the `count` planned seats: exactly one receipt per
     planned index, read only from `ship-kit-receipt-<index>`; a missing
     receipt, a null body, a verdict outside `PASS`/`FAIL`,
     `complete !== true`, a `contract_nonce` different from
     `expect/run.json`'s, or a `skill_marker` different from the marker
     line in `src/skills/<seat skill>/SKILL.md` at `job.workflow_sha`
     (6.4) is `fail-coverage`;
   - otherwise the verdict (6.4, 8.3).
3. Post the summary with `gh pr comment --body-file`, and any inline
   findings (`findings[].file`, `line`) as one pull-request review through
   `gh api --input <file>`, all as `github-actions[bot]`. Seat text is
   rendered inert first: `@` mentions are wrapped in code spans so they
   notify no one, HTML is escaped, and any string shaped like
   a credential (`ghs_`, `gho_`, `ghp_`, `github_pat_`, `sk-ant-`,
   `x-access-token:`) replaces the whole finding with "withheld: output
   resembled a credential" and sets `status=fail-coverage`. Then upload
   the `ship-kit-state` artifact holding the comment id and the exact
   state-marker payload (8.2).
4. Set outputs `status`, `enforced`, `mode`. The job exits 0 on every
   status; only a crash fails it, which the caller's gate treats as a
   failure (6.5).

**Canary-only behaviour**, under the same guard as `inputs.canary`
(event `pull_request` and `job.workflow_repository == github.repository`):
plan adds one negative-control matrix entry whose prompt is the review
directory without the slash command, and aggregate expects it to be
`fail-coverage` and excludes it from the verdict; the seat step also
uploads the action's `execution_file` output, from which aggregate
asserts the session's tool list (exactly the `--tools` set), that no hook
ran, that reads of `review/diff.patch`, a file under `pr/` and the
workspace `CLAUDE.md` succeeded; that reads of `.git/config`,
`/proc/self/environ`, `~/.gitconfig`, `~/.claude/settings.json`,
`~/.ssh/ship-kit-canary`, `$RUNNER_TEMP/ship-kit-canary` and a `pr/`
placeholder for a symlink were each refused by permission, not by a
missing file (the canary seat job first writes a sentinel file at each
probed path that might not exist); and that a Grep for `x-access-token`
over the workspace, which is a permitted directory, returns no match from
`.git/` and no token text. The canary fixture PR asks the seat to do each
of these. A failed assertion fails the canary.

`tests/workflows/review-yml.test.mjs` parses `review.yml` and asserts the
seat step's `claude_args`, `settings`, `github_token` and marketplaces as
listed, each job's permissions as in the table, that no step has a
`working-directory` under `pr/`, that no `actions/checkout` step names
the PR head, and that no seat step downloads `ship-kit-expect`.

### 6.4 Seat output contract

`review/contract/output.md` is the only statement of it; the seat skills
point at it. In every mode a seat returns `verdict` (`PASS`/`FAIL`),
`complete`, `unreviewed`, `summary`, `contract_nonce` (the value written
into this run's `output.md`, 6.3 plan step 4) and `skill_marker`. Full
mode adds, from release 5, `findings[]` with `severity`, `file`, `line`,
`finding`, `failure_scenario`; design-doc mode adds the fields in 8.3.

`skill_marker` proves the seat's own skill text was in context. Each seat
SKILL.md carries one literal line, `skill_marker:
<skill name>@<plugin version>:<token>`, where `<token>` is 16 random hex
characters that appear nowhere else in the repository.
`scripts/release/bump-version.mjs`, run in the PR that bumps
`plugin.json`, regenerates every token; `tests/skills/marker.test.mjs`
fails when a marker's version differs from `plugin.json` or two tokens
match. Aggregate reads the expected marker from `src/`, which no seat can
read (6.3), and the seat's readable directories hold no expected value.

Why both fields, and why this closes a seat that never loaded its skill:
the nonce alone is not enough, because it sits in `review/contract/output.md`,
which a model given only the literal prompt text and the schema could
find by listing the directory it was named. The marker token exists only
in the SKILL.md text, which reaches the model only when the skill loads;
the ship-kit version string alone would not do, because the adopting
repo's config and caller comments carry it. A seat that loaded an older
ship-kit (F25) returns that release's token. The nonce adds that this
run's contract was read, so an output cannot be a replay. Neither guards
against a seat trying to deceive, which is outside this check's purpose.
One exception: on ship-kit's own reviews both the workspace root (its
default branch) and the PR tree contain the seat SKILL.md files with the
released tokens, so there the marker proves nothing and the canary's
negative control (6.3) is the check. Aggregate
scores any mismatch `fail-coverage` (6.3).

`review-mode.mjs` generates the matching JSON Schema for each mode; the
schema is passed as a single-quoted shell word, so neither schema may
contain a single quote (`tests/review/review-mode.test.mjs` asserts it).

### 6.5 Caller template

`templates/callers/review.yml`. Placeholders use `<<key>>` so they never
collide with `${{ }}` expressions. `render.mjs` refuses unknown keys and
any unreplaced placeholder. Credentials appear only as `${{ secrets.NAME }}`
(20.5).

```yaml
# ship-kit-managed: <<stamp_json>>
# Rendered by /ship-kit:setup from .ship-kit/config.json. Hand edits are reported as drift.
# Requires the repository secret <<secret>> (<<auth_text>>).
# Runs on pull_request_target: this file and its pin are read from the default branch, never from the PR.
name: ship-kit <<seat>> review

on:
  pull_request_target:
    branches: [<<default_branch>>]
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
      actions: read
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
<<gate_script>>
```

`<<gate_script>>` is `templates/blocks/gate-step.sh`, the one source of
every gate's body (6.5, 12.2). `render.mjs` inserts a fragment under a
`run: |` block scalar by prefixing each line with the indentation of the
placeholder's line plus two spaces; `tests/lib/render.test.mjs` checks the
rendered YAML parses and the extracted body equals the fragment
byte-for-byte. The fragment:

```sh
echo "needs succeeded: $ALL_SUCCEEDED; status: ${STATUS:-none}; enforced: ${ENFORCED:-unknown}"
if [ "$ALL_SUCCEEDED" = "true" ] && { [ "$STATUS" = "pass" ] || [ "$STATUS" = "override" ]; }; then
  exit 0
fi
if [ "$ENFORCED" = "false" ]; then
  echo "::warning::This check is in shadow mode. It would have failed with status '${STATUS:-none}'."
  exit 0
fi
echo "::error::The check did not run to a pass (status '${STATUS:-none}'). An absent or incomplete run is not a pass. After a rebuttal or an override, re-run ALL jobs (gh run rerun <run-id>, without --failed): re-running only failed jobs re-reads this attempt's result."
exit 1
```

`<<default_branch>>` is the repository's default branch at setup. The
filter keeps `TRUSTED_SHA` (the default-branch tip, F18) meaningful: the
review runs for PRs into the branch whose config it reads.

`<<boot_job>>` is empty unless `render.bootWorkflow` names a local reusable
workflow that must run first (for example, starting self-hosted capacity);
then it renders a `boot` job with `uses:` that path, and `review` gains
`needs: boot`. Under `pull_request_target` that local path also resolves on
the default branch. `<<gate_needs>>` is `review` or `boot, review`.

Gate properties, each pinned by `tests/callers/gate.test.mjs`, which
extracts the `run:` block from a rendered caller and executes it with
`bash` under every combination of the three variables:

- A dependency that failed, was cancelled or was skipped fails the gate,
  because GitHub counts a skipped job as a success and the gate must not
  inherit that.
- An empty `ENFORCED` (plan never ran) is enforced.
- A shadow seat passes with a warning, whatever its status.
- The review runs even while the PR has a merge conflict (F18); GitHub
  refuses to merge a conflicting PR regardless.

The fragment above was executed with `bash` for the eighteen combinations
of `ALL_SUCCEEDED` in {true,false}, `STATUS` in {pass,fail-findings,override},
`ENFORCED` in {true,false,empty}; it exited 0 exactly when the review ran
to `pass` or `override`, or `ENFORCED` was `false`.

**Re-runs.** A rebuttal (11.2) or an override (11.3) is read by plan, so it
takes effect only on a run whose plan job runs again: a new push, or
"Re-run all jobs" (`gh run rerun <run-id>`). A re-run keeps the original
sender (F22), so when that sender lacks write access (every fork PR, and
any PR whose last event came from a non-writer) the re-run stays
`needs-maintainer`; such a PR takes the rebuttal or override on the next
maintainer-sent event instead, a close and reopen (6.3 plan step 3). "Re-run failed jobs" re-runs
only `gate`, which re-reads the old attempt's outputs, and the gate's error
text says so. `/ship-kit:ci-watch` and `resolving-review-findings` always
use `gh run rerun <run-id>` without `--failed`; the watcher test asserts the
argument list.

### 6.6 Required-check names

The required contexts are the rendered gate `name:` values from
`render.checks` (5.1), added to the checks ruleset and, where it exists,
the up-to-date ruleset (or to classic protection) that setup recommends
(19.3), so a promotion updates both, and ship-kit reads both
sources (16.3). A shadow seat's gate is required like any other, added
once its caller has run on a PR (19.3), so promotion is a reviewed config
change and a deleted caller shows as a pending required check rather than
silently disappearing. The default names are API: changing a default is a
breaking change (CLAUDE.md, Versioning and releases).

---

## 7. How CI loads the plugin

### 7.1 Pinning

The caller pins `review.yml` to a full commit SHA (the tag in a comment),
because a SHA is immutable and a tag is not (CLAUDE.md, Workflow
templates), and the caller that runs is the default branch's (F18). Every
job inside `review.yml` fetches ship-kit at `job.workflow_sha` (F1), and
plan step 2 (6.3) verifies that SHA is a release tag. The scripts, the seat
skills, the contract and the shared hunt lists all come from that one
fetch. The seat session loads no project or local settings and no hooks
(6.3 seat step 3), so nothing in the adopting repo can substitute other
skill text; `skill_marker` (6.4) makes a substitution fail closed rather
than pass.

### 7.2 Exact inputs on the seat step

```yaml
plugin_marketplaces: |
  ${{ runner.temp }}/ship-kit/src
  ${{ runner.temp }}/ship-kit/deps/claude-plugins-official
plugins: |
  ship-kit@ship-kit
```

- Both are local-path marketplaces (F5), fetched at fixed commits (6.3
  layout). A git URL cannot be used, because the action rejects a URL with
  a `#ref` suffix (F5), so a URL would install whatever the default branch
  holds.
- The official marketplace is present so the declared superpowers
  dependency resolves (F15). Its copy is at `PLUGINS_OFFICIAL_SHA`, and its
  entry pins superpowers by `sha` (F24), so the superpowers commit a seat
  installs changes only when a ship-kit release moves
  `PLUGINS_OFFICIAL_SHA`. Seats invoke no superpowers skill, and
  `disableAllHooks` (6.3) stops superpowers' `SessionStart` injection
  (F24). `run.json` records the superpowers `sha`, and the summary comment
  prints it.
- A failed install fails the action step, the seat records a null receipt,
  and aggregate returns `fail-coverage`: fail closed.

### 7.3 Seat prompt

The prompt is the slash command and the review directory, nothing else:
`/ship-kit:hunting-defect-shapes <review dir>`, where `<review dir>` is
`$RUNNER_TEMP/ship-kit/review`. Everything else a seat needs is a file
there, and the PR's files are in `$RUNNER_TEMP/ship-kit/pr` (both passed
with `--add-dir`). The prompt contains no `${{ }}` of any size, so the
Actions expression length cap does not apply to hunt-list growth.
`review/contract/output.md` tells seats that the workspace root is the
default branch, for reading the repository's standards, and that `pr/` is
the code under review.

---

## 8. Design-doc mode

### 8.1 Entry

`classifyMode(paths, dirs)` in `review-mode.mjs`: design-doc mode when the
PR changes at least one file and every changed path (both sides of every
rename, `--no-renames`) starts with a directory in `review.specDirs` or
`review.planDirs` of the trusted config (5.3). Anything else, including an empty
diff, is full mode. With no dirs configured the mode never triggers.

### 8.2 Incremental scope and the state marker

- Aggregate writes the comment's first line as
  `<!-- ship-kit-review-state <base64url JSON> -->` carrying
  `{v, kind, head, mode, complete, mergeBase, findings, runId}`; `kind` is
  the seat name and `runId` the workflow run that wrote it. Only the first
  line is parsed, so text a seat returns cannot stand in for it. The codec
  is `scripts/lib/state-marker.mjs`.
- Any workflow's token posts as `github-actions[bot]`, including one a PR
  adds, so authorship proves nothing. A state is trusted only when
  `trustState` in `review-mode.mjs` confirms, through the API with the
  job's `actions: read`: run `runId` exists, its `event` is
  `pull_request_target` and its `path` is the managed caller for `kind`
  (`.github/workflows/ship-kit-<kind>.yml`); its `ship-kit-state` artifact
  (6.3 aggregate step 3) holds this comment's id and a payload identical
  to the marker; and the comment is unedited (`created_at ==
  updated_at`). Any API error is "not trusted".
  `tests/review/design-doc-mode.test.mjs` covers a forged marker from a
  bot comment with no matching run, a real run id with a different
  payload, and an edited comment, each untrusted.
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

The plan job materializes `hunt/` in the review directory (6.3), which
lives outside the checkout, so a PR cannot add files to it:

- `design-shared.md` and `code-shared.md` from `src/` (the pinned
  release, 7.1);
- `repo-code.md` and `repo-design.md` with
  `git show "$TRUSTED_SHA:<path from the trusted config>"`, never from the
  PR head. A path absent there is a notice in the summary, not an error.

The adversarial seat reads the code lists in every mode and the design
lists too in design-doc mode. The general seat reads none: it is tuned for
precision and a hunt list would pull it toward recall. A PR that edits a
hunt list is reviewed with the list as it is on the default branch, and
the edit takes effect after merge.

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
seat's stance, what to read, pointers to `contract/` and `hunt/` in the
review directory, and its `skill_marker` line (6.4). A seat that needs
`CLAUDE.md` or the standards it names reads them explicitly from the
workspace root (the default branch), because the session loads no project
setting source (6.3). The test-integrity checklist covers a test that cannot
fail, an assertion restating the preceding action, a loosened shared
fixture, a bug fix without a regression test, duplicated test setup, and a
PR claim no test exercises. The security checklist covers credentials
reachable beyond their consumer, trust keyed on caller-settable values,
authorization reimplemented away from its source of truth, and secrets in
URLs or logs.

### 10.2 Modes

`review.seats.<seat>.mode` in the trusted config is `required` or `shadow`;
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
bar) the skill proposes a one-line config change to `required` as a PR,
committing and pushing it under 5.4.
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
`rebuttals.json` in the review directory, labelled untrusted data (20.2). Seats read it
as a claim to check and say whether it changes their verdict. A rebuttal
takes effect on the next run whose plan job runs: a new push, or a re-run
of all jobs of the failed run (6.5, Re-runs), by the author or by
`/ship-kit:ci-watch`. There is no `issue_comment` trigger,
because a run from that event attaches its check to the default branch,
not the PR head (F4), so it could never satisfy the required check.

### 11.3 Override

Valid when, at plan time, all hold:

- the PR carries `review.override.label` (read live through the API, not
  from the frozen event payload, since a re-run replays the original
  payload);
- a comment matches `^/override <seat> <sha>: <reason>$`, where `<sha>` is
  the full 40-hex SHA and equal to the current head, and `<reason>` is
  non-empty (a shorter or different SHA is rejected with a message
  printing the full head SHA; a prefix could be matched by a new commit
  crafted to share it);
- the comment is unedited (`created_at == updated_at`) and its author has
  at least `minPermission`.

The override is read when plan runs, so it takes effect on a re-run of
all jobs, or for a PR whose last event came from a non-writer on a close
and reopen by a maintainer (6.5, Re-runs). Binding the override to the full head SHA means
a later push needs a new override, so an override cannot silently cover code written after it. The
plan emits `override=true`, seats are skipped, aggregate posts
"overridden by <login> for <sha>: <reason>" and sets `status=override`.
`scripts/review/override.mjs` holds the parser and predicate;
`tests/review/override.test.mjs` covers each condition failing alone,
including a 7-hex prefix of the head. `/rebut` names a finding, not a
commit, and takes no SHA; a rebuttal is data a seat weighs (11.2), never
an authorization.

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
    if: always() && github.event_name == 'pull_request'
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
    if: always() && github.event_name == 'pull_request'
    runs-on: <<gate_runner_json>>
    steps:
      - name: Require patch coverage to have run and passed
        env:
          ALL_SUCCEEDED: ${{ !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') && !contains(needs.*.result, 'skipped') }}
          STATUS: ${{ needs.patch-coverage.outputs.status }}
          ENFORCED: ${{ needs.patch-coverage.outputs.enforced }}
        run: |
<<gate_script>>
  # ship-kit-managed-end
```

`<<gate_script>>` is the fragment in 6.5 (`templates/blocks/gate-step.sh`),
inserted by the same indentation rule, so the two gates cannot drift.

Both jobs carry `github.event_name == 'pull_request'` because test
workflows usually also run on pushes to the default branch, where there is
no PR to measure; a job skipped by its condition reports success (F21),
so a push run stays green, and on a PR the condition is true. `tests/setup/render.test.mjs`
asserts both conditions in the rendered block.

### 12.3 `patch-coverage.yml` API

| Kind | Name | Type | Meaning |
|---|---|---|---|
| input | `lcov_artifact_pattern` | string, required | artifacts to download and merge |
| input | `runners` | string (JSON), required | `{"plan":[...]}` |
| input | `config_path` | string, default `.ship-kit/config.json` | config location, read at `github.event.pull_request.base.sha` |
| output | `status` | string | `pass`, `fail-threshold`, `fail-missing`, `fail-config` |
| output | `enforced` | string | `true` when `coverage.mode` is `required` and a threshold exists |
| output | `percent` | string | the measured value or `n/a` |

No artifact matching the pattern is `fail-missing`. Any event other than
`pull_request` is `fail-config` (never reached through the rendered
block). The job posts a summary comment carrying a state line
`<!-- ship-kit-coverage-state <base64url JSON> -->` with
`{v, head, covered, uncovered, percent, runId}` and uploads the matching
`ship-kit-state` artifact; `trustState` (8.2) accepts it when the run's
`path` is the repo's test workflow and its artifact matches. Coverage runs
inside the PR-controlled test workflow, so this proves only that the
state came from that workflow (20.1).

### 12.4 Baseline and promotion

The coverage gate installs in shadow with `threshold: null`.
`/ship-kit:measuring-coverage-baseline` runs `scripts/coverage/baseline.mjs`:
take the trusted coverage states on the last 20 merged PRs whose value is
not `n/a`; the threshold is the 20th percentile by nearest rank (the value
at position `ceil(0.2 * n)` in ascending order), floored to a whole
percent. With fewer than 20 such PRs it reports how many exist and
proposes nothing. The skill proposes (under 5.4) a config PR setting `threshold`,
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

### 13.5 Hook guards for agent sessions

`hooks/hooks.json` as of release 6 (PR 3.2 ships the first two entries,
PR 6.2 adds the third):

```json
{
  "description": "Blocks git commit/push with --no-verify (or git commit -n), and flags direct admin merges or branch-protection writes through gh, in Claude Code sessions. A tripwire for honest mistakes, not a security boundary.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "if": "Bash(*--no-verify*)", "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/deny-hook-bypass.mjs"], "timeout": 5 },
          { "type": "command", "if": "Bash(git commit *)", "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/deny-hook-bypass.mjs"], "timeout": 5 },
          { "type": "command", "if": "Bash(gh *)", "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/admin-tripwire.mjs"], "timeout": 5 }
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

`admin-tripwire.mjs` tokenizes the command the same way and denies any
`gh` invocation that is `pr merge` with `--admin`, or `api` with a writing
method (`-X`/`--method` `PUT`, `POST`, `PATCH`, `DELETE`, or any `-f`/`-F`
field, which makes `gh api` default to `POST`) whose path contains
`/protection`, `/rulesets` or `/pulls/<n>/merge` (a direct merge call).
Everything else passes. It is a tripwire for
an agent that forgets the contract, not a boundary: `curl`, another
client, a script, or a command that does not begin with `gh` all pass it
(5.4). The sanctioned admin merge is `merge.mjs`'s admin step (16.4),
whose `gh` call runs inside the script and is not a tool call.

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
under the trusted config, with the same `TRUSTED_SHA`, layout and trigger
rules as `review.yml` (6.3). For `hub`, the PR body must name a path under
a spec dir and, when `hubRequires` includes `plan`, a path under a plan
dir, each existing at `TRUSTED_SHA` (a merged design and plan). The caller
runs on `pull_request_target` like the review callers and triggers on
`edited` as well, since the PR body is the input; the workflow is cheap,
so re-running on edits costs little. It installs in
shadow and promotes like a seat (10.3).

---

## 15. `/ship-kit:ship`

### 15.1 Contract

Model-invocable (R14). Its commit and push steps honour 5.4.

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
5. Check 5.4, then `git add` the changed files by name and commit once;
   run `node .ship-kit/preflight.mjs` (full) on the clean tree; check 5.4
   again, then push. The pre-push hook verifies the receipt (13.3). When
   5.4 says ask and no user answers yes, it stops with the converged
   changes uncommitted (or committed but unpushed) and reports.

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
  --plugin-dir <plugin root> --setting-sources user \
  --settings '{"disableAllHooks": true}' --permission-mode dontAsk \
  --tools "Read,Grep,Glob,TodoWrite" --allowedTools "Read,Grep,Glob,TodoWrite" \
  --disallowedTools "mcp__*" --add-dir <review dir> \
  --max-turns <review.maxTurns> --json-schema '<schema>' --output-format json
```

`<plugin root>` is the root of the plugin `local-seats.mjs` itself runs
from (resolved from its own module path), so the seat loads exactly the
skills whose markers `local-seats.mjs` expects, whichever way the plugin
was installed (19.4's project settings, a user-scope install, or
`--plugin-dir`). `--setting-sources user` keeps the project's and local
settings, hooks and MCP servers out, as in CI; the user's own settings and
plugins still load, with hooks off, so a local seat is a fast pre-check
and CI stays authoritative. Whether `--plugin-dir` wins over a
same-named user-scope install is settled in PR 3.4; a wrong resolution
fails the marker check rather than passing.

It writes receipts in the CI format and runs `aggregate.mjs --local`. The
seats are the same skills, contract and hunt lists CI uses; the config
and repo hunt lists come from `origin/<default>` after a fetch (5.3), the
local equivalent of CI's `TRUSTED_SHA`. `local-seats.mjs` writes a nonce
into the local contract copy, keeps the expected values outside the
review directory, and checks `contract_nonce` and `skill_marker` exactly
as CI does (6.4). Each run is a separate process, so
the cold pass is cold by construction. F13 is settled for `claude -p` in
PR 3.4.

---

## 16. `/ship-kit:ci-watch`, watchers and merge

### 16.1 `/ship-kit:ci-watch <pr>`

Model-invocable (R14); each commit and push honours 5.4. After push, up
to `ciWatch.maxIterations`:

1. Wait with `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh <pr>`
   (under the Monitor tool when available).
2. All green: report; in design-doc mode with NON-BLOCKING findings open,
   fold them once in one commit, confirm with one round, and stop (17.1).
3. Otherwise collect failed job logs (`gh run view --log-failed`) and the
   aggregate comments' findings, fix locally, run
   `node .ship-kit/preflight.mjs --fast`, commit the fix as its own commit
   (once pushed, history is not rewritten), run full preflight, push,
   re-arm. After a rebuttal with no code change, it re-runs with
   `gh run rerun <run-id>` (all jobs, 6.5) instead of pushing.
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

### 16.3 Required checks

The watcher reports every check; `/ship-kit:ci-watch` and
`/ship-kit:merge` decide on the required contexts, which
`scripts/merge/required-checks.mjs <pr>` reads from both sources:

- rulesets: `GET /repos/{o}/{r}/rules/branches/{default}`, every
  `required_status_checks` rule's `required_status_checks[].context`;
- classic protection:
  `GET /repos/{o}/{r}/branches/{default}/protection/required_status_checks`,
  `contexts` plus `checks[].context`. A 404 means no classic protection and
  contributes nothing.

Any other non-200 response from either is "unreadable". The script exits
non-zero naming the cause when the set is unreadable or when the union is
empty ("no required checks found; refusing"). Otherwise, for the head SHA
it is given, it reports each context as green (every check run and commit
status of that name is `success`, `neutral` or `skipped`), failing,
pending or missing. Whether GitHub also refuses a merge past a red,
pending or missing required check depends on who merges and on the
layout: under 19.3's layout the contexts sit in a checks ruleset with no
bypass actor, so GitHub holds every merger, admin or not (F29, pending its
live test); under classic protection without "include administrators",
or any layout that lists the merging identity as a bypass actor of the
ruleset holding the contexts, GitHub does not hold that identity, and this
read is the only guard. The read refuses early in every case and makes
the decision explicit.

For each context named in `render.checks` it also checks provenance:
every check run of that name on the head (check-runs listing with
`filter=all`) must belong to a workflow run whose `event` is
`pull_request_target` and whose `path` is the managed caller
(`.github/workflows/ship-kit-<seat>.yml`, or the change-class caller); a
same-named check from any other workflow makes the context "forged" and
the script refuses (20.1). Green is judged on `filter=latest`, so a
failure that a later full re-run fixed does not count against the head.
The coverage context is exempt from provenance, since it is PR-controlled
by design (20.1).

`tests/merge/required-checks.test.mjs` runs the script against a fake `gh`
for: classic only, rulesets only, both (union), classic 404 with a ruleset,
both empty, a 403 from either, a pending context, a missing context, a
failed first attempt fixed by a re-run, and a same-named check from a
second workflow.

### 16.4 `/ship-kit:merge <pr>`

Model-invocable. The skill runs `node
${CLAUDE_PLUGIN_ROOT}/scripts/merge/merge.mjs <pr>`, which does all of
the following in order and prints one report line per decision. Nothing
in it changes protection or rulesets.

1. **Refusal list.** Refuse if the PR changes any path that decides how
   later PRs are reviewed or worked on: `.github/**`, `.ship-kit/**`,
   `.claude/**`, `.githooks/**`, any `CLAUDE.md`, and the globs in
   `merge.humanOnlyPaths` of the config at `origin/<default>` (the repo's
   standards). A human merges those (20.1).
2. **Head.** Read the head SHA once (`gh pr view <pr> --json
   headRefOid,mergeStateStatus`) and run 16.3 against it.
   Any context not green, a forged context, or any refusal from 16.3
   stops with the report.
3. **Normal merge.** `merge.mjs` checks step 2's `mergeStateStatus`
   itself rather than relying on gh's client-side refusal (F26): `BEHIND`
   goes to step 4; any state other than `CLEAN`, `HAS_HOOKS` or
   `UNSTABLE` stops with the report. Otherwise `agent-policy.mjs` (5.4),
   then `gh pr merge <pr> --<merge.method> --match-head-commit <sha>`.
   GitHub refuses the merge if the head moved after step 2, and that
   refusal stops with the report. Success goes to step 5.
4. **Admin merge**, only when step 2's state is `BEHIND` and all of these
   hold; otherwise stop with the report:
   - `mergeStateStatus` is `BEHIND`: the only refusal is that the branch
     is not up to date with the base under a strict rule. `BLOCKED`
     (reviews, code-owner review, a failing check, other rules) is never
     bypassed;
   - every required context is green on `<sha>` (step 2, re-run now);
   - the default branch has no classic branch protection (16.3's classic
     read returned 404): with classic protection an admin either cannot
     merge (`enforce_admins` on) or bypasses every classic rule including
     reviews and checks (`enforce_admins` off), so admin merge is
     unavailable and the skill reports "admin merge unavailable under
     classic protection; move the rules to rulesets (19.3)" and stops;
   - the up-to-date ruleset of 19.3 exists, identified as the ruleset
     named `ship-kit up-to-date` targeting the default branch (otherwise
     nothing grants the bypass and the skill reports that and stops);
   - `agent-policy.mjs --admin` prints `proceed`.
   Then `gh pr merge <pr> --<merge.method> --admin --match-head-commit
   <sha>`. Under 19.3's layout the admin identity bypasses only the
   up-to-date ruleset; the checks ruleset and the review ruleset have no
   bypass actor, so GitHub itself refuses an admin merge past a red,
   pending or missing check or missing code-owner review (F29, pending its
   live test). If GitHub refuses the admin call for any reason (the
   identity is not a bypass actor, its token lacks the permission, a
   check changed), the skill reports GitHub's message and stops; it never
   retries or tries another route. On success the report says `MERGED
   WITH ADMIN BYPASS (branch was behind base): <pr> at <sha>`, and the
   skill repeats it.
5. On success, arm `watch-merge-deploy.sh` with the merge commit's full
   SHA.

These checks are the skill's contract (5.4); the GitHub-side limits are
19.3's ruleset layout, whose scope F29's live test confirms, and which
identities hold admin. `tests/merge/merge.test.mjs` runs
`merge.mjs` against a fake `gh` and covers: each refusal-list path, a
`merge.humanOnlyPaths` glob, a red, pending, missing and forged context,
the `--match-head-commit` argument on both calls, a head that moved, an
admin attempt under `BLOCKED`, under classic protection, without the
up-to-date ruleset, with `adminMerge` false and absent, a GitHub refusal
of the admin call (reported, no retry), and the admin report line; `tests/hooks/admin-tripwire.test.mjs` covers `gh pr merge --admin`,
`gh -R x pr merge --admin`, `gh api -X PUT .../protection/enforce_admins`,
`gh api --method DELETE .../protection`, a ruleset `PUT`, `gh api -X PUT .../pulls/7/merge`, and read-only
`gh api` calls that must pass.

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
| DESIGN | design-doc PRs' state markers (structured findings with severity and RESOLVED/UNRESOLVED dispositions) and their review comments | repo `review.huntLists.design` |

`scripts/mining/collect.mjs --target code|design --since <date> --list
<path>` writes the evidence to the session scratchpad, decoding state
markers with `scripts/lib/state-marker.mjs`. In release 1 `--list` is
required and every marker is labelled "unverified" in the evidence. From
release 2 `--list` defaults to the config's `review.huntLists.<target>` at
`origin/<default>` (read with `config.mjs`), and markers are kept only
when `trustState` (8.2) accepts them. It paginates every API call, stops on the first failed
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
text; describe incidents in the repo's own words. In release 1 the skill
writes the proposed list as a diff in the scratchpad and prints it; it
never commits, so it needs no agent setting. From release 2 the change is
a PR to the adopting repo, committed and pushed under 5.4; because seats
read lists from the default branch (9.2), the PR is reviewed by the list
it replaces and takes effect after merge.

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
   `ship-kit/setup` otherwise), and a release pin (step 2).
2. **Resolve the pin**: `cli.mjs` reads `version` from the running
   plugin's `plugin.json` and runs `git ls-remote
   https://github.com/dacrowlah/ship-kit 'refs/tags/ship-kit--v<version>*'`,
   taking the peeled commit of `ship-kit--v<version>` as `shipKit.sha`. It
   then fetches that commit into a temporary bare repository and compares
   the running plugin's `templates/`, `schemas/` and
   `scripts/setup/migrations/` file by file (`git hash-object` against
   `git ls-tree -r`). A missing tag or any difference refuses, naming the
   tag or the first differing path: a plugin installed from the default
   branch or a `--plugin-dir` checkout mid-release carries templates no
   tag has, and would render callers that call a workflow that does not
   exist at the pinned SHA. `tests/setup/pin.test.mjs` points the resolver
   at a local fixture repository and covers: tag present and matching,
   tag missing, tag present with a differing template, and an annotated
   versus a lightweight tag.
3. **Detect**: lockfiles and manifests (to propose preflight steps and a
   coverage tool), existing workflow `runs-on` labels, existing secret
   names (`gh secret list`, names only), `core.hooksPath`, the default
   branch, required checks from both rulesets and classic protection
   (16.3's reader), whether the repo is public, whether `.claude/` is
   ignored (`git check-ignore`).
4. **Ask** for every config key the detection could not settle (5.1's
   per-repo list), including "Allow agents to commit and push without
   asking?" (default yes, stored as `agents.commitAndPush`) and, as its
   own question after it, "Allow agents to admin-merge a PR when every
   required check is green on its head and the only thing GitHub refuses
   is that the branch is not up to date?" (default no, stored as
   `agents.adminMerge`) (5.4, 16.4). Both are explained as instructions
   the skills follow, not as access control (5.4).
5. **Render** everything into a staging dir under the git dir: config,
   callers, preflight, pre-push, seed hunt lists, CLAUDE.md block, coverage
   block, `.claude/settings.json` merge, `.gitignore` negations.
6. **Show a diff** of every file against the working tree; write only on
   approval.
7. **Validate**: config against the schema; the rendered YAML with
   `actionlint` when present.
8. **Print the manual steps**, and offer each as a separately approved
   action (20.1 says why each matters):
   - add the auth secret;
   - on a public repo, add an Actions event policy that allows
     `pull_request_target` (F19); without it the callers never run and the
     required contexts stay pending, which blocks merging;
   - set the fork-PR workflow approval policy to require approval for all
     outside contributors;
   - add CODEOWNERS lines for every path in 16.4's refusal list, and
     require code-owner review;
   - create the override and false-positive labels;
   - protect the default branch with branch rulesets, recommended over
     classic protection (PR 2.5 offers the checks and review rulesets;
     PR 6.2 adds the up-to-date ruleset and the offer to migrate classic
     protection):
     - **checks**: the `required_status_checks` rule with the required
       contexts (6.6), strict up-to-date policy **off**, no bypass actor;
     - **review**: the pull-request rule (approvals, code-owner review)
       and any other rules, no bypass actor;
     - **up-to-date**, only when the repo wants the strict policy: the
       same contexts with strict **on**. It has the repository admin role
       as a bypass actor in `pull_request` mode (F26) only when
       `agents.adminMerge` is true, and no bypass actor otherwise. Setup
       names it `ship-kit up-to-date` (16.4 looks it up by that name).
     Because no ruleset holding the contexts or the reviews has a bypass
     actor, bypassing the up-to-date ruleset skips only the up-to-date
     requirement (F29, whose live test gates release 2; if it fails,
     setup never adds the bypass, still creates the ruleset when the repo
     wants the strict policy, and admin merge is unavailable). A
     maintainer who keeps classic protection keeps normal agent merges;
     admin merge is then unavailable (16.4). A maintainer who adds a
     bypass actor to the checks or review ruleset widens what GitHub lets
     that identity skip, and an agent using that identity's credential is
     then held back only by the skill (5.4); setup says so;
   - optionally run agents as a separate identity that is not a
     repository admin and has write access only (for example a machine
     account or GitHub App): GitHub then stops that identity, whatever the
     agent does, from bypassing any ruleset or editing protection, and
     `agents.adminMerge` does nothing for it. It still has write access,
     which with the default `review.override.minPermission` of `write` lets
     it post maintainer approvals and overrides (6.3, 11.3), so pair it
     with `minPermission: "maintain"`. A fine-grained token of the
     maintainer's own admin account is not a substitute: whether such a
     token without the Administration permission can still use its
     user's role bypass is undocumented;
   - in an organization on GitHub Enterprise Cloud, the option of an
     organization ruleset that requires the callers as workflows (F20).

Setup never commits or pushes. Because callers run from the default
branch (F18), the callers a setup or update PR adds or changes first run on
the PRs opened after it merges; the setup PR itself is reviewed by
whatever was already there, and required contexts, shadow seats
included, are added only after each caller has run once (6.6, 23.1 M3).

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

Update resolves the pin as in 19.3 step 2, runs config migrations by
`schemaVersion`, and rewrites every caller pin, `shipKit` and the
`settings.json` ref to that release. When the migration changes
`schemaVersion` and the user keeps any managed caller ("keep mine" or a
`.ship-kit-new` file), update writes nothing and says which caller blocks
it, since an old workflow cannot read a newer schema (5.2). The upgrade PR
is reviewed by the callers and config already on the default branch
(6.5), so it cannot be blocked by the release it installs.

"unrendered" means the stamp's body hash matches the file but differs from
a fresh render of the stamp's version with the current config.

`/ship-kit:setup check` (and `cli.mjs check`, exit 1 on any state but
current) also fails when any caller's pinned SHA differs from
`config.shipKit.sha`, reports whether the default branch still has
classic protection when `agents.adminMerge` is true (16.4), and
compares the installed plugin version with `config.shipKit.version`, so a
contributor on an older local plugin learns it. It suits a scheduled CI
job.

### 19.6 CLAUDE.md workflow block

`templates/blocks/claude-md-workflow.md`, inserted as a managed block:
start every change with `/ship-kit:develop`; test code follows the same
design rules as production code; every change carries a test proving the
behavior it claims, and a claimed guard is proven with a mutation; run
preflight before push; fix review findings in the same PR; plans are
sequences of deployable PRs; design docs state the current design only;
the hook bootstrap line and the folder-trust note; a fill-in for the
repo's model-tier guidance.

---

## 20. Security model

### 20.1 Trust boundary

**Invariant.** Everything that can decide a required ship-kit verdict, or
shape how a seat behaves, comes from one of two trusted sources, both
fixed before any PR content is read:

- **T1, the adopting repo's default branch at `TRUSTED_SHA`** (6.3): the
  caller files, their `uses:` pins and rendered gate scripts, the config,
  the repo hunt lists, `CLAUDE.md` and the standards it names.
- **T2, ship-kit at `job.workflow_sha`**, the release a T1 caller pins:
  the scripts, seat skills, contract and shared hunt lists; every
  third-party action SHA; `PLUGINS_OFFICIAL_SHA`, and through it the
  superpowers commit (F24).

The PR head supplies data only: the diff, the files under `pr/`, the title
and body, and comments whose authority comes from the commenter's
permission (11). Prior review states count only when bound to a T1 caller's
run (8.2). No byte from the PR is executed, loaded as settings, hooks,
plugins, skills, MCP configuration or `CLAUDE.md`, or written to a path a
trusted instruction names. A gate's result comes only from the gate job
of a T1 caller, reading outputs of T2 jobs.

**Enforcement.** Each route by which a PR could reach its own review, and
what closes it:

| Route | Closed by | Section | Pinned by |
|---|---|---|---|
| Edit the caller, its gate or its pin | callers run on `pull_request_target`, so GitHub runs the default branch's copy (F18); `review.yml` refuses other events except the canary | 6.3, 6.5 | `tests/setup/render.test.mjs` (trigger); `tests/workflows/review-yml.test.mjs` |
| Edit the config, a hunt list or a standard | read with `git show` at `TRUSTED_SHA` | 5.3, 9.2 | `tests/review/plan.test.mjs` |
| Commit files where the seat looks (a planted hunt list or contract) | the review directory, ship-kit and its dependencies live under `$RUNNER_TEMP`, recreated before writing; the PR tree is extracted there as data | 6.3 | `tests/review/plan.test.mjs` with a PR fixture that commits `.pr-review/hunt/x.md` and `review/contract/output.md`, asserting neither is read |
| Project settings, hooks, MCP servers or `CLAUDE.md` in the seat session | the workspace root is T1; the action also restores those paths from the base (F22); `--setting-sources user`, `disableAllHooks`, `--disallowedTools "mcp__*"` | 6.3 | `tests/workflows/review-yml.test.mjs`; canary (F23) |
| Tools beyond reading, and reads beyond the review | `--tools "Read,Grep,Glob,TodoWrite"`, `--permission-mode dontAsk`, no Bash, no MCP; reads confined to the workspace, `review/` and `pr/`, with `.git/`, `/proc` and named credential paths denied; symlinks in `pr/` written as placeholders | 6.3 | canary asserts the tool list, the permitted reads and each refused read |
| Expression interpolation of PR-influenced text into a shell | no `run:` body contains `${{`; values pass through `env:` | 6.3 | `tests/workflows/no-expression-in-run.test.mjs` |
| Prompt injection with the job's secrets present | seats run only for a same-repository PR by a writer, or a head a maintainer approved; seats hold a read-only token and cannot post; aggregate posts only rendered-inert structured output and withholds credential-shaped text | 6.3 | `tests/review/plan.test.mjs` (author rule), `tests/review/aggregate.test.mjs` (rendering, withholding) |
| Dependency versions and their hooks | local marketplaces at `job.workflow_sha` and `PLUGINS_OFFICIAL_SHA`; hooks disabled | 7.2 | canary records the superpowers `sha` and asserts no hook ran |
| A seat that never loaded its skill, or loaded another version | `contract_nonce` and a `skill_marker` token that exists only in the skill text, checked by aggregate against `src/`; expected values never in a seat-readable directory | 6.4 | `tests/review/aggregate.test.mjs`; `tests/workflows/review-yml.test.mjs`; canary negative control |
| Forged state markers (scope, promotion, mining) | `trustState` binds a marker to a T1 caller's run and its artifact | 8.2 | `tests/review/design-doc-mode.test.mjs` |
| Overrides, rebuttals and maintainer approvals | commenter permission, binding to the full 40-hex head SHA by equality; rebuttals are data | 6.3, 11 | `tests/review/override.test.mjs`, `tests/review/plan.test.mjs` |
| An agent merging a forged green, or a PR that changes review inputs | provenance check; the refusal list for normal and admin merges; admin only past a `BEHIND` state (the skill's contract, 5.4); GitHub-side, only the up-to-date ruleset has a bypass actor, so checks and reviews hold for every merger (19.3, F29) | 16.3, 16.4, 19.3 | `tests/merge/required-checks.test.mjs`, `tests/merge/merge.test.mjs`, `tests/live/ruleset-bypass.md` |

The release-tag check (6.3 plan step 2) is not on this list: the pin it
checks already comes from T1.

**Residual risk.** Stated plainly, with its mitigation:

1. **A same-named check.** Required checks match by name and source app,
   and every Actions job reports under the same app (F21). A PR that adds
   a workflow, or edits any `pull_request` workflow, can create a job
   named like a required ship-kit context. Which of two same-named check
   runs GitHub evaluates is undocumented (F21), so this design assumes the
   forged one can satisfy the requirement. The only platform mechanism
   that pins a required check to a specific workflow file, the ruleset
   rule "Require workflows to pass", is available only to organization
   rulesets on Enterprise Cloud (F20); a personal-account repository
   cannot have a PR-proof required check. The strongest available
   combination, which setup offers (19.3 step 8): CODEOWNERS on `.github/`
   with required code-owner review, so a new or edited workflow needs an
   owner's approval; fork-PR workflow approval for all outside
   contributors, so a maintainer sees a fork's workflow before it runs;
   `/ship-kit:merge` refusing a forged context and any PR on its refusal
   list (16.3, 16.4); and the genuine run's summary
   comment, which shows the real verdict beside the forged check. What
   remains: a writer who can approve their own workflow change, or a
   human merging by hand without reading the checks, can merge a forged
   green. The review gates defend against honest mistakes, agents, and
   outside contributors; they do not stop a writer who sets out to bypass
   them, and the README says so.
2. **Coverage is PR-controlled.** The coverage gate runs in the PR's copy
   of the test workflow and measures code the PR supplies (12.2), so a PR
   can change what it reports. It guards honest mistakes only.
3. **Prompt injection in seats.** Seats read PR-authored text while the
   Claude auth secret is in the action step's environment. The
   author rule (6.3 plan step 3) keeps a fork PR, or a PR by someone
   without write access, away from seats until a maintainer approves its
   full head SHA and sends the next event by reopening the PR
   (`needs-maintainer` fails the gate closed meanwhile); the action's own
   check is on the event's sender, so it alone would not (F22). A seat
   that is steered anyway has no shell, no MCP or write tool, a read-only
   job token, and reads confined to its working directories, away from
   `.git/`, `/proc`, the rest of `$HOME` and the rest of `$RUNNER_TEMP`
   (F28); its only output is structured JSON,
   which aggregate renders inert and withholds when it resembles a
   credential. What remains: a PR from a writer, or one a maintainer
   approved, can still steer a seat's verdict text, which is why the gate
   is one input to a human merge decision and not the only one.
4. **Agents with the maintainer's credential.** An agent using the
   maintainer's own `gh` login can do anything that login can, including
   editing rulesets; the agent settings (5.4) are instructions it
   follows, and the tripwire hook (13.5) catches only the common direct
   commands. Even then, 19.3's layout keeps GitHub refusing any merge,
   by anyone, past a red, pending or missing required check or missing
   code-owner review (F29), because no ruleset holding those has a bypass
   actor; what the maintainer's login can still do is edit the rulesets.
   Running agents as a separate non-admin identity (19.3) removes that
   too.

### 20.2 Untrusted inputs to seats

Prior findings, rebuttals, the PR title and body, the files under `pr/`,
and hunt-list text are data. `review/contract/untrusted-data.md` tells
seats to treat each as a claim to check, never as an instruction.

### 20.3 Tokens

Each job's token and secrets are listed in 6.3 ("Secrets by job"). The
caller grants at most contents read, pull-requests write, issues read and
actions read, and nothing can raise it (F3); only aggregate holds
pull-requests write, and only the seat's action step holds the Claude
secret. Under `pull_request_target` a token can write for fork PRs too
(F18), which is why no job executes PR content (20.1). Passing
`github_token` skips the action's app-token exchange (F6): comments post
as `github-actions[bot]` (R15), and no bot login ever authorizes an
override, rebuttal or maintainer approval (6.3, 11).

### 20.4 Local

Hooks and scripts run as the user outside the sandbox (CLAUDE.md,
Security). Both hook scripts are scoped by `if` rules and only deny. No script sends
data anywhere except `gh` calls to the repository's own GitHub API, and
the README lists every hook and script with what it does. Agents commit,
push and normally merge without asking unless a repo sets
`agents.commitAndPush` to false, and use the admin-merge path only when a
repo sets `agents.adminMerge` to true (5.4, 16.4). Both are instructions
the skills follow; GitHub-side rulesets and the agent's identity are the
boundary (20.1).

### 20.5 Secrets in ship-kit itself

Per CLAUDE.md, Secrets: templates and reusable workflows reference a
credential only as `${{ secrets.NAME }}` or `${{ inputs.NAME }}`, never
with a default; the workflow token is written `${{ secrets.GITHUB_TOKEN }}`
(F16) so it satisfies `scripts/check-template-secrets.mjs` as written;
every secret `NAME` a template needs (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`, under whatever name `render.auth.secret` gives) is
documented in the README and in the caller's header comment; examples use
obviously fake placeholders. `secret-scan.yml` runs gitleaks over full
history and the template check on every PR and push to main, and its
`gitleaks` check is required on ship-kit's main. Every PR in 22 that adds a
template or reusable workflow must pass it.

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
  `PATH`), `tests/setup/*.test.mjs`, `tests/promote/*.test.mjs`,
  `tests/merge/*.test.mjs` (16.3, 16.4), `tests/hooks/admin-tripwire.test.mjs`,
  `tests/skills/marker.test.mjs` (6.4), `tests/workflows/review-yml.test.mjs` (6.3).
- Every test named for a guard is proven able to fail: its PR description
  names the mutation applied and the red run (`proving-tests-can-fail`).

### 21.2 Plugin validation (`ci.yml`)

- `claude plugin validate --strict .`
- `claude --plugin-dir . plugin details ship-kit`, compared by
  `tests/inventory.test.mjs` against `tests/expected-inventory.txt` (no
  `bin/`, no unexpected hook).
- `actionlint` over `.github/workflows/` and every rendered caller from
  21.3's fixtures.
- `secret-scan.yml`'s `gitleaks` job (gitleaks plus
  `node --test scripts/*.test.mjs` plus `scripts/check-template-secrets.mjs`),
  a required check on main (20.5). ship-kit's required checks on main are
  `gitleaks`, the `ci.yml` job, and the two dogfood review gates (21.4).
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
any write; the rendered callers pass `actionlint`; the pin resolution cases
in 19.3 step 2; an update that migrates the schema while a caller is kept
writes nothing.

### 21.4 Live workflow dogfood

ship-kit's own repo carries its config (`.ship-kit/config.json`: spec dir
`docs/design/`, plan dir `docs/plans/`, general and adversarial
`required`) and an adopter-shaped `.claude/settings.json` that declares the
`ship-kit` marketplace at `ref: ship-kit--v0.1.0` (F25). That file also
enables ship-kit 0.1.0 in maintainers' own sessions in the repository
once they trust the folder, which is the adopter experience ship-kit
dogfoods; a maintainer testing unreleased skills uses `--plugin-dir .`.
It runs:

- **Required callers** (`ship-kit-general.yml`, `ship-kit-adversarial.yml`)
  on `pull_request_target`, calling `review.yml` at the latest release SHA
  with the tag check on. A PR to ship-kit is reviewed by the released
  workflow and the default branch's callers, never by its own copies
  (20.1, with the residual risk stated there).
- **The canary** (`ship-kit-canary.yml`, not required) on `pull_request`,
  calling `./.github/workflows/review.yml` from the PR's merge commit with
  `canary: true`. `review.yml` honours `canary` only when
  `job.workflow_repository == github.repository` (6.3), which no adopting
  repo satisfies, so it is not a setting an adopter can turn on. It proves
  a changed workflow runs end to end before release, and each run asserts:
  plan's author rule read the canary PR author's permission and ran the
  seats (F27); the seat session's tool list is exactly the `--tools` set
  (F23); every read the fixture PR asks for outside the
  review is refused (F28); no hook ran (F24); the superpowers `sha`
  recorded in `run.json` is the one `PLUGINS_OFFICIAL_SHA` pins (F15); the
  seats return the expected `skill_marker` despite the settings fixture
  (F25); and a second matrix entry whose prompt omits the slash command
  ends `fail-coverage` (F13, 6.4).

The canary runs on PR 2.4 itself: its caller is added by that PR (a
`pull_request` run uses the PR's copy of a new workflow, F4), and the
config and settings fixture it reads are on the default branch from PR
2.1. F13, F15, F23, F25, F27 and F28 are settled by the first canary run
that passes these assertions, and release 2 is not tagged before it
(22.8). ship-kit is public, so the canary cannot show the private-repo
fetch; 22.8 adds a private-repo check.

Cross-owner behaviour is not tested before release (R16); it stays
UNVERIFIED as F17, which names what would test it.

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
setup renders only from a plugin whose templates match a release tag
(19.3 step 2), callers pin that tag's SHA, and `review.yml` re-checks the
pin (6.3 plan step 2), so no untagged commit reaches an adopting repo's CI
even when a contributor's plugin was installed from the default branch. Tags are created with
`claude plugin tag --push` after the owner approves (CLAUDE.md,
Versioning and releases). `plugin.json` `version` is bumped in the last PR
of each release. Model tiers: S = smallest, M = middle, L = largest.
While ship-kit is 0.x, a breaking change bumps the minor version.

### 22.1 Release 1 (0.1.0): skeleton, dependency, skills including mining

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 1.1 | `ci.yml` (21.1, 21.2 gates), `scripts/lib/{glob,stamp}.mjs` with tests, README hook/script inventory and secrets section; CLAUDE.md amendments: the gerund naming rule applies to every skill except the five named command skills (R13, scoped as in 4.1); the side-effect rule becomes "a skill that commits, pushes or normally merges must honour the repo's `agents.commitAndPush` setting; an admin merge is only taken by `/ship-kit:merge` under `agents.adminMerge`, and both settings are a behavioural contract, not access control; setup and any release or tag command stay `disable-model-invocation`" (R14, R17), stated as a prerequisite for the release-2 settings it names; the `${CLAUDE_PLUGIN_ROOT}` rule replaced with F8's verified behavior | no user-visible component | M | 1 |
| 1.2 | `reviewing-design-documents` + `pattern-method.md`, `review/hunt-lists/design-shared.md`, `planning-deployable-pr-sequences`, `proving-tests-can-fail`, with pressure tests | skills only, read-only | L | 2 |
| 1.3 | `watching-pr-checks` + `scripts/watch/*` + fake-`gh` tests | read-only scripts | S | 2 |
| 1.4 | `mining-defect-shapes` + `hunt-list-format.md` + `review/hunt-lists/code-shared.md` (METHOD only) + `scripts/lib/state-marker.mjs` (codec) + `scripts/mining/collect.mjs` (`--list` required, markers labelled unverified, 18.1) + tests; version 0.1.0 | reads APIs, writes the scratchpad only, never commits (18.3); depends on nothing later | L | 3 |

### 22.2 Release 2 (0.2.0): gate, general and adversarial workflows, design-doc mode, setup

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 2.1 | `schemas/config.schema.json` (incl. `agents.commitAndPush`, `agents.adminMerge`, `merge.humanOnlyPaths`), `scripts/lib/{schema,config}.mjs` with in-memory migration (5.2), tests; ship-kit's own `.ship-kit/config.json` and the adopter-shaped `.claude/settings.json` (21.4) | library, no consumer yet; the config is read only by the canary added in 2.4; the settings file enables the released 0.1.0 plugin in maintainers' sessions, which is read-only skills | M | 1 |
| 2.2 | `scripts/review/{review-mode,plan,aggregate}.mjs` ported and generalized (trusted-SHA inputs, `$RUNNER_TEMP` layout, nonce and marker checks, `trustState`), suites ported | scripts not yet called by any workflow | M | 2 |
| 2.3 | `reviewing-for-correctness`, `hunting-defect-shapes` (each with its `skill_marker` line), `review/contract/*`, `tests/skills/marker.test.mjs` | dmi skills, invisible until named | L | 2 |
| 2.4 | `.github/workflows/review.yml` (6.3), `templates/callers/review.yml`, `templates/blocks/gate-step.sh`, gate test, `review-yml` test, ship-kit's canary caller; passes `check-template-secrets` | untagged; only ship-kit's non-required canary calls it | L | 3 |
| 2.5 | `skills/setup` + `scripts/setup/*` (pin resolution, install, check, update, settings merge, gitignore, both agent questions, the manual steps in 19.3 with the checks and review rulesets and no bypass actor) + `scripts/lib/agent-policy.mjs` (incl. `--admin`) + `scripts/merge/required-checks.mjs` (used by detection) + CLAUDE.md block template + fixture tests | writes only after a shown diff; refuses an untagged plugin | M | 4 |
| 2.6 | `promoting-shadow-checks` + `scripts/promote/shadow-record.mjs`; mining gains config-derived list paths, `trustState` filtering and its commit/PR step under 5.4 (18.1, 18.3); version 0.2.0 | proposes PRs under 5.4, whose code landed in 2.5 | S | 5 |

After the 0.2.0 tag: on ship-kit, an admin adds the Actions event policy
allowing `pull_request_target` (F19), then one PR adds the required
callers at the 0.2.0 SHA; migration 23 begins once a PR opened after that
one merged shows both required contexts green (the adding PR itself runs
only the callers already on the default branch).

### 22.3 Release 3 (0.3.0): preflight, `/ship`, `/develop`

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 3.1 | `templates/files/{preflight.mjs,pre-push}`, receipt, verify-push, setup renders them | setup-installed only on update | M | 1 |
| 3.2 | `hooks/hooks.json` + `deny-hook-bypass.mjs` + tests + live-match record (F10) | only denies | S | 1 |
| 3.3 | `classify.mjs` + `/ship-kit:develop` | read-only | M | 1 |
| 3.4 | `local-seats.mjs`, `plan.mjs --local`, `aggregate.mjs --local`, `/ship-kit:ship`, pressure tests incl. the ask path; version 0.3.0 | pushes only through the pre-push receipt and 5.4 | L | 2 |

### 22.4 Release 4 (0.4.0): coverage gate

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 4.1 | `lcov.mjs`, `patch-coverage.mjs`, tests incl. the absent-file case | library | M | 1 |
| 4.2 | `patch-coverage.yml`, coverage block template with the `pull_request` job conditions (12.2), setup support (shadow); passes `check-template-secrets` | untagged until release; installs shadow; a push to the default branch skips both jobs | M | 2 |
| 4.3 | `baseline.mjs`, `measuring-coverage-baseline`, promotion support; version 0.4.0 | proposes a PR | S | 3 |

### 22.5 Release 5 (0.5.0): extra seats, finding contract, override

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 5.1 | full-mode `findings[]` with `failure_scenario` (additive schema; outputs unchanged), `resolving-review-findings` | additive | M | 1 |
| 5.2 | `reviewing-security`, `reviewing-test-integrity`, setup offers their callers in shadow | dmi, shadow | L | 2 |
| 5.3 | `override.mjs`, rebuttals, plan and aggregate support | inert without the label and comment | M | 2 |
| 5.4 | `change-class.yml`, `change-class-check.mjs`, caller template; passes `check-template-secrets`; version 0.5.0 | optional, installs shadow | M | 3 |

### 22.6 Release 6 (1.0.0): `/ci-watch` and merge

| PR | Content | Safe alone because | Tier | Wave |
|---|---|---|---|---|
| 6.1 | `/ship-kit:ci-watch` + pressure tests incl. the ask path and full re-runs (6.5) | capped, never merges, pushes under 5.4 | L | 1 |
| 6.2 | `/ship-kit:merge`, `scripts/merge/merge.mjs`, `admin-tripwire.mjs` and its `hooks.json` entry, setup's up-to-date ruleset (bypass only under `agents.adminMerge`) and classic-to-ruleset migration offer, `tests/merge/*`, `tests/hooks/admin-tripwire.test.mjs`; version 1.0.0 | normal merges only of green, provenance-checked PRs under 5.4; the admin step needs `agents.adminMerge` true (default false), a `BEHIND` state, no classic protection, and a bypass GitHub itself grants; nothing changes protection | M | 1 |

### 22.7 Why this order

Release 2 is the first an adopting repo installs, and it delivers the
required dual review the owner already runs. Release 3 makes every later
seat runnable locally the day it ships. Coverage comes before extra seats
because it is deterministic and cheaper to trust.

### 22.8 Per-release checklist

CLAUDE.md's pre-release checklist, plus: every UNVERIFIED row in 2 that the
release depends on is settled, except F14 and F17, which stay UNVERIFIED by
design and by ruling (R16); for release 2 that means a canary run (21.4)
passing on the release PR, and a run in a private repository owned by
the same account (a scratch repository, or the first adopting repo on a
branch) whose caller pins the release candidate by an owner-approved
pre-release tag `ship-kit--v<version>-rc.<n>`, which the tag check
accepts; its plan and seats must fetch the PR head and produce receipts,
and a PR opened by a read-only collaborator must go from
`needs-maintainer` to green after an approval comment and a maintainer's
close and reopen (F21);
the live ruleset test `tests/live/ruleset-bypass.md` (F29) recorded with
its four expected outcomes; and `gitleaks` is green on the release
commit.

### 22.9 Implementation notes

Open points that change no mechanism above, keyed to the PR that carries
each:

- PR 1.1: the release checklist recommends a tag-protection ruleset for
  `ship-kit--v*`, since a moved or deleted tag turns every adopter's plan
  to `fail-config`.
- PR 2.1: give `specDirs` and `planDirs` a schema `pattern` requiring a
  trailing `/`, so a prefix cannot admit `docs/design-notes.sh`.
- PR 2.2: the round-count hint (8.4) counts distinct `head` values, not
  states, so two seats do not double the count.
- PR 2.2, 2.6: `ship-kit-state` artifacts expire with the repository's
  artifact retention; `trustState` then rejects older markers, which costs
  a full review or a shorter promotion record, and the skills say so.
- PR 2.4: render `secrets` and `permissions` for a local boot workflow,
  and have setup warn when a public repo's callers use self-hosted
  runners, which must be ephemeral under `pull_request_target` (F18).
- PR 2.4: the canary fixture PR also plants `.claude/skills/`,
  `.claude/commands/`, `.claude/agents/` and a `CLAUDE.md` under `pr/`, and
  asserts none of them loaded (they would only through the `project`
  source, which `--setting-sources user` excludes).
- PR 2.5: the CLAUDE.md block renders only lines whose feature exists in
  the installing version; the README documents the Dependabot path (no
  secrets, so gates fail closed) and settles F12 with a recorded live
  install rather than the fixture.
- PR 2.5: the README reconciles R5 with the adversarial seat installing in
  shadow (R6).
- PR 2.5: add a platform fact for the repository Actions policies endpoint
  (it answers for a personal-account public repo; creating a policy there
  is unverified), and have `setup check` read it on public repos so a
  missing `pull_request_target` allowance is reported before
  2026-11-02.
- PR 2.6: promotion counts a run as clean only when it passed or a human
  marked its findings confirmed, and counts the trusted state whose `head`
  is the PR's final head; full mode writes the marker too.
- PR 2.2: `extract-tree.mjs` refuses tree entries with `..`, absolute
  paths or `.git` components, and renames `.ignore`/`.rgignore` files so
  they cannot hide files from Grep and Glob, listing them in `scope.txt`.
- PR 2.4: build the fetch header with `node` (or `base64 | tr -d '\n'`),
  since `base64 -w0` is GNU-only and `runners` allows macOS labels.
- PR 2.4: the receipt reads the action's `execution_file` or a written
  file rather than one environment string, which Linux caps at 128 KiB;
  the receipt artifact holds the raw seat body, which aggregate alone
  renders.
- PR 2.4: aggregate checks each inline finding's `file`/`line` against
  the diff hunks and folds the rest into the summary, since one
  out-of-diff comment rejects the whole review; seat prose is rendered
  inside a fenced block so links and images do not render under the bot.
- PR 6.2: `merge.mjs` lists PR files through the paginated REST endpoint
  and refuses when the listing is truncated, with a more-than-100-files
  test.
- PR 2.4: pin the `review-yml` deny-ancestor test to the hosted runner
  layout and to one self-hosted layout, since it evaluates `~` and `./`
  where `ci.yml` runs.
- PR 2.5: when setup lacks permission to create rulesets, or the plan
  offers none, it reports GitHub's refusal and prints the ruleset JSON for
  an admin to apply; 16.3 already refuses every merge while no required
  check exists.
- PR 2.5: consider an `agents.identity` login that plan refuses as an
  approver, overrider or sender, as an alternative to raising
  `minPermission`.
- PR 2.2: match approvals as a whole trimmed one-line issue-comment body,
  `^/ship-kit-review ([0-9a-f]{40})$`, lower-cased; review bodies and
  review comments do not count; test a quoted or multi-line body.
- PR 2.2: the `needs-maintainer` text names convert-to-draft then
  ready-for-review as the alternative for a PR that cannot be reopened.
- PR 6.2: before the admin call, `merge.mjs` reads every ruleset on the
  default branch and refuses unless `ship-kit up-to-date` is the only one
  with a bypass actor.
- PR 3.1: setup writes `.githooks/pre-push` as mode 100755 and the fixture
  test checks the staged mode.
- PR 3.2: the hook script parses `git -C <dir>` and `-c core.hooksPath=`
  forms; the README states the routes the guard does not cover.
- PR 3.4: each `/ship` restart counts as an iteration.
- PR 4.2: the manual steps list uploading LCOV artifacts from the repo's
  test jobs and an organization's allowed-workflows policy.
- PR 5.1: 11.1 names the fields each mode carries and from which release.
- PR 5.2: a shadow seat whose plan crashes must not block PRs; add shadow
  gates to protection only on promotion, or emit `enforced=false` from the
  rendered mode.
- PR 5.3: add a platform fact for reading a commenter's permission with
  the job's `GITHUB_TOKEN`, settled before overrides ship.
- PR 5.4: define the change-class state marker that promotion counts.

---

## 23. Migrating the adopting repos

### 23.1 The first adopting repo

It runs hand-built general and adversarial workflows with a shared matrix
engine, self-hosted runners behind a boot workflow, its code hunt list
inside the adversarial prompt, and a design hunt list in a repo skill.

| Step | Change (a PR in that repo unless noted) | Exit criterion |
|---|---|---|
| M1 | `/ship-kit:setup` at 0.2.0: config with its runner labels and `bootWorkflow`, its spec and plan dirs, new check names (defaults), both seats `required`; its code shapes moved to `.ship-kit/hunt-lists/code.md` as `R` ids and its design list reduced to repo-only shapes (the 20 generic ones now come from the plugin); the manual steps in 19.3 step 8 except adding required contexts | on the first PR after M1 merges, the new checks run beside the old; branch protection unchanged |
| M2 | Observe | 5 consecutive PRs where the new gate's verdict matches the old, or differs in a way the owner judges correct |
| M3 | Branch protection or ruleset (admin action, not a PR): add the new contexts and remove the old in one change | `required-checks.mjs` (16.3) reads back only the new names |
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
| D1 prose-specified executable | Config, caller, gate script, coverage block and hooks are given as text; the gate script, config and hooks JSON were run or parsed (5.1, 6.5, 13.5). `review.yml` is specified as steps with exact seat arguments and a test that parses the file (6.3); script behavior is specified as contracts that tests pin (21.1). |
| D2 derived number without its model | The coverage threshold carries its model (12.4); the round-count hint states its source (8.4); config defaults are marked as carried values with nothing derived from them (5.1). |
| D3 twin left behind | Each fact has one site: platform facts in 2, severity rule in `design-doc.md` (8.3 is marked a brief), gate script in one fragment (6.5), schema in one file (5.2), preflight code in one file (4.5). |
| D4 summary contradicts detail | Section 3's summary cites 5.3, 7 and 15.3 rather than restating them. |
| D5 enumeration at fewer sites | The seat list appears in 6.2 (input values), 10.1, 4.1 and 5.1 (`checks`); all four name the same four seats. Status values in 6.2 match 6.3 and 11.3. |
| D6 vendor page, wrong version | Action behavior is cited to the v1.0.236 source (F5 to F7), not its README. |
| D7 check that cannot fail for its claim | The gate test runs the rendered script (6.5); guard tests are mutation-proven (21.1); a seat that did not load its skill fails `skill_marker` (6.4); the release-tag check is not counted as a trust control, since its pin already comes from the default branch (20.1). |
| D8 repository fact assumed | Facts about the first adopting repo are described generically and were read from its main branch; ship-kit facts cite CLAUDE.md sections. |
| D9 stale provenance | The only provenance claims are "was run" or "parses" statements in 5.1, 6.5 and 13.5, each re-run against the current text. |
| D10 test stated three times | Each test is named once, at the mechanism it pins; 1 and 21 point to files. |
| D11 mutation that cannot redden | No mutation is specified with fixture values here; 17.3 and 21.1 require the red run be observed. |
| D12 interface frozen against its dependency | The plugin-load design is fitted to the action's URL regex (F5), its default setting sources and config restore (F22), and the self-pin to F1's context; the one unresolved interaction (F25) fails closed. |
| D13 rulings by accretion | Rulings in 1 are quotes with pointers; consequences live in mechanism sections. |
| D14 fix-round residue | Mechanisms appear once, in current terms; no text describes an earlier design. |
| D15 unreported stall | Every non-convergence ends in a report: `/ship` (15.2 step 3), `/ci-watch` (16.1 step 4), empty checks (16.2), baseline with too few PRs (12.4). |
| D16 time-order dependence | Overrides bind to a head SHA and read labels live (11.3); rebuttals and overrides need a run whose plan runs again, and the gate says so (6.5); review base is chosen by ancestry, not comment order (8.2); merges bind to the verified head (16.4). |
| D17 guard that admits a state | Gate states enumerated and tested (6.5); strict defaults for absent or invalid config (5.3); unknown severity is BLOCKING (8.3); an empty or unreadable required-check set refuses (16.3); a missing agent setting is `ask` or `refuse` (5.4); coverage jobs skip on non-PR events rather than fail (12.2). |
| D18 declared cost that is not | Costs stated are only relative (the change-class workflow is cheap; side-by-side doubles review for a bounded window). |
| D19 standard departed silently | Each departure from CLAUDE.md is amended in PR 1.1 with its reason: the naming rule (R13), the side-effect rule (R14), the plugin-root rule (F8). |
| D20 history in the specification | None; no changelog or version narrative. |

### 24.2 Against CLAUDE.md

| Rule (CLAUDE.md section) | Where honored |
|---|---|
| Skills under 500 lines; references one level deep (Skills) | 4.1, 21.2 size gate |
| Always-loaded skills under ~200 words; others under ~500 (Skills) | no skill loads every turn; seat skills 10.1 |
| Descriptions are triggering conditions only (Skills) | 21.2 description gate; authoring rule in each skill PR |
| Gerund names (Skills), as amended by PR 1.1 | every non-command skill complies; the five command skills are exempt by name (R13) |
| Cross-reference by name, no `@` links (Skills) | 14.3 |
| Side-effect skills honour `agents.commitAndPush` (admin merges `agents.adminMerge`); setup and release/tag commands dmi (Skills), as amended by PR 1.1 | 4.1, 5.4, 16.4 |
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
| No committed secrets; credentials only as `${{ secrets.NAME }}`/`${{ inputs.NAME }}`; every NAME documented; fake placeholders (Secrets) | 20.5 |
| gitleaks and template check on every PR (Secrets) | 20.5, 21.2 |

