# Live check: does `extraKnownMarketplaces` honour a github source's `ref`?

## What this settles

F12: whether a repo's `.claude/settings.json` can pin the `ship-kit` marketplace
to a specific tag through `extraKnownMarketplaces.<name>.source.ref`, so an
adopting repo's plugin install cannot silently drift onto a later commit.

## Source shape (from the live docs)

code.claude.com/docs/en/plugins/marketplace-reference, "Source objects in
settings" and "github plugin source" (fetched 2026-09-28):

> An `extraKnownMarketplaces` value is a map from marketplace name to an
> object with `source`.
>
> ```json
> {
>   "extraKnownMarketplaces": {
>     "your-marketplace": {
>       "source": {
>         "source": "git",
>         "url": "https://git.example.com/your-org/your-marketplace.git",
>         "ref": "main"
>       }
>     }
>   }
> }
> ```

> `github`, `url`, and `git-subdir` sources share the `ref` and `sha`
> fields:
>
> - **`ref`**: a branch or tag. Defaults to the repository's default
>   branch.
> - **`sha`**: a full 40-character lowercase commit SHA. ... Claude Code
>   checks out `sha` ... installation succeeds even if the branch or tag
>   named by `ref` has since been deleted upstream, as long as the commit
>   is still reachable from the repository.

```json
{
  "name": "formatter",
  "source": {
    "source": "github",
    "repo": "your-org/formatter",
    "ref": "v2.0.0",
    "sha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
  }
}
```

This confirms the design 19.4 shape is a map keyed by marketplace name, each
value `{"source": {"source": "github", "repo": ..., "ref": ...}}`, not the
flat array the settings-reference page's own summary implies; the
marketplace-reference page is the authoritative source for the field's
actual shape and is what this record follows.

## Method

Two fresh, uncommitted git repositories, each with a `.claude/settings.json`
declaring:

```json
{
  "extraKnownMarketplaces": {
    "ship-kit": { "source": { "source": "github", "repo": "dacrowlah/ship-kit", "ref": "<R>" } },
    "claude-plugins-official": { "source": { "source": "github", "repo": "anthropics/claude-plugins-official" } }
  },
  "enabledPlugins": { "ship-kit@ship-kit": true }
}
```

Repository A: `R = ship-kit--v0.1.0` (exists). Repository B:
`R = ship-kit--v0.0.0-missing` (does not exist). `claude-plugins-official`'s
real repo (`anthropics/claude-plugins-official`) doubles as the positive
control: since `extraKnownMarketplaces` only ever takes effect after folder
trust, seeing that marketplace resolve in the same run confirms trust was
not the reason a run showed nothing, before drawing any conclusion from
repository B.

Claude Code CLI 2.1.284. A fresh `CLAUDE_CONFIG_DIR` per repository could not
authenticate (`claude -p` returned `Not logged in - Please run /login`;
no `ANTHROPIC_API_KEY` is set in this environment, and credentials are tied
to the default config directory). Per the fallback the brief allows, the
default config directory was used instead. Because a fresh git repository
is untrusted by default and `-p` does not itself grant that trust for a
security-relevant key like `extraKnownMarketplaces`, each repository's path
was marked trusted the same way accepting the interactive trust prompt
would (`hasTrustDialogAccepted: true` for that path in the config
directory's project map) for the duration of the observation, and removed
afterward.

For each repository: `claude -p "reply ok" --output-format stream-json
--verbose`, `claude plugin marketplace list`, `claude plugin list`, and
(repository A only) `git -C <the ship-kit marketplace clone> rev-parse
HEAD`. `--debug --debug-file <path>` was added to see the marketplace
reconcile and clone steps directly, since neither the session's init
message nor `claude plugin marketplace list` ever reflects a project-scoped
`extraKnownMarketplaces` marketplace or plugin (both only report
user-scope state); the debug log is what shows whether the fetch was
attempted, and with what ref, and whether it succeeded.

A run whose install/update logs show no clone attempt at all for `ship-kit`
before the process exits is inconclusive and was rerun rather than scored,
per the instruction to treat "neither run added the marketplace" as
inconclusive.

## Repository A (`ref = ship-kit--v0.1.0`), redacted

First attempt's debug log (repository trusted, default config directory):

```
[DEBUG] Skipping orphaned enabledPlugins entry ship-kit@ship-kit: marketplace not registered
[DEBUG] [reconcile] 2 marketplace(s): ship-kit(install), claude-plugins-official(update)
[DEBUG] Marketplace checkout probe: no readable HEAD, cloning
[DEBUG] git clone: url=git@github.com:dacrowlah/ship-kit.git ref=ship-kit--v0.1.0 timeout=120000ms
```

A later attempt (after the marketplace's install location had been cleared)
reached completion within the same run:

```
[DEBUG] Marketplace checkout probe: no readable HEAD, cloning
[DEBUG] git clone: url=git@github.com:dacrowlah/ship-kit.git ref=ship-kit--v0.1.0 timeout=120000ms
[DEBUG] git clone succeeded: git@github.com:dacrowlah/ship-kit.git
[DEBUG] Reading marketplace from <config dir>/plugins/marketplaces/ship-kit/.claude-plugin/marketplace.json
[DEBUG] Added marketplace source: ship-kit
[DEBUG] installPluginsForHeadless: installed marketplace ship-kit
```

`git -C <config dir>/plugins/marketplaces/ship-kit rev-parse HEAD` after
that run: `5835a220529882e7ec6a86efd781362c28344f0a`.

`git rev-parse ship-kit--v0.1.0^{commit}` in the real repository:
`5835a220529882e7ec6a86efd781362c28344f0a`.

The two match: the clone made from the `ref` is at the tag's peeled commit.
This was reproduced twice (an earlier attempt at a different, since-renamed
install path landed on the same commit).

`claude -p`'s own init message never lists `ship-kit@ship-kit` as a loaded
plugin in any of these runs: the marketplace reconcile and clone happen
after the plugin-enable check for that same invocation's first turn, so a
single one-shot `-p` run never sees its own newly-fetched marketplace.
`claude plugin marketplace list` and `claude plugin list`, run from inside
the repository, also never show `ship-kit`: both commands report only
user-scope marketplaces and plugins, never a repository's
`extraKnownMarketplaces` entry (registered project-scoped, not written to
the user's `known_marketplaces.json`... except that a successful install
*did* leave a stale entry there afterward, which this record's owner
cleaned up as part of restoring the environment). None of this bears on
whether `ref` is honoured once the fetch actually runs, which the clone's
HEAD settles directly.

## Repository B (`ref = ship-kit--v0.0.0-missing`), redacted

```
[DEBUG] [reconcile] 1 marketplace(s): ship-kit(update)
[DEBUG] Marketplace checkout probe: no readable HEAD, cloning
[DEBUG] git clone: url=git@github.com:dacrowlah/ship-kit.git ref=ship-kit--v0.0.0-missing timeout=120000ms
[WARN] git clone failed: url=git@github.com:dacrowlah/ship-kit.git code=128
       error=... fatal: Remote branch ship-kit--v0.0.0-missing not found in upstream origin
[ERROR] SSH clone failed for dacrowlah/ship-kit: ...
[INFO] SSH clone failed for dacrowlah/ship-kit despite SSH being configured, falling back to HTTPS
[DEBUG] git clone: url=https://github.com/dacrowlah/ship-kit.git ref=ship-kit--v0.0.0-missing timeout=120000ms
[WARN] git clone failed: url=https://github.com/dacrowlah/ship-kit.git code=128
       error=... fatal: Remote branch ship-kit--v0.0.0-missing not found in upstream origin
[ERROR] Failed to clone marketplace repo dacrowlah/ship-kit via HTTPS after SSH fallback: ...
[DEBUG] installPluginsForHeadless: failed to install marketplace ship-kit: ...
[ERROR] [reconcile] failed to update marketplace 'ship-kit': ...
```

Both transports refuse the same way, for the same reason: the ref does not
exist upstream. `claude plugin marketplace list` and `claude plugin list`
from inside repository B show no `ship-kit` entry either (nothing was ever
successfully installed for this repository). The positive control
(`claude-plugins-official`, no `ref`, defaulting to the repository's
default branch) resolved and cloned in the same class of run, so an
untrusted folder or a broken network is ruled out as the explanation for
repository B's failure.

## Verdict

Honoured: the missing ref fails to add or install the marketplace (both
SSH and HTTPS clone attempts refuse with "Remote branch ... not found"),
and the existing ref's clone lands exactly at the tag's peeled commit.

F12 status: `Verified (tests/live/extra-known-marketplaces.md)`.

Per ruling 17, `.claude/settings.json` carries `ref` in the
`extraKnownMarketplaces` entry setup writes (design 19.4's example is
already written this way; no fallback is needed).
