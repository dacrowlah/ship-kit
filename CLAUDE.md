# ship-kit: maintainer manual

Claude Code does NOT load a plugin-root CLAUDE.md for plugin consumers. This file
guides humans and agents working on ship-kit itself only; it ships in the repo
but has no runtime effect on installers.

ship-kit is a public, MIT-licensed Claude Code plugin + marketplace
(github.com/dacrowlah/ship-kit). It bundles review/shipping skills, slash
commands, hooks, helper scripts, reusable GitHub Actions workflows, and thin
caller templates that `/ship-kit:setup` installs into adopting repos. It
declares `superpowers` (claude-plugins-official) as a dependency.

---

## Binding authoring and publishing rules

### Skills

- Keep every skill under 500 lines; split heavy reference material (100+
  lines) into sibling files linked one level deep from SKILL.md, not nested
  further (nested references only get partial `head`-style previews).
  (https://code.claude.com/docs/en/skills)
- Keep a skill that loads into every conversation (hook-fired, getting-started)
  under ~150-200 words; other skills under ~500 words. Move flag/option
  documentation to `--help` output, not the SKILL.md body.
  (https://code.claude.com/docs/en/skills; superpowers writing-skills SKILL.md)
- Write every skill `description` as third-person triggering conditions only.
  Never summarize the skill's steps in the description: agents follow the
  summary and skip steps the body enforces. Combined description +
  `when_to_use` is capped at 1,536 characters in the skill listing.
  (https://code.claude.com/docs/en/skills; superpowers writing-skills SKILL.md)
- Name skills in gerund form (`writing-skills`, `condition-based-waiting`),
  letters/numbers/hyphens only. The rule applies to every skill except a
  command skill, meaning one whose documented entry point is
  `/ship-kit:<name>`. The command skills are exactly `setup`, `develop`,
  `ship`, `ci-watch` and `merge`; they keep the owner's imperative names
  whether or not they are also model-invocable.
  `tests/skills/naming.test.mjs` enforces both halves.
  (superpowers writing-skills SKILL.md; design section 1, R13)
- Cross-reference other skills by name only (`**REQUIRED SUB-SKILL:** Use
  x:y`), never with `@`-links, which force-load the whole file immediately.
  (superpowers writing-skills SKILL.md)
- A skill that commits, pushes or normally merges must honour the repo's
  `agents.commitAndPush` setting; an admin merge is only taken by
  `/ship-kit:merge` under `agents.adminMerge`, and both settings are a
  behavioural contract, not access control. Setup and any release or tag
  command stay `disable-model-invocation: true`. Both settings are defined
  by the config schema that ships in release 2; this rule is its
  prerequisite, and until that schema exists no skill in this repository
  commits, pushes or merges. (design section 1, R14 and R17; section 5.4)
- Author discipline-enforcing skills with TDD-for-skills: RED (run a pressure
  scenario without the skill, record verbatim rationalizations), GREEN (write
  the minimal skill addressing exactly those failures), REFACTOR (close each
  loophole explicitly). Use a prohibition + rationalization table + red-flags
  list for rules an agent knows and skips under pressure; use a positive
  recipe/contract (no prohibitions) for rules that just produce
  wrong-shaped output, since prohibitions measurably backfire there. No
  nuance clauses ("don't X unless...").
  (superpowers writing-skills SKILL.md; testing-skills-with-subagents.md)
- One excellent example beats many; never implement an example in multiple
  languages. (superpowers writing-skills SKILL.md)

### Commands

- A ship-kit slash command is a skill (`SKILL.md`), never the legacy
  `.claude/commands/*.md` format, which lacks supporting files, `paths`
  auto-trigger, and plugin namespacing.
  (https://code.claude.com/docs/en/skills)
- Plugin skills are namespaced `/ship-kit:<name>`; do not assume the short
  form resolves for a consumer who has another plugin with a colliding name.
  (https://code.claude.com/docs/en/skills)

### Hooks and scripts

- Scope every bundled hook narrowly with an `if` permission-rule matcher
  (specific tool + specific args pattern), never fire on every
  PreToolUse/PostToolUse event. (https://code.claude.com/docs/en/hooks)
- Use exec form (`command` + `args`, no shell interpolation) for anything
  touching a path, not shell form. (https://code.claude.com/docs/en/hooks)
- Default to `exit 0` + JSON decision output over a hard `exit 2` block;
  reserve `exit 2` for genuinely destructive actions.
  (https://code.claude.com/docs/en/hooks)
- Allowlist HTTP hook headers explicitly via `allowedEnvVars`; never leave
  them open. (https://code.claude.com/docs/en/hooks)
- Do not ship a top-level `bin/` directory: it is auto-added to the Bash
  tool's PATH (unneeded trust surface) and claude.ai org-sync rejects plugins
  that have one. Put executables under `scripts/`.
  (https://code.claude.com/docs/en/plugins/security;
  https://code.claude.com/docs/en/plugins/host-marketplace)
- Keep every bundled script's executable bit and invoke it through its
  interpreter in skill prose (`bash scripts/x.sh`), never a bare path: some
  plugin packagers strip the executable bit.
  (superpowers writing-skills SKILL.md)
- SKILL.md content substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`
  (plugin skills only) and `${CLAUDE_PROJECT_DIR}`. Skill prose names a
  bundled script or file as `${CLAUDE_PLUGIN_ROOT}/<path>` and runs scripts
  through their interpreter (`node ${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs`).
  `disable-model-invocation: true` removes a skill from Claude's context
  listing and leaves it user-invocable.
  (https://code.claude.com/docs/en/skills, verified 2026-09-28)

### Manifests and naming

- Set `plugin.json`'s `name` once and treat it permanent: renaming it breaks
  every existing install. Use `displayName` for any later relabel.
  (https://code.claude.com/docs/en/plugins/manifest-reference;
  https://code.claude.com/docs/en/plugins/publish)
- If a rename is ever unavoidable, add a `renames` entry in
  `marketplace.json` rather than deleting the old name outright.
  (https://code.claude.com/docs/en/plugins/host-marketplace)
- Never set `version` in both `plugin.json` and the marketplace entry;
  `claude plugin validate` flags the mismatch and the `plugin.json` value
  silently wins. (https://code.claude.com/docs/en/plugins/publish)
- `marketplace.json`'s plugin entry `name` must equal the plugin's own
  manifest `name`. (https://code.claude.com/docs/en/plugin-marketplaces)
- Add `claude-plugins-official` (superpowers' home marketplace) to
  ship-kit's own `allowCrossMarketplaceDependenciesOn` in
  `marketplace.json` -- without it the declared superpowers dependency
  install is refused. (Already set; keep it set.)
  (https://code.claude.com/docs/en/plugins/dependencies)

### Versioning and releases

- Bump `version` in `plugin.json` on every release, or omit it entirely so
  Claude Code tracks the commit SHA. A `version` that is set and never bumped
  makes `claude plugin update` report "already at latest" incorrectly.
  (https://code.claude.com/docs/en/plugins/host-marketplace)
- Tag every release consumers might pin against as `ship-kit--v<version>` via
  `claude plugin tag --push`, which also validates version agreement between
  `plugin.json` and the marketplace entry first.
  (https://code.claude.com/docs/en/plugins/dependencies)
- Declare the superpowers dependency with an explicit semver range (not a
  bare name) once ship-kit has shipped against more than one superpowers
  minor version, so a future superpowers rename or breaking change does not
  silently break ship-kit installs.
  (https://code.claude.com/docs/en/plugins/dependencies)
- Treat these as breaking for ship-kit's own skills/commands, requiring a
  major version bump: renaming a skill/command's invocable name, changing
  its `arguments`/`argument-hint` contract, changing what a bundled script
  writes to disk or its exit-code contract, changing a workflow template's
  required secrets/inputs, changing a reusable workflow's inputs/outputs,
  and changing a required-check name a caller depends on.
  (https://code.claude.com/docs/en/plugins/publish;
  https://code.claude.com/docs/en/plugins/dependencies)
- There is no deprecation state in `marketplace.json`. Plan any future
  skill/command removal as: drop the entry, add a `renames` mapping to
  `null` or a successor name, and consider `forceRemoveDeletedPlugins: true`
  if the old skill must be actively uninstalled rather than left dangling.
  (https://code.claude.com/docs/en/plugins/host-marketplace)

### Workflow templates

- Ship every GitHub Actions workflow template that `/ship-kit:setup` copies
  into an adopting repo as a thin caller
  (`uses: dacrowlah/ship-kit/.github/workflows/<name>.yml@<tag-or-sha>`)
  around a centrally maintained reusable workflow, rather than fully
  inlining the pipeline into the copied file. This keeps bug fixes
  centralized without requiring adopting repos to run an update tool.
  (https://docs.github.com/en/actions/sharing-automations/reusing-workflows;
  GitHub starter-workflows guidance)
- Pin any `uses:` reference inside a thin caller to a commit SHA (safest) or
  a release tag, never a moving branch.
  (https://docs.github.com/en/actions/sharing-automations/reusing-workflows)
- Where a copied file cannot be a pure `uses:` caller and must be fully
  inlined, stamp it with a version comment and give `/ship-kit:setup` an
  idempotent re-run / diff mode analogous to `cruft check`/`cruft update`,
  since plain one-time copying has no update story by design. (github.com/
  cruft/cruft; copier project rationale)
- There is no first-class Claude Code mechanism to ship GitHub Actions
  workflows; a skill or command must copy templates into `.github/` itself.
  (verified against code.claude.com/docs/en/plugins, 2026-09-28)
- Reference required secrets in a copied template as `${{ secrets.NAME }}`
  placeholders and document each required repo/org secret in the template's
  header comment; never bake credentials into a template.

### Security

- Command hooks run outside the sandbox, as raw shell, with full user
  privileges -- the highest-risk plugin component. Scope, review, and
  document them accordingly.
  (https://code.claude.com/docs/en/plugins/security)
- Document in the README/homepage, in plain language, exactly what every
  hook and script does and why: the built-in trust-warning UI directs
  reviewing users to "each plugin's homepage" as the source of truth
  Anthropic itself does not vet beyond directory-submission checks.
  (https://code.claude.com/docs/en/plugins/security)
- Never have a hook or script silently phone home.
  (https://code.claude.com/docs/en/plugins/security)
- `archive`-sourced marketplace entries can be integrity-pinned with a
  `sha256` digest; use it if ship-kit ever ships via an archive source.
  (https://code.claude.com/docs/en/plugins/security)

#### Secrets

- Never commit a secret, token, key, real account ID, internal hostname, or
  personal email address in any file, fixture, or example, anywhere in the
  repo. This applies equally to code, tests, docs, and workflow templates.
- A workflow template references a credential only as
  `${{ secrets.NAME }}` (or `${{ inputs.NAME }}` for a value the caller
  passes through). Document every `NAME` the template needs in the README.
  A template never carries a default value for a credential-shaped input.
- Every example uses an obviously fake placeholder (for example
  `sk-ant-EXAMPLE`, not a string shaped like a real key) so the scanner
  below doesn't need an allowlist entry to tolerate it.
- `.github/workflows/secret-scan.yml` runs gitleaks (full history, pinned
  version, checksum-verified) plus `scripts/check-template-secrets.mjs`
  (flags a hardcoded value on a credential-shaped `with:`/`env:` key in
  anything under `templates/`, `workflows/`, or `.github/workflows/`) on
  every pull request and every push to main.
- If a secret is ever pushed anyway: rotate it first, then purge it from
  history. Rotating before purging matters because the exposed value stays
  live (and thus dangerous) for as long as it's both in history and valid;
  purging first without rotating just hides the leak while it's still
  usable.
- Run the same checks locally before pushing:
  `docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:v8.30.1 git . --config .gitleaks.toml --redact` and
  `node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"`.

### Testing and validation

- Run `claude plugin validate --strict .` (the marketplace manifest) in CI
  on every push; `--strict` fails CI on warnings such as a missing
  description. Validate the plugin itself with
  `claude plugin validate --json .claude-plugin/plugin.json` and fail on
  every error and every warning except the one saying the root `CLAUDE.md`
  is not loaded for consumers, which this maintainer manual triggers by
  design. `tests/plugin-validate.test.mjs` runs both.
  (https://code.claude.com/docs/en/plugins/publish)
- Before tagging a release, confirm a fresh `claude --plugin-dir <dir>`
  install actually loads and `claude --plugin-dir <dir> plugin details
  <name>` shows the expected component inventory.
  (https://code.claude.com/docs/en/plugins/publish;
  https://code.claude.com/docs/en/plugins/security)
- When ship-kit's own repo is loaded into CI via
  `anthropics/claude-code-action`, pin both `plugin_marketplaces` (the
  marketplace git URL) and `plugins` (`ship-kit@<marketplace-name>`)
  explicitly rather than relying on defaults, and confirm the marketplace
  repo is reachable non-interactively by the Action's runner.
  (github.com/anthropics/claude-code-action action.yml/docs/usage.md;
  https://code.claude.com/docs/en/plugins/host-marketplace)

### Unverified, check before relying on

- No Anthropic-specific guidance was found for secrets in shipped workflow
  templates beyond general GitHub Actions practice (the rule above is
  general practice, not a sourced Anthropic rule).
- Cross-plugin skill invocation by name (one plugin's skill calling
  another's by name) is not a documented contract; it has only been observed
  to work in practice.

---

## Repo rules (owner-mandated)

- Everything published must be generic: no content, incident examples,
  service names, paths, or ticket numbers from any specific adopting repo.
- Design docs state the current design only. No changelogs or revision
  history in a design doc; git holds history.
- Work ships as a sequence of discrete PRs, each safe to release on its own.
- Semver, with breaking defined exactly as listed under "Versioning and
  releases" above: renamed/removed skill or command, changed command
  arguments, changed config schema, changed reusable-workflow inputs or
  outputs, changed required-check names.
- Release tags: `ship-kit--v<version>`.
- Never push to main or tag a release without the owner's explicit approval.
- Stage files by name (never `git add .` / `-A`). Never `git commit --amend`.
  Never `--no-verify`.
- ASCII punctuation only. No em dashes anywhere in the repo.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Commits and PR bodies carry no session links or other private URLs.

---

## Keeping current

Always verify against the live page, never memory. If a doc has changed,
update the rule in this file in the same PR as the code it affects.

| URL | Governs |
|---|---|
| https://code.claude.com/docs/en/plugins | Plugin structure, manifest overview, context/trust cost |
| https://code.claude.com/docs/en/plugins/manifest-reference | `plugin.json` field reference |
| https://code.claude.com/docs/en/plugins/publish | Release prep, `claude plugin validate`, breaking-change surface |
| https://code.claude.com/docs/en/plugins/dependencies | `dependencies`, version ranges, tag scheme, cross-marketplace allowlist |
| https://code.claude.com/docs/en/plugin-marketplaces | `marketplace.json` schema, `claude plugin validate` |
| https://code.claude.com/docs/en/plugins/host-marketplace | Versioning/update semantics, `renames`, deprecation model |
| https://code.claude.com/docs/en/plugins/security | Hook/MCP/bin trust model, reviewer checklist |
| https://code.claude.com/docs/en/skills | SKILL.md frontmatter, discovery, invocation control, namespacing |
| https://code.claude.com/docs/en/hooks | `hooks/hooks.json` schema, matcher scoping, exec form |
| https://docs.github.com/en/actions/sharing-automations/reusing-workflows | Reusable workflows, `uses:` pinning safety order |
| github.com/anthropics/claude-code-action (action.yml, usage.md) | `plugin_marketplaces` / `plugins` CI inputs |
| github.com/obra/superpowers, local install at `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/writing-skills/` | Skill-authoring rules (writing-skills, testing-skills-with-subagents) |
| github.com/anthropics/claude-plugins-official | Marketplace layout precedent, external-plugin submission path |
| github.com/anthropics/skills | Skill-repo layout precedent |
| github.com/cruft/cruft | Copy-with-update-path precedent for inlined templates |
| https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning | GitHub secret scanning behavior and coverage |
| https://docs.github.com/en/code-security/secret-scanning/enabling-secret-scanning-features/enabling-push-protection-for-a-repository | Push protection setup and behavior |
| https://github.com/gitleaks/gitleaks | gitleaks releases, default ruleset, config schema |

Re-check:

- Before every release.
- When a rule in this file conflicts with observed Claude Code behavior.
- When `superpowers` or `claude-code-action` release a new major version.

---

## Pre-release checklist

1. `claude plugin validate --strict .` passes with no warnings.
2. `claude --plugin-dir . plugin details ship-kit` shows the expected
   component inventory (skills, commands, hooks, scripts) and nothing
   unexpected (no stray `bin/`, no unscoped hooks).
3. A fresh install from a local marketplace path loads cleanly:
   `/plugin marketplace add <local-path>` then `/plugin install
   ship-kit@ship-kit` in a scratch session.
4. `plugin.json` `version` bumped (or intentionally omitted) and does not
   also appear, differently, in `marketplace.json`.
5. Every skill/command/config/workflow-input change since the last release
   classified against the breaking-change list above; version bump matches.
6. README/homepage reflects the current hook and script inventory in plain
   language.
7. Every workflow template copied by `/ship-kit:setup` still resolves its
   `uses:` pin (tag or SHA exists, is not a moving branch).
8. No adopting-repo-specific content (names, paths, ticket numbers,
   incidents) anywhere in the diff.
9. A tag-protection ruleset covers `ship-kit--v*` (in place): a moved or
   deleted release tag breaks every adopter whose callers pin it.
10. `gitleaks` is green on the release commit.
11. Tag the release `ship-kit--v<version>` via `claude plugin tag --push`
    only after the owner approves.
