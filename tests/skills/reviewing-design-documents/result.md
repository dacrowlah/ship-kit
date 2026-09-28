# Result (GREEN): reviewing-design-documents

CLI version: `2.1.284 (Claude Code)`. Same run directory and prompt as the final baseline (attempt 8; the `## Prompt` section of `scenario.md`). The plugin is staged as it ships.

```bash
ISO=(--setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,Skill" --permission-mode plan --no-session-persistence)
rm -rf "$PLUG/.claude-plugin" "$PLUG/skills" "$PLUG/scripts" "$PLUG/review"
cp -R "$REPO/.claude-plugin" "$REPO/skills" "$REPO/scripts" "$PLUG/"
if [ -d "$REPO/review" ]; then cp -R "$REPO/review" "$PLUG/"; fi
# The staged copy only: drop the superpowers dependency, which is not
# installed under --setting-sources "" and otherwise makes Claude Code drop
# the whole plugin ("Dependency ... is not installed"; 0 plugin skills).
node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));delete j.dependencies;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$PLUG/.claude-plugin/plugin.json"
(cd "$RUN" && claude -p "${ISO[@]}" --plugin-dir "$PLUG" --output-format stream-json --verbose "$(cat "$SCRATCH/$SKILL-prompt.txt")" < /dev/null) > "$SCRATCH/$SKILL-green.jsonl"
```

The output below is the stream's `result` text. The stream's init message lists `ship-kit:reviewing-design-documents` among the skills. The run's tool calls were `Skill` (`ship-kit:reviewing-design-documents`) and then `Read` of `<plugin-dir>/review/hunt-lists/design-shared.md`.

Output, verbatim (ASCII-transcribed, redacted):

```text
**Review plan for docs/design/ship-kit-design.md**

1. **Reviewers.** Every round has two reviewers: a general reviewer and an adversarial reviewer. This holds at every tier.

2. **Writing and revising.** I write the first draft only. After that, the reviewing side makes all revisions. I don't revise my own draft.

3. **What reviewers hunt.** In every round, both reviewers check for all 20 defect shapes in `review/hunt-lists/design-shared.md` (D1-D20), as well as the design's own concerns. Examples of those shapes:
   - code or configuration written as prose steps
   - derived numbers without the model that produced them
   - the same fact left stale at a second site
   - summaries that contradict the detail
   - a test stated in several places
   - guards that let through a state they should refuse
   - history written into the specification

   Each round starts by re-checking the previous round's fixes (D14).

4. **After both reviewers pass it.** Fold in all findings once. Then run one confirmation round that looks only at the folded-in text. Each remaining NON-BLOCKING finding becomes a note on the plan task it affects, and the design merges.

5. **Same defect found a second time.** Patching another instance isn't enough. The mechanism gets redesigned so the fact lives in one place, and every other place points to it. The next round checks the redesign.

6. **When review stops.** Review ends when the confirmation round after both passes is done:
   - A NON-BLOCKING finding becomes a plan-task note, and the design merges.
   - A BLOCKING finding gets fixed, and the fix gets a check of the changed text only.

   If anyone asks for "one more round to be safe," the answer is that the confirmation round is that safety step. The request and the answer both go in the review record, so anyone with authority over the process can revisit it explicitly.

If rounds keep producing findings instead of settling, we follow `pattern-method.md`.
```

| Criterion | Result |
|---|---|
| 1. General and adversarial reviewer every round | PASS ("Every round has two reviewers: a general reviewer and an adversarial reviewer") |
| 2. Drafter writes the first pass only; the reviewing side revises | PASS ("I write the first draft only. After that, the reviewing side makes all revisions") |
| 3. After PASS/PASS: fold once, one scoped confirmation round, NON-BLOCKING leftovers to plan-task notes, no further full round | PASS (item 4, and item 6: "the confirmation round is that safety step") |
| 4. Hunt every shared design shape every round | PASS ("both reviewers check for all 20 defect shapes in `review/hunt-lists/design-shared.md`") |

## Superseded discipline runs

These runs used the attempt-2 discipline scenario (owner-delegated authority) and an earlier text of the skill, which carried a prohibition, a rationalization table and red flags. That text does not ship: the scenario is not a legitimate baseline (see `baseline.md`), and the stop rules are now positive guidance.

- The first run is invalid. The plugin did not load, because of the dependency issue handled above.
- The next two runs, with the first skill text, chose C and passed every criterion.
- The last three runs followed successive additions to the table, and each chose A, deferring to the person the owner put in charge. Their outputs are not reproduced, since they judge text that no longer exists.

## Loopholes closed

None observed. This is an output-shaping skill: a positive recipe, no rationalization table.
