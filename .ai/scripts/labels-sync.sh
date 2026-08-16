#!/usr/bin/env bash
# Sync this repository's label taxonomy with `.ai/agentic.config.json`.
#
# The taxonomy is the wire the om-* skills signal each other on: a label that does
# not exist makes every mutation of it a logged skip (see the "Label guards" section
# of .ai/trackers/github.md), so the claim/lock protocol and the review signalling
# silently stop working while every individual step still reports success.
#
# Mutations go through the REST API (`gh api`), never `gh label create` or
# `gh pr/issue edit`: those route through GraphQL, which asks for the retired
# Projects (classic) fields on clients older than gh 2.82.1 and aborts before the
# write lands. The agent host runs gh 2.46.0.
#
# Never deletes, renames, or recolors an existing label.
#
# Usage:
#   bash .ai/scripts/labels-sync.sh            create every missing label
#   bash .ai/scripts/labels-sync.sh --check    report what is missing, create nothing
#                                              (exit 1 when anything is missing)
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

if [ "$(jq -r '.labels.enabled // false' "$CONFIG")" != "true" ]; then
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

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

# The set comes from the config, so extending the taxonomy needs no edit here.
# `do-not-close` is the one addition: it lives outside the config taxonomy on
# purpose (humans apply it, skills only read it) but it has to exist to be usable.
mapfile -t WANTED < <(
  { jq -r '.labels | (.pipeline // []) + (.category // []) + (.meta // []) + (.priority // []) + (.risk // []) | .[]' "$CONFIG"
    echo "do-not-close"
  } | awk 'NF && !seen[$0]++'
)

mapfile -t EXISTING < <(gh api --paginate "repos/$REPO/labels" --jq '.[].name')

is_existing() {
  local candidate="$1" have
  for have in ${EXISTING+"${EXISTING[@]}"}; do
    [ "$have" = "$candidate" ] && return 0
  done
  return 1
}

missing=0
created=0
for name in "${WANTED[@]}"; do
  if is_existing "$name"; then continue; fi
  missing=$((missing + 1))
  meta="$(label_meta "$name")"
  color="${meta%%|*}"
  description="${meta#*|}"
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "missing: $name"
    continue
  fi
  gh api -X POST "repos/$REPO/labels" \
    -f "name=$name" -f "color=$color" -f "description=$description" >/dev/null
  echo "created: $name"
  created=$((created + 1))
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$missing" -gt 0 ]; then
    echo "$missing label(s) missing in $REPO"
    exit 1
  fi
  echo "label taxonomy complete in $REPO (${#WANTED[@]} labels)"
  exit 0
fi

echo "done: $created created, $(( ${#WANTED[@]} - created )) already present in $REPO"
