#!/usr/bin/env bash
# watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries] [--require <name>]...
#
# Polls `gh pr checks` for the PR's latest commit. When no check is
# pending it prints one summary line, plus one "FAILED: <name>" line per
# failed or cancelled check, and exits 0. When no checks appear for more
# than max-empty-tries consecutive polls (a conflicting PR, or a trigger
# that did not fire) it prints an alarm and exits 1: silence is never
# reported as success. Exit 2 is a usage error.
#
# A check that is still being created by GitHub can register after every
# check seen so far has already concluded (a workflow with several jobs
# whose second job is still queuing its own check entry). To avoid
# concluding before such a late check appears, once every known check is
# non-pending this script waits a settle interval (WATCH_SETTLE_SECONDS,
# default 30 seconds) and polls once more; it only concludes once two
# consecutive polls, one settle interval apart, see the exact same set of
# check names with none pending. A poll that finds a new name, or a
# pending check, restarts the wait.
#
# `--require <name>` (repeatable) names a check that must appear before
# this script will conclude at all; the poll/settle loop keeps running,
# counting toward max-empty-tries, until every required name is present
# among the reported checks. A required check that never appears before
# max-empty-tries is exceeded is reported as "FAILED: <name> (never
# appeared)" and the script exits 1, the same as the no-checks-appeared
# alarm.
#
# Requires gh (authenticated) and node. Run inside the PR's repository or
# set GH_REPO. Makes no network call other than gh's own.

set -u
usage="usage: watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries] [--require <name>]..."
pr="${1:-}"
[ $# -gt 0 ] && shift
poll="${1:-30}"
[ $# -gt 0 ] && shift
max_empty="${1:-20}"
[ $# -gt 0 ] && shift
for value in "$pr" "$poll" "$max_empty"; do
  case "$value" in
    ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
  esac
done

require_names=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require)
      name="${2:-}"
      if [ -z "$name" ]; then echo "$usage" >&2; exit 2; fi
      require_names="${require_names}${name}
"
      shift 2
      ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
done

settle="${WATCH_SETTLE_SECONDS:-30}"
case "$settle" in
  ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
esac

# Reads `gh pr checks --json name,bucket` on stdin, with the required
# check names (one per line) in REQUIRE_NAMES. Exit 3: still pending.
# Exit 4: not a non-empty JSON array (treated as no checks yet). Exit 5:
# every known check is non-pending, but a required name has not appeared
# yet (treated like "no checks yet" for the alarm counter, but the
# printed lines already name the missing required checks).
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let checks;
  try { checks = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(checks) || checks.length === 0) process.exit(4);
  if (checks.some((c) => c.bucket === "pending")) process.exit(3);
  const requireNames = (process.env.REQUIRE_NAMES || "").split("\n").filter(Boolean);
  const names = new Set(checks.map((c) => c.name));
  const missing = requireNames.filter((n) => !names.has(n));
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const parts = Object.keys(counts).sort().map((b) => `${b}:${counts[b]}`);
  const lines = [`PR${process.argv[1]} checks concluded: ${parts.join(" ")}`];
  for (const c of checks) {
    if (c.bucket === "fail" || c.bucket === "cancel") lines.push(`FAILED: ${c.name}`);
  }
  for (const name of missing) lines.push(`FAILED: ${name} (never appeared)`);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(missing.length > 0 ? 5 : 0);
});
'

# Reads the same JSON on stdin and prints the sorted, comma-joined check
# names, for comparing two polls a settle interval apart.
names_of='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let checks;
  try { checks = JSON.parse(raw); } catch { process.stdout.write(""); return; }
  if (!Array.isArray(checks)) { process.stdout.write(""); return; }
  process.stdout.write(checks.map((c) => c.name).sort().join(","));
});
'

tries=0
settled_names=""
while true; do
  checks=$(gh pr checks "$pr" --json name,bucket 2>/dev/null)
  result=$(printf '%s' "$checks" | REQUIRE_NAMES="$require_names" node -e "$summarize" "$pr")
  status=$?
  if [ "$status" -eq 0 ]; then
    names=$(printf '%s' "$checks" | node -e "$names_of")
    if [ -n "$settled_names" ] && [ "$names" = "$settled_names" ]; then
      printf '%s\n' "$result"
      exit 0
    fi
    settled_names="$names"
    tries=0
    sleep "$settle"
    continue
  elif [ "$status" -eq 3 ]; then
    settled_names=""
    tries=0
  elif [ "$status" -eq 5 ]; then
    settled_names=""
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      printf '%s\n' "$result"
      exit 1
    fi
  else
    settled_names=""
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      echo "PR$pr: no checks appeared after $tries polls; the trigger may not have fired (check the PR's mergeable state)"
      exit 1
    fi
  fi
  sleep "$poll"
done
