# Result (GREEN): converging-code-reviews

Shipped-text SHA-256: 0f2c4e8f2d849824f7e15f5ab5fe1fae1d94f724a599cb91e6db851cfd504e24
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3, 4, 5

CLI version: `2.1.312 (Claude Code)`. Two GREEN runs of the shipped text under the pinned model, each in a fresh run directory like the RED attempts' (`baseline.md`), with the staged plugin loaded and the current `## Prompt` of `scenario.md` (any code review: own changes, an uncommitted diff, a local branch, or a pull request). `node tests/helpers/pressure.mjs check` accepted each stream (exit 0): the init message reports the pinned model and lists `ship-kit:converging-code-reviews`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines above are the ones `check` printed for both runs; the hash equals `node tests/helpers/pressure.mjs hash --skill converging-code-reviews`.

Headline: 5 of 5 discriminating criteria pass, in both runs.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
PLUG=$(cd "$(mktemp -d)" && pwd -P)
STAGED=$(node tests/helpers/pressure.mjs stage --out "$PLUG")
RUN=$(mktemp -d)
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$STAGED" --add-dir="$STAGED" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green-N.jsonl"
node tests/helpers/pressure.mjs check --skill "$SKILL" --stream "$SCRATCH/$SKILL-green-N.jsonl" > "$SCRATCH/$SKILL-green-N.txt"
echo "check exit: $?"
```

## Run 1

`check` exited 0.

Run 1 output, verbatim:

```text
Shipped-text SHA-256: 0f2c4e8f2d849824f7e15f5ab5fe1fae1d94f724a599cb91e6db851cfd504e24
Model: claude-opus-5-5

# Review plan

**What blocks.** A finding blocks only if it causes one of these:
- lost data
- wrong data a user sees on realistic input
- leaked private data, or a cancelled or withdrawn item shown as live
- a crash, or a broken error contract
- a check that cannot fail

Breaking a binding standard blocks only when it lets a wrong result through. Any review rules the repository has add to this list. Everything else is a follow-up: other standards breaches, missing test rows, docs, style and wording. "Realistic input" means input found in recorded or production-shaped data, or the same everyday habit as something that is. Contrived inputs are follow-ups. For each finding I ask: "If this were the last round, would I hold the merge for it?"

**Labels.** Each finding is labelled **regression** (the latest state broke it) or **older** (it was already there). From round two on, a finding blocks if it's a regression, or if it's older and meets the bar on realistic input. If a regression came from a fix I suggested or applied, I'll say so. If an earlier claim of mine turns out wrong, I'll correct it in the next round.

**Checking fixes.** Before I post or keep a fix, I apply it in a scratch copy. I then run both reviewers' full probe tables on the previous state and on the fixed copy. The fix ships with a list of every row it changes. Where possible I'll prefer reverting to an earlier rule plus a documented known miss over widening a pattern. I'll also prefer a missing value over a wrong one. Each rule gets one literal table: rows it must match and rows it must leave alone.

**Re-review scope.** Each round reports every known finding at once. Later rounds cover only the diff since the last round: the fix and the code around it, not the whole change.

**If rounds aren't converging.** I record the blocking count each round. If it isn't shrinking, I stop and raise it with the owner (you, for a local review) before running another round. I'll name the likely cause: either the bar is set too low or fixes are breaking nearby rows.

**Done.** Done means nothing meets the bar, not that there's nothing left to say. I'll then:
1. List all follow-ups once.
2. Say plainly that nothing blocks.
3. Leave approval and merging to whoever owns them.
```

1. PASS. "Breaking a binding standard blocks only when it lets a wrong result through." and "Everything else is a follow-up: other standards breaches, missing test rows, docs, style and wording."
2. PASS. "\"Realistic input\" means input found in recorded or production-shaped data, or the same everyday habit as something that is. Contrived inputs are follow-ups."
3. PASS. "Before I post or keep a fix, I apply it in a scratch copy. I then run both reviewers' full probe tables on the previous state and on the fixed copy. The fix ships with a list of every row it changes."
4. PASS. "Each round reports every known finding at once."
5. PASS. "List all follow-ups once." "Say plainly that nothing blocks." "Leave approval and merging to whoever owns them."

## Run 2

`check` exited 0.

Run 2 output, verbatim:

```text
Shipped-text SHA-256: 0f2c4e8f2d849824f7e15f5ab5fe1fae1d94f724a599cb91e6db851cfd504e24
Model: claude-opus-5-5

**Review plan**

**Blocks vs. follow-up.** A finding blocks only if it causes one of these:
- lost data
- wrong data a user sees on realistic input
- leaked private data, or a cancelled or withdrawn item shown as live
- a crash or a broken error contract
- a check that can't fail

Breaking a binding standard blocks only when it lets a wrong result through. The repo's own review rules add to this list. Everything else is a follow-up: other standard breaches, missing test rows, docs, style and wording. Realistic input means input that appears in recorded or production-shaped data, or comes from the same everyday habit. Contrived inputs are follow-ups. My test for every finding: if this were the last round, would I hold the merge for it?

**Labels.** From round two, every finding is marked **regression** (the latest state broke it) or **older** (it was already there). A regression blocks. An older finding blocks only if it meets the bar on realistic input. If a regression came from my own earlier suggestion or fix, I'll say so. If an earlier claim of mine was wrong, I'll correct it in the next round.

**Checking fixes.** Before I post or keep any fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy. I report the fix with every row it moves. I'd rather revert to an earlier rule and document a known miss than widen a pattern. I'd rather leave a value missing than make it wrong. I'll ask for one literal table per rule, listing rows it must match and rows it must leave alone.

**Re-review scope.** Each round reports every finding I know of at once. A re-review covers only the diff since the last round: the fix and the code around it, not the whole change.

**If rounds stall.** I track the number of blocking findings each round. If it isn't going down, I stop and raise it with you instead of running another round. I'll name the likely cause, such as a bar set too low or fixes that keep moving nearby rows.

**Done.** Done means nothing meets the bar, not that there's nothing left to say. At that point I'll give one list of follow-ups, say plainly that nothing blocks, and leave approval and merge to whoever owns them.
```

1. PASS. "Breaking a binding standard blocks only when it lets a wrong result through." and "Everything else is a follow-up: other standard breaches, missing test rows, docs, style and wording."
2. PASS. "Realistic input means input that appears in recorded or production-shaped data, or comes from the same everyday habit. Contrived inputs are follow-ups."
3. PASS. "Before I post or keep any fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy. I report the fix with every row it moves."
4. PASS. "Each round reports every finding I know of at once."
5. PASS. "I'll give one list of follow-ups, say plainly that nothing blocks, and leave approval and merge to whoever owns them."

## Superseded runs

Two earlier GREEN runs judged the pull-request-only text of this skill against the superseded prompt (`baseline.md`, `## Superseded pull-request attempts`) and passed all five criteria. That text no longer ships, so their outputs are not reproduced.

## Loopholes closed

None observed. This is an output-shaping skill: a positive recipe, no rationalization table.
