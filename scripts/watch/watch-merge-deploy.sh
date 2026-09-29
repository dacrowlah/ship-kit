#!/usr/bin/env bash
# watch-merge-deploy.sh <full-40-char-sha> [poll-seconds] [max-empty-tries]
#
# Waits for every workflow run on a commit to complete, then prints one
# summary line plus one "FAILED: <name> (<conclusion>)" line per run that
# did not end success, skipped or neutral, and exits 0. Requires the full
# 40-character lowercase SHA and exits 2 otherwise, because
# `gh run list --commit` silently matches nothing for a short SHA. When no
# runs appear for more than max-empty-tries consecutive polls it prints an
# alarm and exits 1.
#
# Requires gh (authenticated) and node. Makes no network call other than
# gh's own.

set -u
usage="usage: watch-merge-deploy.sh <full-40-char-sha> [poll-seconds] [max-empty-tries]"
sha="${1:-}"
poll="${2:-30}"
max_empty="${3:-20}"
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "watch-merge-deploy: need the full 40-character lowercase SHA (got '${sha}'); a short SHA matches nothing in gh run list" >&2
  exit 2
fi
for value in "$poll" "$max_empty"; do
  case "$value" in
    ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
  esac
done

# Reads `gh run list --json name,status,conclusion` on stdin. Exit 3: a
# run is not completed. Exit 4: not a non-empty JSON array.
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let runs;
  try { runs = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(runs) || runs.length === 0) process.exit(4);
  if (runs.some((r) => r.status !== "completed")) process.exit(3);
  const ok = ["success", "skipped", "neutral"];
  const lines = [`runs for ${process.argv[1]} concluded: ` +
    runs.map((r) => `${r.name}:${r.conclusion || "?"}`).join(" ")];
  for (const r of runs) {
    if (!ok.includes(r.conclusion)) lines.push(`FAILED: ${r.name} (${r.conclusion || "?"})`);
  }
  process.stdout.write(lines.join("\n") + "\n");
});
'

tries=0
while true; do
  runs=$(gh run list --commit "$sha" --json name,status,conclusion 2>/dev/null)
  summary=$(printf '%s' "$runs" | node -e "$summarize" "$sha")
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$summary"
    exit 0
  elif [ "$status" -eq 3 ]; then
    tries=0
  else
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      echo "no workflow runs found for $sha after $tries polls"
      exit 1
    fi
  fi
  sleep "$poll"
done
