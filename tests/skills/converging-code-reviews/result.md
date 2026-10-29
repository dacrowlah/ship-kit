# Result (GREEN): converging-code-reviews

Shipped-text SHA-256: ae99d4d780ddd728929ba6d16abee70f96e88ecaea0bf12f1263ca262ad64251
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3, 4, 5

CLI version: `2.1.284 (Claude Code)`, the version CI pins. Three GREEN runs of the shipped text under the pinned model, each in a fresh run directory like the RED attempts' (`baseline.md`), with the staged plugin loaded and the current `## Prompt` of `scenario.md` (any code review: own changes, an uncommitted diff, a local branch, or a pull request). `node tests/helpers/pressure.mjs check` accepted each stream (exit 0): the init message reports the pinned model and lists `ship-kit:converging-code-reviews`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines above are the ones `check` printed for all three runs; the hash equals `node tests/helpers/pressure.mjs hash --skill converging-code-reviews`.

Headline: 5 of 5 discriminating criteria pass, in all three runs.

```bash
MODEL=$(cat tests/skills/pinned-model.txt)
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence --output-format stream-json --verbose --model "$MODEL")
PLUG=$(cd "$(mktemp -d)" && pwd -P)
STAGED=$(node tests/helpers/pressure.mjs stage --out "$PLUG")
RUN=$(cd "$(mktemp -d)" && pwd -P)
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$STAGED" --add-dir="$STAGED" "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green-N.jsonl"
node tests/helpers/pressure.mjs check --skill "$SKILL" --stream "$SCRATCH/$SKILL-green-N.jsonl" > "$SCRATCH/$SKILL-green-N.txt"
echo "check exit: $?"
```

## Why the realistic-input definition sits in the bar list

An earlier draft of this text kept the definition of realistic input in its own paragraph after the bar. Of eight GREEN runs of that draft, all accepted by `check`, one copied the bar list and dropped the definition, failing criterion 2; the other seven passed all five criteria. Every run copies the bar list, so the definition moved into the list item it qualifies, and the contrived-input follow-up joined the follow-up sentence. The three runs below are of the text that ships.

## Run 1

`check` exited 0. The run ended `success`; its one tool call was `Skill` (`ship-kit:converging-code-reviews`).

Run 1 output, verbatim:

```text
Shipped-text SHA-256: ae99d4d780ddd728929ba6d16abee70f96e88ecaea0bf12f1263ca262ad64251
Model: claude-opus-5-5

**Review plan**

**What blocks.** A finding blocks only if it causes one of these:
- lost data;
- wrong data a user sees, on realistic input (input found in recorded or production-shaped data, or the same everyday habit);
- leaked private data, or stale or revoked state shown as current;
- a crash or a broken error contract;
- a check that cannot fail.

A breach of a binding standard blocks only when it lets a wrong result through. The repository's own review rules add to this list. Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording. My test for each finding: "If this were the last round, would I hold the merge for it?"

**Labels.** I label every finding **regression** (the latest state broke it) or **older** (it was already there). From round two on, a regression blocks if it meets the bar. An older item blocks only if it meets the bar on realistic input. The adversarial reviewer will always find more older cases, and that alone doesn't mean the change isn't ready.

**Checking fixes.** Before I post or keep a fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy, and I report every row the fix moves. Reverting to an earlier rule plus a documented known miss beats widening a pattern, and a missing value beats a wrong one. I ask for one literal table per rule, listing rows it must match and rows it must leave alone. If my own earlier suggestion caused a regression, I say so. If a claim I made turns out wrong, I correct it in the next round.

**Re-review scope.** Each round reports every finding it turns up. Re-reviews cover only the diff since the last round: the fix and its neighbours, not the whole change.

**Not converging.** I record the blocking count each round. If it stops shrinking, I stop and raise it with the owner (for a local review, the user). I name the likely cause: the bar is set too low, or fixes are moving neighbouring rows.

**Done.** Done means nothing meets the bar, not that there's nothing left to say. I list the follow-ups once and say plainly that nothing blocks. Approval and merge stay with whoever owns them.
```

1. PASS. "A breach of a binding standard blocks only when it lets a wrong result through." and "Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording."
2. PASS. "wrong data a user sees, on realistic input (input found in recorded or production-shaped data, or the same everyday habit);" and "Everything else is a follow-up: contrived inputs"
3. PASS. "Before I post or keep a fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy, and I report every row the fix moves."
4. PASS. "Each round reports every finding it turns up."
5. PASS. "I list the follow-ups once and say plainly that nothing blocks. Approval and merge stay with whoever owns them."

## Run 2

`check` exited 0. The run ended `success`; its one tool call was `Skill` (`ship-kit:converging-code-reviews`).

Run 2 output, verbatim:

```text
Shipped-text SHA-256: ae99d4d780ddd728929ba6d16abee70f96e88ecaea0bf12f1263ca262ad64251
Model: claude-opus-5-5

**Review plan**

**What blocks.** A finding blocks only if it causes one of these:
- lost data
- wrong data a user sees on realistic input, meaning input like recorded or production data
- leaked private data, or stale or revoked state shown as current
- a crash or a broken error contract
- a check that can't fail

A breach of a binding standard blocks only if it lets a wrong result through. The repo's own review rules add to this list. Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording. For each finding I ask whether I'd hold the merge for it if this were the last round. If not, it's a follow-up, and the owner decides whether to fix it now or later.

**Labels.** From round two on, every finding is marked **regression** (the latest state broke it) or **older** (it was already there). A regression blocks if it meets the bar. An older item blocks only if it meets the bar on realistic input. If the adversarial reviewer keeps finding older edge cases, that's expected and doesn't by itself mean the change isn't ready.

**Checking fixes.** Before I post or keep any fix, I apply it in a scratch copy. Then I run both reviewers' full probe tables against the previous state and the fixed copy, and list every row the fix changes. I'd rather revert to an earlier rule and document a known miss than widen a pattern. A missing value is better than a wrong one. For each rule I want a table of rows it must match and rows it must leave alone. If a regression came from my own earlier suggestion, I'll say so. If an earlier claim of mine was wrong, I'll correct it in the next round.

**Re-review scope.** Each round reports every finding it turns up. Re-reviews cover only the diff since the last round: the fix and the code around it, not the whole change.

**If rounds don't converge.** I record the blocking count each round. If it stops going down, I stop and raise it with the owner instead of running another round. I'll name the likely cause, such as a bar set too low or fixes that break nearby rows.

**Done.** Done means nothing meets the bar, not that there's nothing left to say. At that point I give one list of follow-ups, say plainly that nothing blocks, and leave approval and merge to whoever owns them.
```

1. PASS. "A breach of a binding standard blocks only if it lets a wrong result through." and "Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording."
2. PASS, on looser wording than the skill's: "wrong data a user sees on realistic input, meaning input like recorded or production data" and "Everything else is a follow-up: contrived inputs"
3. PASS. "Before I post or keep any fix, I apply it in a scratch copy. Then I run both reviewers' full probe tables against the previous state and the fixed copy, and list every row the fix changes."
4. PASS. "Each round reports every finding it turns up."
5. PASS. "At that point I give one list of follow-ups, say plainly that nothing blocks, and leave approval and merge to whoever owns them."

## Run 3

`check` exited 0. The run ended `success`. It invoked `ship-kit:converging-code-reviews` and then also `ship-kit:running-dual-code-reviews`, which is why its plan has a reviewers paragraph; every criterion below is met by text the first skill asks for.

Run 3 output, verbatim:

```text
Shipped-text SHA-256: ae99d4d780ddd728929ba6d16abee70f96e88ecaea0bf12f1263ca262ad64251
Model: claude-opus-5-5

**Review plan**

**What blocks.** A finding blocks only if it is one of these:
- lost data
- wrong data a user sees on realistic input (input found in recorded or production-shaped data, or an everyday habit like something that is)
- leaked private data, or stale or revoked state shown as current
- a crash, or a broken error contract
- a check that cannot fail

A breach of a binding standard blocks only when it lets a wrong result through. The repository's own review rules add to this list. Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording. The owner decides whether a follow-up is fixed now or later.

**Labels.** I label every finding **regression** (the latest state broke it) or **older** (it was already there). From round two on, a finding blocks only if it is a regression that meets the bar, or an older finding that meets it on realistic input. If a problem came from one of my earlier suggestions, I say so. If one of my earlier claims was wrong, I correct it in the next round.

**Reviewers.** The general reviewer gets the previous findings and checks each fix. The adversarial reviewer gets only the diff and the bar, and must include a reproduction with every finding. Before I act on a finding, I re-run its probe myself on both the previous and the current state.

**Checking a fix.** Before I post or keep a fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy, and list every row the fix changes. I'd rather revert to an earlier rule and document the known miss than widen a pattern. A missing value is better than a wrong one.

**Re-review scope.** Each re-review covers only the diff since the last reviewed state: the fix and the code around it. I report every finding in the round it's found.

**If rounds don't converge.** I record the blocking count each round. If it stops shrinking, I stop and raise it with the owner instead of running another round. I'll name the likely cause, such as a bar set too low or fixes breaking nearby cases.

**Done** means nothing meets the bar, not that there's nothing left to say. At that point I list the follow-ups once, state plainly that nothing blocks, and leave approval and merge to the owner.
```

1. PASS. "A breach of a binding standard blocks only when it lets a wrong result through." and "Everything else is a follow-up: contrived inputs, missing test rows, docs, style and wording."
2. PASS. "wrong data a user sees on realistic input (input found in recorded or production-shaped data, or an everyday habit like something that is)" and "Everything else is a follow-up: contrived inputs"
3. PASS. "Before I post or keep a fix, I apply it in a scratch copy. I run both reviewers' full probe tables against the previous state and the fixed copy, and list every row the fix changes."
4. PASS. "I report every finding in the round it's found."
5. PASS. "At that point I list the follow-ups once, state plainly that nothing blocks, and leave approval and merge to the owner."

## Superseded runs

Two earlier GREEN runs judged the pull-request-only text of this skill against the superseded prompt (`baseline.md`, `## Superseded pull-request attempts`) and passed all five criteria. That text no longer ships, so their outputs are not reproduced.

## Loopholes closed

None observed. This is an output-shaping skill: a positive recipe, no rationalization table.
