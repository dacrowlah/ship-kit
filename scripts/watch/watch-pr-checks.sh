#!/usr/bin/env bash
# watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries]
#
# Polls `gh pr checks` for the PR's latest commit. When no check is
# pending it prints one summary line, plus one "FAILED: <name>" line per
# failed or cancelled check, and exits 0. When no checks appear for more
# than max-empty-tries consecutive polls (a conflicting PR, or a trigger
# that did not fire) it prints an alarm and exits 1: silence is never
# reported as success. Exit 2 is a usage error.
#
# Requires gh (authenticated) and node. Run inside the PR's repository or
# set GH_REPO. Makes no network call other than gh's own.

set -u
usage="usage: watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries]"
pr="${1:-}"
poll="${2:-30}"
max_empty="${3:-20}"
for value in "$pr" "$poll" "$max_empty"; do
  case "$value" in
    ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
  esac
done

# Reads `gh pr checks --json name,bucket` on stdin. Exit 3: still pending.
# Exit 4: not a non-empty JSON array (treated as no checks yet).
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let checks;
  try { checks = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(checks) || checks.length === 0) process.exit(4);
  if (checks.some((c) => c.bucket === "pending")) process.exit(3);
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const parts = Object.keys(counts).sort().map((b) => `${b}:${counts[b]}`);
  const lines = [`PR${process.argv[1]} checks concluded: ${parts.join(" ")}`];
  for (const c of checks) {
    if (c.bucket === "fail" || c.bucket === "cancel") lines.push(`FAILED: ${c.name}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
});
'

tries=0
while true; do
  checks=$(gh pr checks "$pr" --json name,bucket 2>/dev/null)
  summary=$(printf '%s' "$checks" | node -e "$summarize" "$pr")
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$summary"
    exit 0
  elif [ "$status" -eq 3 ]; then
    tries=0
  else
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      echo "PR$pr: no checks appeared after $tries polls; the trigger may not have fired (check the PR's mergeable state)"
      exit 1
    fi
  fi
  sleep "$poll"
done
