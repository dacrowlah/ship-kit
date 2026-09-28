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
| `scripts/check-template-secrets.mjs` | Maintainer check run in this repository's CI: fails when a workflow template assigns a literal value to a credential-shaped key. No skill runs it. | None |
| `scripts/assert-test-globs.mjs` | Maintainer check run in this repository's CI before the test suite: fails loudly if a test glob matches zero files, if a `scripts/**` module has no paired test at its conventional path, or if that test, run alone, fails, passes no test or never loads its module. No skill runs it. | None |

No script sends data anywhere except `gh` calls to your repository's own
GitHub API, and each row above says whether its script makes any.

## Secrets

This release needs no secrets and ships no workflow templates. A template
that needs a credential references it only as `${{ secrets.NAME }}`, and
every such `NAME` is listed here in the release that adds it. Examples in
this repository use obviously fake placeholders such as `sk-ant-EXAMPLE`.

## License

MIT
