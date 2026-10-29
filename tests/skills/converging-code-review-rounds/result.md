# Result (GREEN): converging-code-review-rounds

Shipped-text SHA-256: 27fab9b6f281d59d54d547141a6d48098c1a60bdaab96186455682553dba0466
Model: claude-opus-5-5
Discriminating criteria: 1, 2, 3, 4, 5

CLI version: `2.1.312 (Claude Code)`. Two GREEN runs of the shipped text under the pinned model, each in a fresh run directory like the RED attempts' (`baseline.md`), with the staged plugin loaded and the `## Prompt` of `scenario.md`. `node tests/helpers/pressure.mjs check` accepted each stream (exit 0): the init message reports the pinned model and lists `ship-kit:converging-code-review-rounds`, the run invoked the skill and loaded the staged SKILL.md, and the stream ends in a `success` result. The hash and model lines above are the ones `check` printed for both runs; the hash equals `node tests/helpers/pressure.mjs hash --skill converging-code-review-rounds`.

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
Shipped-text SHA-256: 27fab9b6f281d59d54d547141a6d48098c1a60bdaab96186455682553dba0466
Model: claude-opus-5-5

## Review plan

**What blocks the merge.** We block only for:
- data that gets lost;
- wrong data a user sees on realistic input;
- private data that leaks, or a cancelled or withdrawn item shown as live;
- a crash, or a broken error contract;
- a test that cannot fail.

A breach of a binding standard blocks only when it lets a wrong result through. Everything else is a follow-up: other standards breaches, missing test rows, docs, style and wording. "Realistic input" means input found in recorded or production-shaped data, or an everyday habit just like it. Contrived inputs are follow-ups.

**Labels.** Every finding is marked **regression** (this commit broke it) or **older** (it was there before this commit). From round two on, a finding blocks only if it is a regression, or an older item that meets the bar on realistic input. The adversarial reviewer will keep finding older cases. That is its job, and it doesn't mean the pull request isn't ready.

**Checking a fix before we suggest it.** We apply the fix in a scratch copy. We run both reviewers' full probe tables against the current head and against the fixed copy. Then we post the fix with every row it changes. We prefer:
- reverting to an earlier rule, with the known miss written down, over widening a pattern;
- a missing value over a wrong one;
- one literal table per rule, listing rows it must match and rows it must leave alone.

**Re-review scope.** All known findings go out together in the round we find them. A re-review covers the fix and the code next to it, not the whole package. Its findings are limited to what that fix changed.

**Our own mistakes.** If a regression came from our own earlier suggestion, we say so. If we made a wrong claim, we correct it in the next round.

**If rounds aren't converging.** We record the number of blocking findings each round. If that number stops going down, we pause and raise it with the owner instead of running another round. We'll name the likely cause, such as a bar set too low or our fixes changing nearby rows.

**Done.** Done means nothing meets the bar, not that nothing is left to say. At that point we post all follow-ups once, as a single list, and state plainly that nothing blocks. Approval and merge stay with their owners.
```

1. PASS. "A breach of a binding standard blocks only when it lets a wrong result through. Everything else is a follow-up: other standards breaches, missing test rows, docs, style and wording."
2. PASS. "\"Realistic input\" means input found in recorded or production-shaped data, or an everyday habit just like it. Contrived inputs are follow-ups."
3. PASS. "We apply the fix in a scratch copy. We run both reviewers' full probe tables against the current head and against the fixed copy. Then we post the fix with every row it changes."
4. PASS. "All known findings go out together in the round we find them."
5. PASS. "we post all follow-ups once, as a single list, and state plainly that nothing blocks. Approval and merge stay with their owners."

## Run 2

`check` exited 0.

Run 2 output, verbatim:

```text
Shipped-text SHA-256: 27fab9b6f281d59d54d547141a6d48098c1a60bdaab96186455682553dba0466
Model: claude-opus-5-5

# Review plan (shared with the author and the owner before round one)

**What blocks the merge.** A finding blocks only if it causes one of these:
- lost data
- wrong data that a user sees on realistic input
- leaked private data, or a cancelled or withdrawn item shown as live
- a crash or a broken error contract
- a check or test that can never fail

A broken binding standard blocks only if it lets a wrong result through. "Realistic" means the input appears in recorded or production-shaped data, or follows the same everyday habit as input that does. Contrived inputs, missing test rows, documentation, style and wording are follow-ups. They never block. For each finding we ask: "If this were the last round, would we hold the merge for it?"

**Labels.** Each finding is marked **regression** (this commit broke it) or **older** (it was already there). From round two on, a finding blocks if it's a regression, or if it's older and meets the bar on realistic input. The adversarial reviewer will always find more older cases. That's the role doing its job, not a sign the PR isn't ready. If an earlier suggestion from us caused a regression, we say so. If an earlier claim of ours was wrong, we correct it in the next round.

**Each round.** We raise every finding we know about in the round we find it, and hold nothing back for later. A re-review covers the fix and the code around it, not the whole package. Its findings are limited to what the fix changed.

**Suggested fixes.** Before posting a fix, we:
1. apply it in a scratch copy
2. run both reviewers' full probe tables against the old head and against the fixed copy
3. post it with a list of every row it changes

We'd rather revert to an earlier rule and document a known miss than widen a pattern, and we'd rather return no value than a wrong one. We ask for one literal table per rule, with rows it must match and rows it must leave alone.

**If rounds don't converge.** We record the blocking count each round. If it stops going down, we pause and raise it with the owner, naming the likely cause (the bar is set too low, or fixes are changing nearby rows), instead of starting another round.

**Done.** Done means nothing meets the bar, not that there's nothing left to say. We then post all follow-ups once as a single list and state plainly that nothing blocks. Approval and merge stay with their owners.
```

1. PASS. "A broken binding standard blocks only if it lets a wrong result through." and "Contrived inputs, missing test rows, documentation, style and wording are follow-ups."
2. PASS. "\"Realistic\" means the input appears in recorded or production-shaped data, or follows the same everyday habit as input that does."
3. PASS. "run both reviewers' full probe tables against the old head and against the fixed copy" and "post it with a list of every row it changes".
4. PASS. "We raise every finding we know about in the round we find it, and hold nothing back for later."
5. PASS. "We then post all follow-ups once as a single list and state plainly that nothing blocks. Approval and merge stay with their owners."

## Loopholes closed

None observed. This is an output-shaping skill: a positive recipe, no rationalization table.
