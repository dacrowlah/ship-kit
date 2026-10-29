# Repository code defect shapes

The adversarial review seat reads this list together with the shared code list on every review. Shape ids start with R. Each instance ends with the commit that held the defect and the commit that fixed it.

Format: see the ship-kit plugin's `skills/mining-defect-shapes/hunt-list-format.md`.

## METHOD

- Treat "inherited from the brief", "not fixable here" and "defence in depth" in an author's report as claims: reproduce the failure, and report it when it can occur.
- Check an API's answer as the identity that will run the code (a non-admin, a fork, a bot token), not only as a maintainer, since the platform can answer them differently.
- Reproduce a recorded pass rate with fresh runs before accepting it; a record that agrees with itself can still describe a run that does not repeat.
- When a finding lists what a fix must cover (files, forms, states), derive the list from the code that produces them; a list written from memory carries its gap into the fix.

## Shapes

### R1. Absent answer read as a negative [generic]

Mechanism: A read that fails, returns nothing or returns a value the code does not recognize is decided as "none", "clean" or the permissive branch, so a broken, empty or misdirected read passes.

Instances:
- Caught in review: CI ran `node --test` over a glob for script tests, and `node --test` exits 0 when a glob matches no file, so deleting the only script test would have left `ci` green (defect b23051d, fix 13341ea).
- Caught in review: the test-pairing gate accepted a paired test file that registered no test at all, so an emptied test still counted as the module's test (defect 77aef74, fix c8b7e3c).
- Caught in review: the GitHub API helper returned a null body as a success for any 2xx answer with an empty body, not only for a 204 (defect 9a0207e, fix fd46a91).
- Caught in review: the design-doc prior check compared severity with the exact word BLOCKING, so a prior with a missing or differently cased severity counted as non-blocking (defect b07797e, fix 93a5d0a).
- Caught in review: a registered template renderer that returned empty text left the expression gate nothing to scan, and the gate passed (defect 524a116, fix 00bc7e1).
- Caught in review: the strict defaults used when the trusted config cannot be read kept `agents.commitAndPush` true, so an unreadable config granted the permissive choice (defect eccfe49, fix 1794ff6).
- Caught in review: the PR-check watcher sent a slash-named base branch unencoded to the protection endpoints and read the resulting 404 as "no required checks" (defect 559b825, fix 95cc7bc).

Look for: a 404, an empty body, an empty list or a glob with no match mapped to "none" or to success; a fallback or `??` default that is the permissive value; a comparison against the one blocking value where the code should compare against the one permissive value; a request path built from an unencoded name whose failure is then read as absence; a status whose meaning depends on who asks (GitHub answers a non-admin 404 for classic branch protection that exists).

Not an instance: an absence the API documents as having exactly one meaning (a 204 with no body) that the code matches by its exact status, or a fallback to the refusing answer.

### R2. Bounded listing read as the whole set [generic]

Mechanism: A listing capped by a page size, a default limit, a sort order or the moment it was taken is treated as complete, so items past the bound are missing from the decision without any error.

Instances:
- Caught in review: the merge-commit watcher called `gh run list` with no `--limit`, so a failed run past the default 20 was never reported (defect 520dadd, fix 7d6a918).
- Caught in review: the PR-check watcher concluded as soon as every check listed at that moment had finished, so a check that registered later was never waited for (defect 520dadd, fix 559b825).
- Caught in review: the mining collector warned about truncation only when the count equalled `--limit`, while `gh pr list --search` stops at 1000 results whatever the limit (defect ca975ef, fix cba64f2).
- Caught in review: the promotion record took its window from `gh pr list --limit N`, which orders by creation, so a PR created before the window and merged inside it was skipped and the streak looked unbroken (defect 8fe47fc, fix 9e0ad43).
- Caught in review: the promotion record read labels from gh's first page of 100, so a PR with 100 labels could hide the false-positive label (defect 8fe47fc, fix 9e0ad43).

Look for: `--limit`, `per_page`, `first:N` or a tool's default page size; a window defined by one key (merge time) and listed by another (creation time); a count compared with `===` against the limit instead of `>=`; "everything is done" computed from what one poll saw; a truncation warning that names the wrong cap.

Not an instance: a listing reconciled against a total the server reports, or against a second query that must agree, and a listing that fails closed when the bound is reached.

### R3. Trusted source reached through a rebindable name [generic]

Mechanism: The code reaches what it trusts (a remote, a ref, a repository, a permission) through a name that repository content, local configuration or another party can bind to something else, so an object they control answers in its place.

Instances:
- Reached main: the default-branch config reader ran `git ls-remote` and `git fetch` on the name `origin`; with no usable origin URL git read the name as a relative path, so a bare repository committed on a branch as `origin/` became the trusted default branch (defect 7029092, fix 49f7e88).
- Caught in review: the same reader resolved `refs/ship-kit/default` with a DWIM `rev-parse`, so a branch or tag of that name could stand in for the fetched ref (defect eccfe49, fix 1794ff6).
- Caught in review: the same reader's fetch ran the checked-out branch's git hooks, and a `reference-transaction` hook could repoint the trusted ref at the branch's own commit (defect eccfe49, fix 1794ff6).
- Caught in review: setup's pin resolution inherited `GIT_*` variables and global git config, so a `GIT_DIR` inherited by a hook in a linked worktree, or a `url.<base>.insteadOf` rewrite, pointed it at a repository other than the one it named (defect c4fb45d, fix d216411).
- Caught in review: the review author rule ranked a collaborator by `role_name` first, so a custom role named like a built-in one ranked above the permission it grants (defect 05ed107, fix 0347927).

Look for: git given a remote name instead of a checked URL; a ref resolved without `show-ref --verify` on its full name; child git processes that inherit `GIT_*` variables, global config, hooks or replace refs; a repository taken from `gh repo view` or gh's `{owner}/{repo}` while the config came from `origin`; a workflow file whose copy a PR into a non-default branch controls; a role, label or display name used as an authority.

Not an instance: a name resolved inside an environment the code built and isolated itself, or one checked against an immutable identifier (a repository id, a full commit SHA) before it is trusted.

### R4. Structured text judged by matching lines [generic]

Mechanism: A property of YAML, Markdown or source code is decided by a line pattern or regex over its text, so forms the format allows but the pattern does not recognize carry content past the check or satisfy it falsely.

Instances:
- Caught in review: the no-expression-in-run gate scanned workflow YAML line by line and missed an expression in a flow-mapping step, under a quoted `"run":` key and behind an alias (defect a70a461, fix ce3b7a8).
- Caught in review: the caller-template change moved templates back to the line scan, reopening the same bypass forms in files that become live workflows (defect 77bd743, fix 524a116).
- Caught in review: the pressure-record gate found code fences and rationalization tables by line patterns, so a backtick info string, a shorter closing fence or an unpiped table row changed which text counted as observed (defect 300664b, fix f4447e9).
- Caught in review: the test-pairing gate took a match of `test(`, `describe(` or `it(` in a test file as proof that it tested its module, which a commented-out or unconnected test satisfies (defect c8b7e3c, fix a645c6a).

Look for: a regex or a split on newlines over YAML, JSON or Markdown where a parser exists; "a line scan is enough here"; fixtures that hold only the common spelling of a key; a text match standing in for parsing or running the thing it describes.

Not an instance: a line scan over text that is line-oriented by definition (a shell fragment, a TSV file) that refuses every line it does not recognize.

### R5. Gate inputs chosen by file-name pattern [generic]

Mechanism: A gate selects the files it checks with a glob or an extension list, so a file outside the pattern (another extension, a dot path, a case variant, a deeper directory) is never checked while the gate reports clean.

Instances:
- Caught in review: the test-pairing gate listed modules with `scripts/*.mjs` and `scripts/lib/*.mjs`, so a module in a subdirectory or with a `.js` or `.cjs` extension needed no test (defect 77aef74, fix c8b7e3c).
- Reached main: the expression gate found templates with `templates/**/*.{yml,yaml}`, which on Linux skips dot paths, upper-case extensions and other names that setup could still install as workflows (defect 9dcdc02, fix 1bc9da0).
- Caught in review: the template secret scan read only listed extensions, so the new `templates/blocks/gitignore.txt` was never scanned (defect 1bc9da0, fix a48ea7f).

Look for: extension allowlists; `*.yml` without `*.yaml`; globs that skip dot entries; case-sensitive matching that differs between Linux CI and a macOS checkout; a one-level `*` where nesting is possible; no test that every file the gate should cover is among its inputs.

Not an instance: a gate whose inputs come from a manifest that a test compares with a recursive listing of the directory, dot entries and every case included.

### R6. Value checked for one grammar, parsed by another [generic]

Mechanism: A value passes a check written for where it is stored, then reaches a consumer that parses it in another grammar (an argument splitter, YAML, an expression language), where it becomes structure: a flag, a new key or a live expression.

Instances:
- Caught in review: the model pattern admitted a leading `--`, and claude-code-action splits `claude_args` so that a value such as `--max-turns` became a flag and `--model` was dropped; the seat model keys already on main shared the pattern (defect 3a2a578, fix b551f28).
- Reached main: the template renderer refused only `\n` in single-line values, so a bare carriage return, which YAML reads as a line break, could start a new key in a rendered workflow (defect b8570b8, fix a48ea7f).
- Reached main: the template renderer accepted `${{` in values, so a config value could become a live expression in a rendered workflow (defect b8570b8, fix 1bc9da0).

Look for: a value placed after a flag inside an argument string that another program splits; a pattern whose first character class admits `-`; a single-line rule that refuses `\n` but not CR, NEL or U+2028; a placeholder inside `${{ }}`, quotes or a flow sequence.

Not an instance: a value passed as its own argv element to a program that does not parse it again, or a value encoded for the consumer's grammar where it is placed.

### R7. Guard no test can redden [generic]

Mechanism: A guard exists or is claimed, but every test reaches its assertion by a route that does not depend on it (a value set directly, an earlier refusal, a fixture with one value), so removing the guard leaves the suite green.

Instances:
- Caught in review: the caller gate's tests set `ALL_SUCCEEDED` directly, so dropping the failure, cancelled or skipped term from the template left every caller test green (defect 77bd743, fix 524a116).
- Caught in review: the test that `baseline` refuses `--any-model` passed because its stream file did not exist, so a `baseline` that honoured the flag stayed green (defect 2a1326f, fix cb1adcc).
- Caught in review: removing the config reader's `GIT_NO_REPLACE_OBJECTS` guard left the suite green, because no test planted a replace ref (defect eccfe49, fix 1794ff6).
- Caught in review: the trusted-state check compared the caller path and the repository exactly, but no test used a case variant or a name sharing the prefix, so looser comparisons survived (defect 0b69c83, fix e598610).
- Caught in review: loosening the auth secret's schema pattern to admit `|` and `.` left every test green, though the value sits inside a `${{ }}` expression (defect 1bc9da0, fix a48ea7f).

Look for: run the mutation of each guard the change adds; tests that inject the value the guarded code would compute; expected-error tests that do not check which error; fixtures with one repository, one model name or one letter case; a PR body claim that no test names.

Not an instance: a weak test that still turns red when the guard is removed.

### R8. Pressure evidence that holds without the skill [repo]

Mechanism: A pressure-test record, or the check that accepts it, rests on evidence that would also exist if the run had not loaded and followed the shipped skill text, so a stale or failing skill keeps a passing record.

Instances:
- Reached main: the proving-tests-can-fail rationalization table quoted prompt text and phrasing no run had produced, which the records gate later refused (defect a9fcded, fix 300664b).
- Caught in review: `check` printed the hash of the repository's skill text, not of the staged copy the run had loaded (defect 566d4a4, fix dc8cca8).
- Caught in review: restaging edited text at the same path let an old GREEN stream pass under the new text's hash (defect dc8cca8, fix e1e2a4b).
- Caught in review: a GREEN run whose reads of the staged plugin were refused still passed `check`, so its hash covered text the run never saw (defect e1e2a4b, fix 66379a7).
- Caught in review: the records gate accepted an excuse quoted from a recorded prompt, or spliced across attempts, as an observed one (defect 300664b, fixes f4447e9 and 618b0f0).
- Caught in review: a record claimed 3 of 3 discriminating criteria from one GREEN run, and three fresh runs under the pinned model passed criterion 1 once (defect 2a1326f, fix cb1adcc).

Look for: a hash, model or quote taken from the repository instead of from the run's own stream; a staged path that stays the same when the staged text changes; tool errors in a GREEN stream that `check` ignores; quotes matched against text that also holds prompts; a headline that rests on one run.

Not an instance: a record whose hash, model and quotes the gate recomputes from the runs' own output, with a pass rate taken over several accepted runs.

### R9. PR-authored review input missing from an untrusted list [repo]

Mechanism: The review directory gains a file whose content the PR author controls, and not every list that tells seats and readers what is untrusted names it.

Instances:
- Caught in review: the contract's untrusted-data file named `pr.txt` and the PR tree but not `diff.patch`, `stat.txt` or `scope.txt`, which carry PR-authored lines and paths (defect a439b89, fix 571a4a1).
- Caught in review: the design's list of places a PR can plant the marker token left out `scope.txt`, which the tree extractor fills with every PR path (defect 1794ff6, fix c11eb62).

Look for: a new file written into the review directory or read by a seat; then search `review/contract/untrusted-data.md`, design 6.4 and 20.2 and the contract test for its name.

Not an instance: a file ship-kit writes only from trusted inputs, such as the pinned contract or the plan's own lines.

### R10. Path guard blind to another filesystem's aliases [generic]

Mechanism: A path check compares names as a POSIX, case-sensitive filesystem would, while the path may be written where trailing dots or spaces, stream syntax, device names or case folding make it an alias of a protected name.

Instances:
- Caught in review: the PR tree extractor refused `.git` and `..` components but not `:` stream syntax or Windows device names, so `.claude::$INDEX_ALLOCATION` could create `.claude` on a Windows runner (defect 862afdb, fix 4028c04).
- Caught in review: setup accepted hunt-list seed paths with a segment ending in a dot, which Windows strips, so `.git./hooks/pre-push` would land in `.git/hooks` (defect 1bc9da0, fix a48ea7f).

Look for: a deny list of names (`.git`, `.github`, `.claude`) compared exactly; no handling of a trailing dot or space, `:`, `<>"|?*`, device names (`CON`, `NUL`, `COM1`) or short names (`GIT~1`); a case-sensitive comparison of paths that can land on a macOS or Windows disk.

Not an instance: a check that admits only a positive character set with no alias form in it, applied to every segment.

### R11. Entry-point check that a symlinked launch defeats [generic]

Mechanism: A script decides it is the program being run by comparing its resolved module URL with the unresolved `process.argv[1]`, so a launch through a symlink, or from a path that needs escaping, runs nothing and exits 0.

Instances:
- Reached main: the mining collector compared `import.meta.url` with `pathToFileURL(process.argv[1]).href`, so, started through a symlinked plugin path, it printed nothing and exited 0 (defect b0e2a39, fix 49f7e88).
- Reached main: the PR tree extractor used the same comparison, so a symlinked launch wrote nothing and exited 0 (defect 2dd9e12, fix 49f7e88).
- Reached main: the version bump tool compared `import.meta.url` with a hand-built `file://` string, which also fails for a path holding a space or a percent sign (defect a2a9d23, fix 49f7e88).

Look for: `import.meta.url ===` against anything built from `process.argv[1]` without `realpathSync`; `resolve(process.argv[1])` compared with the module path; a command whose success is read from exit 0 alone.

Not an instance: a comparison of the real paths of both sides that is false for anything it cannot resolve.

### R12. Integrity hash that leaves out part of what it protects [generic]

Mechanism: A hash meant to detect edits covers only part of the content it vouches for, so an edit to the uncovered part (a header line, a line's position, a referenced file) keeps the old hash valid.

Instances:
- Caught in review: the managed-file stamp hashed only the text after the stamp line, so an edit to a leading shebang read as unmodified (defect 0cc1947, fix 9dcf45f).
- Caught in review: the stamp hash then still ignored where the stamp line sat, so swapping it with the shebang or duplicating it read as unmodified (defect 9dcf45f, fix 9f4bfeb).
- Caught in review: the shipped-text hash for pressure records covered only the Markdown files at the top of the skill directory, so an edit to a file the skill names under `${CLAUDE_PLUGIN_ROOT}` did not force a GREEN rerun (defect 566d4a4, fix dc8cca8).

Look for: a hash over "everything after" a marker, or over a file list built by extension or depth; content the protected file references or includes but the hash does not read; positions and order of lines that the hash input drops.

Not an instance: a hash over a canonical form of the whole content, with only the hash's own value swapped for a fixed placeholder.
