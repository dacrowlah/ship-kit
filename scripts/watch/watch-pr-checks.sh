#!/usr/bin/env bash
# watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries] [--require <name>]...
#
# Polls `gh pr checks` for the PR's latest commit. When nothing is left to
# wait for (see below) it prints one summary line, plus one "FAILED:
# <name>" line per failed, cancelled, still-pending-past-timeout or
# never-appeared required check, and exits 0. Exit 2 is a usage error.
#
# What "nothing left to wait for" means, and the guarantee behind it:
#
# A check that GitHub has not created yet cannot be told apart from a
# check that will never run, by looking at a single poll. This script's
# guarantee therefore comes from knowing, in advance, which check names
# the base branch actually requires, not from waiting a fixed amount of
# time and hoping nothing else shows up:
#
#   - By default it derives the required check names for the PR's base
#     branch: the union of the repository ruleset contexts
#     (`gh api repos/<owner>/<repo>/rules/branches/<base>`, the
#     `required_status_checks` rule's `parameters.required_status_checks[].context`
#     entries) and the classic branch-protection contexts
#     (`gh api repos/<owner>/<repo>/branches/<base>/protection/required_status_checks`,
#     its `.contexts[]`; a 404 here means no classic protection, not an
#     error). Add more names yourself with `--require <name>` (repeatable);
#     these are always included in addition to whatever was derived.
#   - The script will not conclude while any required name is missing or
#     still pending, however many polls that takes, up to the
#     max-empty-tries alarm. A required check that never appears, or that
#     appears but is still pending when the alarm fires, is reported as
#     FAILED at that point -- never as a silent, indefinite wait, and
#     never folded into a false "concluded" line.
#   - A check that is NOT in the required set only gets a courtesy wait:
#     once every required name is satisfied and no other check is
#     pending, the script waits one settle interval (WATCH_SETTLE_SECONDS,
#     default 30s) and polls once more, concluding only if the same set of
#     check names still shows up with nothing pending. A non-required
#     check that first registers more than one settle interval after that
#     point is NOT waited for and can still be missing from the summary;
#     name it with --require if it must be counted on.
#   - If deriving the required set fails for a reason other than "this
#     branch has no rules of this kind" (a 404), the script prints
#     `WARNING: could not read required checks for <base>; pass --require`
#     and exits nonzero, unless the caller already passed at least one
#     `--require` (in which case it proceeds using only the explicit
#     names): it never silently falls back to treating whatever happened
#     to appear as the full picture.
#
# Requires gh (authenticated), node and jq. Run inside the PR's repository
# or set GH_REPO. Makes no network call other than gh's own.

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

explicit_requires=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require)
      name="${2:-}"
      if [ -z "$name" ]; then echo "$usage" >&2; exit 2; fi
      explicit_requires="${explicit_requires}${name}
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

# Derives the base branch's required check names, one lookup at a time
# (never inside a `$(...)` subshell together with the variables it sets,
# since a subshell's variable assignments do not survive it). Each step
# only runs if the previous one succeeded; derive_ok stays 1 only for a
# full, clean derivation. A 404 from either endpoint means "nothing of
# this kind is required", not a failure, and short-circuits to an empty
# result for that endpoint without touching derive_ok.
base=""
derive_ok=1

base=$(gh pr view "$pr" --json baseRefName -q .baseRefName 2>/dev/null)
base_status=$?
if [ "$base_status" -ne 0 ] || [ -z "$base" ]; then derive_ok=0; fi

repo=""
if [ "$derive_ok" -eq 1 ]; then
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
  repo_status=$?
  if [ "$repo_status" -ne 0 ] || [ -z "$repo" ]; then derive_ok=0; fi
fi

# A branch name is one path segment, but the branches/{branch}/protection/...
# endpoint places it as a MIDDLE segment (another literal "/protection..."
# follows it in the same path); an unescaped "/" in the branch name (for
# example "release/1.0") is otherwise indistinguishable from a path
# segment boundary, which can make the request 404 for the wrong reason --
# a malformed path, not "this branch genuinely has no classic protection"
# -- and that wrong-reason 404 is exactly what the 404-means-none handling
# below would otherwise silently accept. Percent-encode it (jq's `@uri`;
# "main" round-trips unchanged, "release/1.0" becomes "release%2F1.0") for
# both API calls, not just the one where the branch is the last segment.
encoded_base=""
if [ "$derive_ok" -eq 1 ]; then
  encoded_base=$(jq -rn --arg b "$base" '$b|@uri' 2>/dev/null)
  if [ -z "$encoded_base" ]; then derive_ok=0; fi
fi

rules_out=""
if [ "$derive_ok" -eq 1 ]; then
  rules_out=$(gh api "repos/$repo/rules/branches/$encoded_base" --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' 2>&1)
  rules_status=$?
  if [ "$rules_status" -ne 0 ]; then
    if printf '%s' "$rules_out" | grep -q '(HTTP 404)'; then
      rules_out=""
    else
      derive_ok=0
    fi
  fi
fi

classic_out=""
if [ "$derive_ok" -eq 1 ]; then
  classic_out=$(gh api "repos/$repo/branches/$encoded_base/protection/required_status_checks" --jq '.contexts[]?' 2>&1)
  classic_status=$?
  if [ "$classic_status" -ne 0 ]; then
    if printf '%s' "$classic_out" | grep -q '(HTTP 404)'; then
      classic_out=""
    else
      derive_ok=0
    fi
  fi
fi

if [ "$derive_ok" -ne 1 ]; then
  base_display="${base:-the base branch of PR $pr}"
  echo "WARNING: could not read required checks for $base_display; pass --require" >&2
  if [ -z "$explicit_requires" ]; then
    exit 1
  fi
  rules_out=""
  classic_out=""
fi

require_names=$(printf '%s\n%s\n%s\n' "$explicit_requires" "$rules_out" "$classic_out" | awk 'NF' | sort -u)

# Reads `gh pr checks --json name,bucket` on stdin, with the required
# check names (one per line) in REQUIRE_NAMES. A required name that is
# missing entirely, or present but still "pending", makes the check list
# incomplete: exit 5, with the summary already naming each one as FAILED
# ("never appeared" or "still pending"), so the caller printing $result at
# the alarm timeout gets a full report, not a bare "no checks" message. A
# check outside the required set that is still pending, with every
# required name satisfied, is a courtesy-only wait: exit 3. Exit 4: not a
# non-empty JSON array (treated as no checks yet).
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let checks;
  try { checks = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(checks) || checks.length === 0) process.exit(4);
  const requireNames = (process.env.REQUIRE_NAMES || "").split("\n").filter(Boolean);
  const byName = new Map(checks.map((c) => [c.name, c]));
  const incomplete = requireNames.filter((n) => {
    const c = byName.get(n);
    return !c || c.bucket === "pending";
  });
  if (incomplete.length === 0 && checks.some((c) => c.bucket === "pending")) process.exit(3);
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const parts = Object.keys(counts).sort().map((b) => `${b}:${counts[b]}`);
  const lines = [`PR${process.argv[1]} checks concluded: ${parts.join(" ")}`];
  for (const c of checks) {
    if (c.bucket === "fail" || c.bucket === "cancel") lines.push(`FAILED: ${c.name}`);
  }
  for (const name of incomplete) {
    lines.push(byName.has(name) ? `FAILED: ${name} (still pending)` : `FAILED: ${name} (never appeared)`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(incomplete.length > 0 ? 5 : 0);
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
