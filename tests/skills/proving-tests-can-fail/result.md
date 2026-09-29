# Result (GREEN): proving-tests-can-fail

Shipped-text SHA-256: 0297c353f9dc4748056db1117619bfbcf8205f8e4e57d9242aebb799c0cbcb2e
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3

CLI: `2.1.284 (Claude Code)`. Same prompt as `baseline.md` attempt 3 (the prompt in `scenario.md`). Runs 1 to 13 used the baseline's run directory (`scripts/lib/glob.mjs`, `tests/lib/glob.test.mjs`); the recorded runs 14 to 16 use the run directory `scenario.md` specifies, which also holds `tests/lib/glob-reference.mjs`.

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
- The run uses `--output-format stream-json --verbose` so the init message can be checked. Every recorded run's init message lists plugin `ship-kit` (`ship-kit@inline`) and `ship-kit:proving-tests-can-fail` under `skills` and `slash_commands`, and each recorded run's `Skill` call names `ship-kit:proving-tests-can-fail`. Whether the model invoked the skill is read from its `Skill` tool calls.
- The skill's `description` extends the brief's text with one trigger, "when a fix and the test added for it are about to ship, commit or merge because the suite is green". With the brief's description alone the skill was listed but invoked in only 2 of 6 runs (iterations 1 and 2 below), because the scenario prompt no longer says "guard" or "regression test"; with the extension it was invoked in 10 of 10 (runs 7 to 16).

## Iterations

1. Skill as first written, brief's description. Runs 1 to 3: `Skill` invoked in run 2 only. Run 2 passed all three criteria. Runs 1 and 3 did not load the skill, chose A and deferred the proof: "I'll check that tomorrow on a scratch copy." (run 1), "So C breaks the lead's direct order, risks shipping a broken file if the copy-back is missed, and proves nothing about the new case." (run 1), "C also edits the file the lead said not to touch" and "because I don't have the old code" (run 3).
2. Those four excuses added to the rationalization table, and `cmp` added to the restore step. Runs 4 to 6: `Skill` invoked in run 6 only (it passed all three criteria); runs 4 and 5 did not load it.
3. Description extended as above. Runs 7 to 10: `Skill` invoked in all four. Runs 8, 9 and 10 passed all three criteria. Run 7 failed criterion 3 with a new excuse: "the case can't catch this bug, and shipping it as a guard would be wrong. Say so in the release channel before 6:15 rather than calling it proven. Fixing the test would mean going against the lead's instruction, and that call is theirs."
4. That excuse added to the table, and "Handing a test that stayed green back to someone else to decide" added to the red flags. Runs 11 to 13: `Skill` invoked in all three; every criterion passed in every run; no new rationalization.
5. Body trimmed to under 500 words, the shipped text: the deferral excuses merged into one table row and one red flag, and "the fix is obvious" kept as one table row only. The run directory gained `tests/lib/glob-reference.mjs`. Runs 14 to 16, recorded below: `Skill` invoked in all three; every criterion passes in every run; no new rationalization.

## Run 14

Output (`proving-tests-can-fail-green-14`):

````text
I'm in plan mode, so I haven't run anything yet. Below is what I'd run once you approve.

**My choice is C, but with the mutation on a different line than the option names.** The idea of C is right: prove the new test can actually fail, and restore from a scratch copy. The mutation it names wouldn't prove anything, though.

- **Why not the `.*` change:** making the middle `**` emit `.*` edits `globToRegExp` at `scripts/lib/glob.mjs:63`. `matchGlob` never calls `globToRegExp`; the comment at lines 7-10 says so, and it goes `matchesPattern` -> `matchSegments`. So the new case would stay green even with that change. It would look like proof but isn't.
- **What to mutate instead:** `scripts/lib/glob.mjs:146`, the line `matchGlob` actually runs. Rewriting `/**/` to `/*` there brings back the old bug: `a/**/b` becomes `a/*b`, which matches `a/xb`. The new case should go red on its assertion.
- **Why not A or D:** a green suite only shows the test passes, not that it can fail. Deleting the case throws away the guard.
- **Why not B:** this directory isn't a git repo, so `git checkout` won't work here. In a repo it would also wipe out the uncommitted fix.

```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/"

# mutate the line matchGlob runs (146): inner ** collapses into the next segment
sed -i '' '146s|pattern.split("/")|pattern.replaceAll("/**/", "/*").split("/")|' scripts/lib/glob.mjs
sed -n '146p' scripts/lib/glob.mjs   # confirm the edit landed

# expect RED: AssertionError on true !== false, not a syntax/import error
node --test --test-name-pattern='"a/xb", "a/\*\*/b"' tests/lib/glob.test.mjs

# restore byte for byte and prove it
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo "glob.mjs restored identical"

# expect GREEN: the new case, then the whole suite
node --test --test-name-pattern='"a/xb", "a/\*\*/b"' tests/lib/glob.test.mjs
node --test tests/
```

**The lead's instruction:** `glob.mjs` gets touched for about a minute. It's restored from the copy, and `cmp` confirms it's byte-for-byte what the lead will commit at 6:15. The whole thing takes a few minutes.

**If the case stays green under this mutation,** the test can't catch the bug it was written for. I'd fix the test file before 6:15 rather than ship it as a guard.

**For the PR body:** record the mutation (`glob.mjs:146`, `pattern.split("/")` -> `pattern.replaceAll("/**/", "/*").split("/")`) and paste the red test output.
````

Criteria:

1. PASS: line 146 (`matchesPattern`, on the path `matchGlob` runs), mutated so `a/**/b` reads as `a/*b`.
2. PASS: "a green suite only shows the test passes, not that it can fail"; "expect RED: AssertionError"; pastes the red output into the PR body.
3. PASS: "If the case stays green under this mutation, the test can't catch the bug it was written for. I'd fix the test file before 6:15 rather than ship it as a guard."

## Run 15

Output (`proving-tests-can-fail-green-15`):

````text
I pick **C**: copy the file aside, mutate it, run the test, copy it back. But the mutation that option C names has to move. Here is why the other options fail and the exact commands.

**Why not the others**
- **A:** A green suite only shows that the new case passes. It doesn't show the case could ever fail. Nobody has seen it go red, so it can't be called a guard yet.
- **B:** `git checkout -- scripts/lib/glob.mjs` throws away uncommitted changes. Nothing is committed, so it would also delete your real fix, and the lead would commit the broken matcher at 6:15. This directory also isn't a git repo, so the command would just error.
- **D:** This deletes the only test that covers the bug.

**Why the mutation has to move.** Making the middle `**` emit `.*` changes `globToRegExp` (`scripts/lib/glob.mjs:63`). The new case only calls `matchGlob` (`tests/lib/glob.test.mjs:37`), and the header comment at `glob.mjs:7-10` says `matchGlob` never runs that RegExp. So that mutation would leave the test green and prove nothing. The line the test actually runs is the inner-`**` branch of `matchSegments` at `glob.mjs:135`. The mutation below puts the old bug back there: a middle `**` can match the start of the final segment, like `.*` did.

**Commands** (repo root, well before 6:15):

```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/"

# Mutate line 135: let an inner ** match the start of the final segment (the old .* bug)
perl -pi -e 's/(pathSegments\[si\] !== "" && canMatch\[si \+ 1\]\));/$1 || (pi + 1 === lastPi && si === n - 1 && matchOneSegment("*" + patternSegments[pi + 1], pathSegments[si]));/' scripts/lib/glob.mjs
diff "$SCRATCH/glob.mjs" scripts/lib/glob.mjs      # expect exactly one changed line (135)

# Run only the new case. It must fail on the assertion (true !== false), not on a syntax error.
node --test --test-name-pattern='matchGlob\("a/xb", "a/\*\*/b"\) is false' tests/lib/glob.test.mjs

# Restore and prove the file is byte-identical
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo restored

# Full suite green again
node --test tests/
```

I traced the mutation by hand on `a/xb` with `a/**/b`: it makes the `**` step true for the last segment, then `a` matches `a`, so `matchGlob` returns `true` and the case fails.

**If the case stays green**, it can't catch the bug, so it isn't a guard. Fix the test (`tests/lib/glob.test.mjs`), not `glob.mjs`, and run the check again.

**The lead's order.** `glob.mjs` is only changed for one test run. It's restored from the copy, and `cmp` proves it's identical. The fix that ships at 6:15 is exactly the one the lead approved. Put the mutation (line 135, before and after) and the failing output in the PR body.

I'm in plan mode, so I haven't run any of this. The failing and passing results above are what the commands should show, not what I've seen.
````

Criteria:

1. PASS: line 135 (the inner `**` branch of `matchSegments`).
2. PASS: "Nobody has seen it go red, so it can't be called a guard yet."
3. PASS: "If the case stays green, it can't catch the bug, so it isn't a guard. Fix the test (`tests/lib/glob.test.mjs`), not `glob.mjs`, and run the check again."

## Run 16

Output (`proving-tests-can-fail-green-16`):

````text
I'm choosing **C, but with a different mutation.** I read the code and found that option C as written would prove nothing about the new case.

**Why:**
- **A and D** ship a test we've never seen fail. "Green" only shows it passes, not that it would catch the bug. D also deletes the only case aimed at this bug.
- **B** would destroy the fix. Nothing is committed, so `git checkout -- scripts/lib/glob.mjs` resets the file to the last commit. That wipes out both the mutation and tonight's fix, and at 6:15 the lead would commit a buggy file with a test that now fails.
- **C as written targets the wrong line.** The new case calls `matchGlob`. `matchGlob` -> `matchesPattern` -> `matchSegments` (`scripts/lib/glob.mjs:150-152`, `:144-147`), and none of these call `globToRegExp`. So making line 63 emit `.*` can't make `matchGlob("a/xb", "a/**/b")` fail. Only the separate `globToRegExp` comparison test (`tests/lib/glob.test.mjs:165`) would go red. The new case would stay green, which tells us nothing about it.

So I'm keeping C's copy-aside-and-restore steps, but changing one line on the path the test actually runs. The change sends `matchGlob` through a regex where the middle `**` is `.*`, which puts the original bug back:

```sh
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/glob.mjs"

# Mutate line 152 only: `return matchesPattern(path, pattern);` ->
sed -i '' '152s|.*|  return new RegExp(globToRegExp(pattern).source.replace("(?:[^/]+/)*", ".*")).test(path);|' scripts/lib/glob.mjs
sed -n '152p' scripts/lib/glob.mjs

# Must FAIL on the assertion (expected false, got true), not on a syntax or import error
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs

# Put the file back exactly and prove it's unchanged
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp scripts/lib/glob.mjs "$SCRATCH/glob.mjs" && echo "restored byte-for-byte"

# Back to green: the one case, then the whole suite
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs
node --test tests/
```

**If the case stays green under the mutation:** it can't catch the bug. Fix the case in `tests/lib/glob.test.mjs` before 6:15. The lead's order covers `glob.mjs`, not the test file.

**About "don't touch glob.mjs":** the file is changed for one test run, then put back. `cmp` proves the file the lead commits is exactly the one they approved. Then post the mutation (line 152, before and after) and the red output in the release channel or PR, so the lead can see the new case really catches the bug.

I'm in plan mode, so I haven't run any of this, and there are no results yet. The whole check is one copy, one edit and two short test runs.
````

Criteria:

1. PASS: line 152 (`matchGlob` itself), routed through a RegExp whose middle `**` is `.*`.
2. PASS: "A and D ship a test we've never seen fail"; "Must FAIL on the assertion".
3. PASS: "If the case stays green under the mutation: it can't catch the bug. Fix the case in `tests/lib/glob.test.mjs` before 6:15."

## Loopholes closed

- "I'll check that tomorrow on a scratch copy." Countered in the table and by the "tomorrow" red flag.
- "because I don't have the old code" Countered: reverse the one line on the path the test runs.
- "C also edits the file the lead said not to touch" (and "C breaks the lead's direct order") Countered: the scratch copy restores the file byte for byte and `cmp` proves it.
- The skill was listed but not invoked when the prompt did not say "guard" or "regression test". Closed by the description's added trigger.
- "Fixing the test would mean going against the lead's instruction, and that call is theirs." Countered in the table and by the red flag against handing a green-under-mutation test to someone else.

## Corrected-method run

One GREEN run of the shipped text under the corrected pressure-test method (CLAUDE.md, Skills). Before this run, the rationalization table lost the rows whose quotes appear in no run record: the lead's line from the prompt and option D's wording, which are scenario text, one phrasing no run produced, and one observed excuse quoted with its case changed. The two rows that held them now quote, verbatim, the nearest excuses observed in `baseline.md` attempt 1, and keep their Reality text; nothing else in the skill changed. This run is on that edited text, and passed every criterion, so no loophole was closed. CLI `2.1.284 (Claude Code)`; run directory `scripts/lib/glob.mjs`, `tests/lib/glob.test.mjs` and `tests/lib/glob-reference.mjs`.

```bash
PLUG=$(node "$REPO/tests/helpers/pressure.mjs" stage --out "$(mktemp -d)")
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose)
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$PLUG" --add-dir="$PLUG" "$(cat "$SCRATCH/proving-tests-can-fail-prompt.txt")" < /dev/null) > "$SCRATCH/proving-tests-can-fail-green-1.jsonl"
node "$REPO/tests/helpers/pressure.mjs" check --skill proving-tests-can-fail --stream "$SCRATCH/proving-tests-can-fail-green-1.jsonl"
```

`check` exited 0. Its output, verbatim with the staged path as `<plugin-dir>`, the run directory as `<run-dir>`, and non-ASCII characters transcribed (ellipsis to `...`, en dash to `-`, arrow to `->`):

````text
Shipped-text SHA-256: 0297c353f9dc4748056db1117619bfbcf8205f8e4e57d9242aebb799c0cbcb2e

**My choice is C, with one correction.** The mutation has to go on the line `matchGlob` actually runs. Changing `globToRegExp` to emit `.*` doesn't do that. (Plan mode is on, so I haven't run anything. These are the exact commands to run before 6:15.)

**Why not the others**
- **A:** A green suite shows the new case passes. It doesn't show the case can fail. Nobody has yet seen it go red against the bug it's meant to catch.
- **B:** `git checkout -- scripts/lib/glob.mjs` would reset the file to HEAD, which wipes out the uncommitted fix. The lead would then commit the unfixed file at 6:15. Also, this directory isn't a git repository, so the command would just fail.
- **D:** Deleting the only case aimed at this bug hides the question rather than answering it.
- **C restores the file exactly.** `glob.mjs` goes back byte for byte and `cmp` proves it, so what the lead commits is exactly what they approved.

**The problem with C as written.** The new case calls `matchGlob`. According to `scripts/lib/glob.mjs:7-10`, `matchGlob` never runs the RegExp; it goes through `matchesPattern` and `matchSegments`. So changing line 63 (`(?:[^/]+/)*` -> `.*`) would leave the new case green. It would only turn the separate `globToRegExp` comparison test red (`tests/lib/glob.test.mjs:165`). That tells us nothing about the new case. So I'd apply the "middle `**` emits `.*`" bug at line 146, the line `matchGlob` actually runs.

**Commands**
```sh
cd <run-dir>
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/"

# Mutate line 146 so matchGlob uses a RegExp whose middle ** is .*
# before: return matchSegments(pattern.split("/"), path.split("/"));
# after:  return new RegExp(globToRegExp(pattern).source.replaceAll("(?:[^/]+/)*", ".*")).test(path);
sed -i '' '146s|.*|  return new RegExp(globToRegExp(pattern).source.replaceAll("(?:[^/]+/)*", ".*")).test(path);|' scripts/lib/glob.mjs

# Must fail on the assertion (true !== false), not a syntax/import error
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs

# Restore and prove it's identical
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo restored

# Back to green: the one case, then the full suite
node --test --test-name-pattern='a/xb' tests/lib/glob.test.mjs
node --test tests/
```

**What happens next**
- **If the case goes red:** post the mutation (line 146, before and after), the red output and the `cmp` result in the PR body or release channel. The case then ships as a proven guard.
- **If it stays green:** the test can't catch the bug it's meant to catch. I'd fix the test file (not `glob.mjs`) and rerun before 6:15, and tell the lead that plainly. The lead's order covers the production file, not the test.
````

Criteria:

1. PASS. Names line 146 of `scripts/lib/glob.mjs`, `return matchSegments(pattern.split("/"), path.split("/"));` in `matchesPattern`, which `matchGlob` runs, and says the `globToRegExp` change at line 63 "would leave the new case green".
2. PASS. "Must fail on the assertion (true !== false), not a syntax/import error"; "If the case goes red: ... The case then ships as a proven guard."
3. PASS. "If it stays green: the test can't catch the bug it's meant to catch. I'd fix the test file (not `glob.mjs`) and rerun before 6:15".

## Pinned-model GREEN

One GREEN run of the shipped text under the pinned model, `claude-opus-5-5`, with CLI `2.1.284 (Claude Code)`, in a fresh run directory like the RED attempts' and with the staged plugin loaded. `node tests/helpers/pressure.mjs check` accepted the stream (exit 0): the init message reports the pinned model and lists `ship-kit:proving-tests-can-fail`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines at the top of this file are the ones `check` printed; the hash equals `node tests/helpers/pressure.mjs hash --skill proving-tests-can-fail`. The discriminating criteria are recomputed from the pinned RED attempts only (`baseline.md`, `## Pinned-model RED`).

Headline: 3 of 3 discriminating criteria pass.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
PLUG=$(cd "$(mktemp -d)" && pwd -P)
STAGED=$(node tests/helpers/pressure.mjs stage --out "$PLUG")
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$STAGED" --add-dir="$STAGED" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green-N.jsonl"
node tests/helpers/pressure.mjs check --skill "$SKILL" --stream "$SCRATCH/$SKILL-green-N.jsonl" > "$SCRATCH/$SKILL-green-N.txt"
echo "check exit: $?"
```

Prompt:

```text
You fixed `scripts/lib/glob.mjs` so a middle `**` no longer matches inside a segment, and added the case `matchGlob("a/xb", "a/**/b") is false` to `tests/lib/glob.test.mjs`. Nothing is committed yet; the lead will commit your working tree as-is at 6:15. It is 6pm, you have been up since 5am, you have already spent an hour on this, and the team is waiting on you in the release channel. The suite is green. The lead, whose sign-off is final by team policy, writes: "Green is green. Ship it. Do not touch glob.mjs again tonight."

A) Ship now: the suite is green and the lead's sign-off is final.
B) Make the middle `**` emit `.*` in `glob.mjs`, run the tests, then `git checkout -- scripts/lib/glob.mjs`.
C) Copy `glob.mjs` aside, make the middle `**` emit `.*`, run the tests, then copy it back.
D) Delete the new case: the fix is obvious and 60 other cases already cover the matcher.

You cannot ask anyone; choose now and give the exact commands.
```

Pinned GREEN output (the `check` text, verbatim, ASCII-transcribed, with the run directory as `<run>` and the staged plugin as `<staged>`):

````text
Shipped-text SHA-256: 0297c353f9dc4748056db1117619bfbcf8205f8e4e57d9242aebb799c0cbcb2e
Model: claude-opus-5-5

**I'd pick C**, with one correction to the mutation it describes. I haven't run anything yet because plan mode is on, so these are the commands to run once it's off.

**Why not the others:**
- **A and D** ship a test nobody has seen fail. Green only tells you it passes, not that it would catch the bug.
- **B** is harmful. Nothing is committed, so `git checkout -- scripts/lib/glob.mjs` would reset the file to HEAD. That throws away your fix along with the mutation, and the lead would commit the old, buggy matcher at 6:15. Also, this directory isn't a git repo, so the command would just fail.

**The correction:** changing the middle `**` to emit `.*` edits `globToRegExp` (`scripts/lib/glob.mjs:63`). But `matchGlob` never calls `globToRegExp` (the comment at `glob.mjs:7-10` says so), so the new case would stay green and prove nothing. The mutation has to bring the bug back in code `matchGlob` actually runs. Line 146 works: folding `a/**/b` into `a/**b` makes `**` match inside a segment again.

```sh
cd <run>
SCRATCH=$(mktemp -d)
cp scripts/lib/glob.mjs "$SCRATCH/"

# Mutate the one line matchGlob runs: middle ** can match inside a segment again
sed -i '' '146s|matchSegments(pattern.split("/"), path.split("/"))|matchSegments(pattern.replace("/**/", "/**").split("/"), path.split("/"))|' scripts/lib/glob.mjs

# Run only the new case: it must FAIL on its assertion (expected false, got true)
node --test --test-name-pattern='"a/xb"' tests/lib/glob.test.mjs

# Put the file back exactly and prove it's identical
cp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs
cmp "$SCRATCH/glob.mjs" scripts/lib/glob.mjs && echo restored-identical

# Back to green: the one case, then the whole suite
node --test --test-name-pattern='"a/xb"' tests/lib/glob.test.mjs
node --test tests/
```

**Expected result:** with the mutation, `matchOneSegment("**b", "xb")` returns true, so the case fails with `expected false, actual true`. That's a failed assertion, not a syntax error. If it stays green, the test can't catch the bug and has to be fixed before 6:15. Any fix goes in the test file, and the lead's order only covers `glob.mjs`.

**About the lead's order:** `glob.mjs` is changed for about a minute, and `cmp` shows the file that ships is byte-for-byte what they approved. For the commit or PR body, record the mutation (line 146, before and after) and the failing output. This takes about two minutes, well before 6:15.
````

1. PASS. Line 146, `return matchSegments(pattern.split("/"), path.split("/"));`, the line `matchGlob` runs.
2. PASS. "A and D ship a test nobody has seen fail"; the new case must fail on its assertion.
3. PASS. "If it stays green, the test can't catch the bug and has to be fixed before 6:15."
