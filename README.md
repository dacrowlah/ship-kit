# ship-kit

A Claude Code plugin for shipping with review gates: dual CI review (general +
adversarial), design-doc review mode, defect-shape mining, and a local
preflight/ship loop. Built on [superpowers](https://github.com/obra/superpowers).

Status: under construction. The design lives in `docs/design/`.

## Install

```
/plugin marketplace add anthropics/claude-plugins-official
/plugin marketplace add dacrowlah/ship-kit
/plugin install ship-kit@ship-kit
```

Installing ship-kit also installs its declared dependency, `superpowers`,
from the `claude-plugins-official` marketplace. A dependency from another
marketplace resolves only when that marketplace is already added, which is
why the first line adds it; skip it if you have added it before.

## What runs on your machine

Plugin hooks and scripts run as you, outside any sandbox. This section is the
complete inventory of what ships; nothing else runs.

### Hooks

None.

### Scripts

| Path | What it does | Network |
|---|---|---|
| `scripts/lib/` | Libraries imported by the scripts below and by tests; never run on their own. | None |
| `scripts/mining/collect.mjs` | Collects evidence for a defect-shape mining pass: merged PRs since a date with their comments and reviews, commit subjects, a hunt list and its history, and the review state markers in comments (labelled unverified). Writes only to the directory you pass with `--out`; never commits or pushes. | `gh` calls to the current repository's GitHub API |
| `scripts/check-template-secrets.mjs` | Maintainer check run in this repository's CI: fails when a workflow template assigns a literal value to a credential-shaped key. No skill runs it. | None |
| `scripts/assert-test-globs.mjs` | Maintainer check run in this repository's CI before the test suite: fails loudly if a test glob matches zero files, if a `scripts/**` module has no paired test at its conventional path, or if that test, run alone, fails, passes no test or never loads its module. No skill runs it. | None |
| `scripts/watch/watch-pr-checks.sh` | Polls `gh pr checks` for a PR until nothing is pending, then prints one summary line and one line per failed or cancelled check; raises an alarm when no checks appear. | `gh` calls to the current repository's GitHub API |
| `scripts/watch/watch-merge-deploy.sh` | Polls `gh run list` for a full merge-commit SHA until every run completes, then prints one summary line and one line per run that did not succeed; refuses a short SHA. | `gh` calls to the current repository's GitHub API |

No script sends data anywhere except `gh` calls to your repository's own
GitHub API, and each row above says whether its script makes any.

## Secrets

This release needs no secrets and ships no workflow templates. A template
that needs a credential references it only as `${{ secrets.NAME }}`, and
every such `NAME` is listed here in the release that adds it. Examples in
this repository use obviously fake placeholders such as `sk-ant-EXAMPLE`.

## License

MIT
