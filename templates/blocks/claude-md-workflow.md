## ship-kit workflow

- [since 0.3.0] Start every change with `/ship-kit:develop`.
- Test code follows the same design rules as production code.
- Every change carries a test proving the behavior it claims, and a claimed guard is proven with a mutation: break the guard, watch the test fail, restore it.
- [since 0.3.0] Run preflight before every push (`node .ship-kit/preflight.mjs`); the pre-push hook refuses a push without a receipt for the commit.
- [since 0.3.0] After cloning, run `git config core.hooksPath .githooks` once so the pre-push hook is active.
- Fix review findings in the same pull request that raised them.
- Plans are sequences of deployable pull requests, each safe to release on its own.
- Design documents state the current design only; history lives in git.
- Contributors must trust this folder in Claude Code before the repository's plugin settings (`.claude/settings.json`) take effect; until they do, the ship-kit skills silently do not load.
- Model tiers: write this repository's guidance on which model tier suits which kind of work beside this block, not inside it, because ship-kit rewrites the block on update.
