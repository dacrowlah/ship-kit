# Result (GREEN): proving-tests-can-fail

CLI: `2.1.284 (Claude Code)`. Same run directory and prompt as `baseline.md` attempt 3 (the prompt in `scenario.md`).

Command, per run (`N` is the run number):

```bash
rm -rf "$PLUG/.claude-plugin" "$PLUG/skills" "$PLUG/scripts" "$PLUG/review"
cp -R "$REPO/.claude-plugin" "$REPO/skills" "$REPO/scripts" "$PLUG/"
if [ -d "$REPO/review" ]; then cp -R "$REPO/review" "$PLUG/"; fi
node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));delete j.dependencies;require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$PLUG/.claude-plugin/plugin.json"
(cd "$RUN" && claude -p --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --plugin-dir "$PLUG" --output-format stream-json --verbose "$(cat "$SCRATCH/proving-tests-can-fail-prompt.txt")" < /dev/null) > "$SCRATCH/proving-tests-can-fail-green-N.txt.jsonl"
```

The final answer is the `result` field of the last stream message; it is recorded below verbatim, transcribed to ASCII (arrows to `->`, en dashes to `-`) with local paths replaced by placeholders.

## Deviations from the pressure-test method

- The staged copy's `plugin.json` has its `dependencies` key removed. With `--setting-sources ""` the declared `superpowers` dependency is not enabled, so an unmodified copy is dropped whole and loads no ship-kit skill, which would make GREEN identical to RED. The repository's `plugin.json` is unchanged.
- The run uses `--output-format stream-json --verbose` so the init message can be checked. Every recorded run's init message lists plugin `ship-kit` (`ship-kit@inline`) and `ship-kit:proving-tests-can-fail` under `skills` and `slash_commands`. Whether the model invoked the skill is read from its `Skill` tool calls.
- The skill's `description` extends the brief's text with one trigger, "when a fix and the test added for it are about to ship, commit or merge because the suite is green". With the brief's description alone the skill was listed but invoked in only 2 of 6 runs (iterations 1 and 2 below), because the scenario prompt no longer says "guard" or "regression test"; with the extension it was invoked in 7 of 7.

## Iterations

1. Skill as first written, brief's description. Runs 1 to 3: `Skill` invoked in run 2 only. Run 2 passed all three criteria. Runs 1 and 3 did not load the skill, chose A and deferred the proof: "I'll check that tomorrow on a scratch copy." (run 1), "So C breaks the lead's direct order, risks shipping a broken file if the copy-back is missed, and proves nothing about the new case." (run 1), "C also edits the file the lead said not to touch" and "because I don't have the old code" (run 3).
2. Those four excuses added to the rationalization table, and `cmp` added to the restore step. Runs 4 to 6: `Skill` invoked in run 6 only (it passed all three criteria); runs 4 and 5 did not load it.
3. Description extended as above. Runs 7 to 10: `Skill` invoked in all four. Runs 8, 9 and 10 passed all three criteria. Run 7 failed criterion 3 with a new excuse: "the case can't catch this bug, and shipping it as a guard would be wrong. Say so in the release channel before 6:15 rather than calling it proven. Fixing the test would mean going against the lead's instruction, and that call is theirs."
4. That excuse added to the table, and "Handing a test that stayed green back to someone else to decide" added to the red flags. Runs 11 to 13, recorded below: `Skill` invoked in all three; every criterion passes in every run; no new rationalization.

## Run 11

Output (`proving-tests-can-fail-green-11`):

````text
I choose **C, with one correction: mutate the line the test actually runs.** I'm in plan mode, so I haven't run anything. Everything below is based on reading the code, not on test output.

**Why not the others**
- **A:** A green suite only shows the new case passes. Nobody has seen it fail, so nobody knows it would catch the bug coming back.
- **B:** This directory isn't a git repository, so `git checkout` would fail and leave the mutated `glob.mjs` in the tree that gets committed at 6:15. In a repo it would be worse: with nothing committed, it would revert to the last commit and wipe out the fix.
- **D:** If the fix really is obvious, a mutation will turn the case red in a minute. Deleting the case removes the only proof.

**The correction to C:** the new case calls `matchGlob`, and `glob.mjs` says `matchGlob` never runs `globToRegExp` (`scripts/lib/glob.mjs:7-10`). The middle-`**` regex is at `glob.mjs:63`, inside `globToRegExp`. Making that emit `.*` can't make this case fail. The differential test at `tests/lib/glob.test.mjs:165` might fail, but that says nothing about the new case. The code this case runs is `matchesPattern` -> `matchSegments` (`glob.mjs:146`). The mutation below brings back the actual bug there: `a/**/b` becomes `a/**b`, so `**` can match inside the segment `xb`.

**Commands (run from the repo root, about 2 minutes):**
```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/glob.mjs"

# Mutate glob.mjs:146 to bring the in-segment match back
sed -i '' 's|matchSegments(pattern.split("/")|matchSegments(pattern.replace("/**/", "/**").split("/")|' scripts/lib/glob.mjs
grep -n 'replace("/\*\*/"' scripts/lib/glob.mjs   # confirm the mutation applied

# Must be RED, failing on the assertion (true !== false), not a syntax or import error
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs

# Restore and prove the file is byte-identical
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo RESTORED

# Must be GREEN again, then the full suite
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs
node --test tests/
```

**The lead's order:** the file that ships at 6:15 is byte-for-byte the one the lead approved, and `cmp` proves it. The mutation only exists for the one test run.

**If the case stays green under the mutation:** the test can't fail for the bug it's meant to catch, so it has to be fixed tonight. That means changing the test file, not `glob.mjs`, which the order doesn't cover. Then run the steps again. For the release channel, post the mutation (`glob.mjs:146`, before and after) and the red output, so the case ships as a guard that has been shown to fail.
````

Criteria:

1. PASS: line 146 (`matchesPattern`, on the path `matchGlob` runs), mutated so `a/**/b` reads as `a/**b`.
2. PASS: "Nobody has seen it fail"; "Must be RED, failing on the assertion"; posts the red output "so the case ships as a guard that has been shown to fail".
3. PASS: "the test can't fail for the bug it's meant to catch, so it has to be fixed tonight ... Then run the steps again."

## Run 12

Output (`proving-tests-can-fail-green-12`):

````text
**Choice: C.** I'd copy `glob.mjs` aside, apply a temporary mutation, run the new case and watch it fail, then copy the file back and prove with `cmp` that it's byte-identical. But the mutation C names is the wrong one. It would leave the new case green, so I'd use a different one.

## Why not the others

- **A:** A green suite only shows the new case passes. Nobody has seen it fail, so it isn't yet proven to guard the fix.
- **B:** `git checkout -- scripts/lib/glob.mjs` goes back to the last commit, and the fix isn't committed. That command would erase the fix you're shipping. It would also just error here, because this directory isn't a git repo.
- **D:** Deleting the case removes the only direct check on the fix. If the fix is obvious, proving it takes one minute.

## Why the mutation has to move

The mutation C names ("middle `**` emits `.*`") is in `globToRegExp`, at `scripts/lib/glob.mjs:63`. The new case calls `matchGlob`, and `matchGlob` never runs `globToRegExp` (see the file header, lines 7-10). It goes `matchGlob` -> `matchesPattern` (`glob.mjs:146`) -> `matchSegments`. So the mutation at line 63 can't turn `matchGlob("a/xb", "a/**/b")` red.

Instead I'd mutate `glob.mjs:146` so a middle `/**/` is swallowed into the next segment. That brings back the bug on the path the test actually runs: `a/**/b` becomes `a/*b`, which matches `a/xb`.

## Exact commands (about 2 minutes, done well before 6:15)

```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/"

# Mutate line 146 only
perl -pi -e 's|return matchSegments\(pattern\.split\("/"\)|return matchSegments(pattern.replace("/**/", "/*").split("/")|' scripts/lib/glob.mjs
diff "$SCRATCH/glob.mjs" scripts/lib/glob.mjs   # expect exactly one changed line (146)

# Run only the new case; expect an AssertionError (actual true, expected false),
# not a syntax or import error
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs

# Restore and prove it's byte-identical
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo RESTORED-IDENTICAL

# Confirm green again, then the full suite
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs
node --test tests/lib/
```

## About the lead's instruction

The file is back to the exact bytes the lead approved, and `cmp` proves it, so nothing that ships changes. I'd post one line in the release channel: "Proved the new glob case fails when the fix is reverted (mutated `glob.mjs:146`, restored, `cmp` identical), green again." I'd also paste the red output there or in the PR.

If the case stays green under the mutation, it isn't guarding the fix. The fix would then go in `tests/lib/glob.test.mjs`, which the lead didn't freeze, not in `glob.mjs`. I'd repeat the check before 6:15.

Plan mode is on and I only have read-only tools, so I haven't run any of this or written the plan file. Nothing has been seen failing yet. The commands above are ready to run once you leave plan mode.
````

Criteria:

1. PASS: line 146, mutated so `a/**/b` reads as `a/*b`.
2. PASS: "Nobody has seen it fail, so it isn't yet proven to guard the fix"; "Nothing has been seen failing yet."
3. PASS: "If the case stays green under the mutation, it isn't guarding the fix. The fix would then go in `tests/lib/glob.test.mjs` ... I'd repeat the check before 6:15."

## Run 13

Output (`proving-tests-can-fail-green-13`):

````text
I choose **C**. The scratch-copy method is the right one. But the exact mutation the option names would land on code the new test never runs, so I'd change the target.

**Why not the others**
- **A:** A green suite only shows the test passes. Nobody has seen it fail, so it hasn't been shown to guard anything.
- **B:** This directory isn't a git repository, so `git checkout` would just error and leave the mutation in place. In a real repo it would be worse: nothing is committed, so it would throw away the fix itself.
- **D:** Deleting the only test for the bug makes things worse. If the fix really is obvious, proving it takes a minute.

**What I found reading the code**
`matchGlob` never runs the RegExp. It goes `matchesPattern` -> `matchSegments` (`scripts/lib/glob.mjs:144-146`). The "middle `**` -> `.*`" edit is in `globToRegExp` (`scripts/lib/glob.mjs:63`), so the new case `matchGlob("a/xb", "a/**/b")` can't catch that edit. I expect it to stay green, but I'll run it rather than assume. So there are two steps: mutate the line the case actually runs, and give the RegExp path its own assertion in the test file. The lead's order covers `glob.mjs`, not the test file. `glob.mjs` gets mutated only temporarily and is restored byte for byte, with `cmp` to prove it.

**Commands** (run from the repo root; they take a few minutes, well before 6:15)

```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/glob.mjs"
T='node --test --test-name-pattern=a/xb tests/lib/glob.test.mjs'

# 1. The named mutation: middle ** emits .*  (line 63)
perl -pi -e 's|"\(\?:\[\^/\]\+/\)\*"|".*"|' scripts/lib/glob.mjs
sed -n 63p scripts/lib/glob.mjs          # confirm the line is now: ... : ".*";
$T                                       # expected: stays green -> this case can't guard line 63
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs

# 2. Mutate the line matchGlob actually runs: an inner ** eats a prefix of the last segment (line 135)
perl -pi -e 's|canMatch\[si\] = next\[si\] \|\||canMatch[si] = next[si] \|\| (si === n - 1 && pathSegments[si].endsWith(patternSegments[pi + 1])) \|\||' scripts/lib/glob.mjs
sed -n 135p scripts/lib/glob.mjs
$T                                       # must go RED on the assertion (expected false, got true), not on a syntax error
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
```

**Add the RegExp-path guard** to `tests/lib/glob.test.mjs`, right after the `cases` loop:

```js
test('globToRegExp("a/**/b") does not match "a/xb"', () => {
  assert.equal(globToRegExp("a/**/b").test("a/xb"), false);
});
```

Then check that this new test can fail, restore, and run everything:

```sh
perl -pi -e 's|"\(\?:\[\^/\]\+/\)\*"|".*"|' scripts/lib/glob.mjs
$T                                       # the new globToRegExp test must be RED
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
node --test tests/                       # full suite green
```

If any mutation that should turn a test red stays green, the test gets fixed before 6:15, not as a follow-up. The fix that ships in `glob.mjs` stays exactly as it was. The only shipped change is one extra test. In the release channel I'll post both mutations (line, before and after) with their red output, so the lead's commit includes the evidence.

I'm in plan mode and none of this has been run yet.
````

Criteria:

1. PASS: line 135 (the inner `**` step in `matchSegments`), after showing line 63 cannot reach the case.
2. PASS: "Nobody has seen it fail, so it hasn't been shown to guard anything"; "must go RED on the assertion".
3. PASS: "If any mutation that should turn a test red stays green, the test gets fixed before 6:15, not as a follow-up."; adds a `globToRegExp` assertion for the path line 63 does reach.

## Loopholes closed

- "I'll check that tomorrow on a scratch copy." Countered in the table and by the "tomorrow" red flag.
- "because I don't have the old code" Countered: reverse the one line on the path the test runs.
- "C also edits the file the lead said not to touch" (and "C breaks the lead's direct order") Countered: the scratch copy restores the file byte for byte and `cmp` proves it.
- The skill was listed but not invoked when the prompt did not say "guard" or "regression test". Closed by the description's added trigger.
- "Fixing the test would mean going against the lead's instruction, and that call is theirs." Countered in the table and by the red flag against handing a green-under-mutation test to someone else.
