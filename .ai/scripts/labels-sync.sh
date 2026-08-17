#!/usr/bin/env bash
# Sync this repository's label taxonomy with `.ai/agentic.config.json`.
#
# The taxonomy is the wire the om-* skills signal each other on: a label that does
# not exist makes every mutation of it a logged skip (see the "Label guards" section
# of .ai/trackers/github.md), so the claim/lock protocol and the review signalling
# silently stop working while every individual step still reports success.
#
# Mutations go through the REST API (`gh api`) for symmetry with the label guards in
# .ai/trackers/github.md, which have to use REST: `gh pr edit` / `gh issue edit` route
# through GraphQL, which asks for the retired Projects (classic) fields on clients older
# than gh 2.82.1 and aborts before the write lands. The agent host runs gh 2.46.0.
# (`gh label create` is REST-backed and works on 2.46.0 — it is the descriptor's own
# ensure-label-taxonomy operation. Using `gh api` here just keeps one code path.)
#
# Never deletes, renames, or recolors an existing label.
#
# Usage:
#   bash .ai/scripts/labels-sync.sh            create every missing label
#   bash .ai/scripts/labels-sync.sh --check    report what is missing, create nothing
#                                              (exit 1 when anything is missing)
#
# Exit 1 also means "a label exists only under a different case" — in both modes, and
# even when every missing label was created. That state is real drift the script cannot
# repair (GitHub's label names are case-insensitively unique), so it refuses to go green
# over it; the message names the rename a human has to make.
set -euo pipefail

CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$REPO_ROOT/.ai/agentic.config.json"
[ -f "$CONFIG" ] || { echo "missing $CONFIG" >&2; exit 2; }

# Read the flag through an explicit status check: inside `$( … )` a jq parse error would
# otherwise collapse into an empty string, which compares unequal to "true" and makes a
# malformed config look like a deliberate opt-out — the script reporting success while
# syncing nothing is exactly the silent degradation it exists to end.
if ! ENABLED="$(jq -r '.labels.enabled // false' "$CONFIG")"; then
  echo "cannot parse $CONFIG — fix the JSON before syncing labels" >&2
  exit 2
fi
if [ "$ENABLED" != "true" ]; then
  echo "labels.enabled is not true in .ai/agentic.config.json — nothing to sync."
  exit 0
fi

# Colors and descriptions mirror the collection's ensure-label-taxonomy operation
# (om-setup-agent-pipeline/references/trackers/github.md). A label present in the
# config but absent from this table is still created, in neutral grey — the config
# decides the SET, this table only decides how it looks.
label_meta() {
  case "$1" in
    review)            echo "0366d6|Ready for code review" ;;
    changes-requested) echo "b60205|Reviewer requested changes" ;;
    qa)                echo "fbca04|Manual QA in progress" ;;
    qa-failed)         echo "b60205|Manual QA failed" ;;
    merge-queue)       echo "0e8a16|Approved, ready to merge" ;;
    blocked)           echo "b60205|Blocked by a dependency" ;;
    do-not-merge)      echo "b60205|Hard merge block" ;;
    bug)               echo "d73a4a|Bug fix" ;;
    feature)           echo "a2eeef|New capability" ;;
    refactor)          echo "cfd3d7|No behavior change" ;;
    security)          echo "b60205|Security-relevant change" ;;
    dependencies)      echo "0366d6|Dependency update" ;;
    documentation)     echo "0075ca|Docs only" ;;
    needs-qa)          echo "fbca04|Requires manual QA before merge" ;;
    skip-qa)           echo "0e8a16|Low risk, QA not required" ;;
    qa-approved)       echo "0e8a16|Manual QA passed" ;;
    qa-self-verified)  echo "c5def5|Self-QA exception used" ;;
    in-progress)       echo "c5def5|An automated skill is working on this" ;;
    ci-monitoring)     echo "d4c5f9|Work complete and reported; agent is watching CI results" ;;
    do-not-close)      echo "c5def5|Humans only: never auto-close this issue" ;;
    priority-low)      echo "e4e669|Cosmetic or follow-up work" ;;
    priority-medium)   echo "fbca04|Ordinary bug or feature" ;;
    priority-high)     echo "d93f0b|Release-blocking" ;;
    priority-extreme)  echo "b60205|Outage or security incident" ;;
    risk-low)          echo "0e8a16|Isolated, low blast radius" ;;
    risk-medium)       echo "fbca04|Ordinary change with tests" ;;
    risk-high)         echo "b60205|Wide blast radius, review deeply" ;;
    *)                 echo "ededed|Declared in .ai/agentic.config.json" ;;
  esac
}

# Name the target repository explicitly, from $REPO_ROOT's own `origin`. Letting `gh`
# pick it leaves two independent ways to sync this repository's taxonomy into someone
# else's, and closing only one of them still leaves the door open:
#
#   1. Working directory. `gh repo view` reads the remote of whatever checkout it is
#      called in, while the taxonomy above came from this script's own repository — run
#      by absolute path from a different checkout (the normal way to invoke it, since the
#      agent instructions forbid `cd X && cmd`) the two disagree. Observed: from a
#      checkout of open-mercato/skills it reported `1 label(s) missing in
#      open-mercato/skills` and would have created it there.
#   2. Remote preference. Given several remotes and no `gh repo set-default`, `gh` picks
#      a remote named `upstream` over one named `origin`. This repository is a fork that
#      carries both, so `gh repo view` answers with the PARENT — verified: in a clone
#      holding origin=ajurzyk/cezar and upstream=open-mercato/cezar it returns
#      open-mercato/cezar. What suppresses that here is `remote.origin.gh-resolved` in
#      .git/config, which is machine-local and unversioned: it protects this checkout and
#      no other, and a fresh clone of the fork gets the upstream's labels rewritten.
#
# Passing the URL closes both, and costs nothing: `gh` still normalizes it (ssh and https
# forms alike) and still fails loudly on a bad token or an unreachable repository.
if ! ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)"; then
  echo "$REPO_ROOT has no 'origin' remote — this script syncs the labels of the repository its own checkout came from, and nothing else names which one that is" >&2
  exit 2
fi
if ! REPO="$(gh repo view "$ORIGIN_URL" --json nameWithOwner --jq .nameWithOwner)"; then
  echo "cannot resolve $ORIGIN_URL (the 'origin' of $REPO_ROOT) — is 'gh' authenticated?" >&2
  exit 2
fi

# The set comes from the config, so extending the taxonomy needs no edit here.
# `do-not-close` is the one addition: it lives outside the config taxonomy on
# purpose (humans apply it, skills only read it) but it has to exist to be usable.
#
# Both reads below capture into a variable first, on purpose. `mapfile -t X < <(cmd)`
# returns 0 whatever `cmd` did — neither `set -e` nor `pipefail` covers a process
# substitution — so a failed read would silently become an empty list: an unreadable
# config would sync nothing, and an unreadable label listing would report the entire
# taxonomy as missing (or, without --check, claim it created every label it in fact
# only failed to skip). Loud beats plausible.
if ! WANTED_RAW="$(jq -r '.labels | (.pipeline // []) + (.category // []) + (.meta // []) + (.priority // []) + (.risk // []) | .[]' "$CONFIG")"; then
  echo "cannot read the label taxonomy from $CONFIG" >&2
  exit 2
fi
mapfile -t WANTED < <(printf '%s\ndo-not-close\n' "$WANTED_RAW" | awk 'NF && !seen[$0]++')

if ! EXISTING_RAW="$(gh api --paginate "repos/$REPO/labels" --jq '.[].name')"; then
  echo "cannot list the labels of $REPO — refusing to continue, because a failed listing is indistinguishable from an empty one" >&2
  exit 2
fi
mapfile -t EXISTING < <(printf '%s' "$EXISTING_RAW" | awk 'NF')

# Three outcomes, not two. An exact match is usable. A label that matches only after
# case folding is NOT usable and must not be reported as present: the tracker's own
# guard (`label_exists` in .ai/trackers/github.md) compares byte-exact with `grep -Fxq`,
# so on a repo carrying `Bug` every `apply_label "bug"` degrades to the logged skip this
# whole change set exists to eliminate. It cannot be repaired here either — GitHub's
# label uniqueness is case-insensitive, so creating the exact-case name comes back 422
# already_exists. Only a human rename fixes it, so name it and fail rather than going
# green over a taxonomy the pipeline cannot actually use.
label_state() {
  local candidate="${1,,}" have
  for have in ${EXISTING+"${EXISTING[@]}"}; do
    if [ "$have" = "$1" ]; then echo exact; return; fi
    if [ "${have,,}" = "$candidate" ]; then echo "case:$have"; return; fi
  done
  echo absent
}

missing=0
created=0
mismatched=0
for name in "${WANTED[@]}"; do
  state="$(label_state "$name")"
  case "$state" in
    exact) continue ;;
    case:*)
      echo "case mismatch: $REPO carries '${state#case:}' where the taxonomy needs '$name' — rename it on GitHub; the tracker's label_exists guard is byte-exact, so every mutation of '$name' silently skips until you do" >&2
      mismatched=$((mismatched + 1))
      continue
      ;;
  esac
  missing=$((missing + 1))
  meta="$(label_meta "$name")"
  color="${meta%%|*}"
  description="${meta#*|}"
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "missing: $name"
    continue
  fi
  # A 422 already_exists means the label appeared between the listing and now (a
  # concurrent run, or a case the listing did not cover) — that is "already present",
  # not a failure, and must not abort the labels still queued behind it. Anything else
  # is a real failure and says so with the API's own words instead of a bare exit code.
  #
  # Capture both streams into one variable: on a failed request `gh api` writes the
  # JSON error body to STDOUT and only a one-line summary ("gh: Validation Failed
  # (HTTP 422)") to stderr, and the `already_exists` code lives in the body — sending
  # stdout to /dev/null would throw away the only copy of the marker and turn every
  # race into a hard exit. The marker cannot false-positive on our own payload:
  # GitHub's validation body carries `resource`/`code`/`field` and never echoes the
  # name, color or description that was submitted. A false miss (GitHub rewording the
  # code) degrades to a loud failure, which is the safe direction.
  if ! resp="$(gh api -X POST "repos/$REPO/labels" \
      -f "name=$name" -f "color=$color" -f "description=$description" 2>&1)"; then
    if printf '%s' "$resp" | grep -q 'already_exists'; then
      echo "already present: $name"
      continue
    fi
    echo "failed to create '$name' in $REPO: $resp" >&2
    exit 1
  fi
  echo "created: $name"
  created=$((created + 1))
done

if [ "$mismatched" -gt 0 ]; then
  echo "$mismatched label(s) exist in $REPO only under a different case and need a manual rename" >&2
fi

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$missing" -gt 0 ]; then
    echo "$missing label(s) missing in $REPO"
    exit 1
  fi
  if [ "$mismatched" -gt 0 ]; then exit 1; fi
  echo "label taxonomy complete in $REPO (${#WANTED[@]} labels)"
  exit 0
fi

echo "done: $created created, $(( ${#WANTED[@]} - created - mismatched )) already present in $REPO"
if [ "$mismatched" -gt 0 ]; then exit 1; fi
exit 0
