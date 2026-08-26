# Tracker provider: Forgejo

This file is the Forgejo (Gitea-lineage) implementation of the tracker operations contract (see `TEMPLATE.md` for the contract itself). Skills perform issue/PR state management through **named tracker operations** — `**get-issue**`, `**comment-pr**`, and so on — and this file defines what each operation means for Forgejo, using the `tea` CLI.

## Where this file lives, and how a project gets it

Two paths, and they are not the same one:

| | Path | Committed? |
|---|---|---|
| **Authored source** | `.ai/trackers/forgejo.md` in **cezar's own** repository | yes — and inert there, because that repo's `tracker` is `github` |
| **Provisioned copy** | `.ai/cezar/pipeline/.ai/trackers/forgejo.md` in the **target** repository | no — `.ai/cezar/` is gitignored wholesale in every project cezar touches |
| **Delivered copy** | `.ai/trackers/forgejo.md` inside a **run's worktree** | no — hidden from git in that one worktree |

`om-setup-agent-pipeline` would install the descriptor by committing it into the repository alongside `.ai/agentic.config.json`. That is exactly what must not happen here: the repository is the subject of the work, not a cezar client. So the seam (`packages/cezar/src/pipeline-seam.ts`) copies the provisioned files into the run's worktree and points that one worktree's `core.excludesFile` at them, which is why the run's branch shows no pipeline file in its diff. Provisioning a project is therefore an operator step, run once against the target checkout:

```console
$ mkdir -p <target>/.ai/cezar/pipeline/.ai/trackers
$ cp <cezar>/.ai/trackers/forgejo.md <target>/.ai/cezar/pipeline/.ai/trackers/
$ cat > <target>/.ai/cezar/pipeline/.ai/agentic.config.json <<'JSON'
{ "version": 1, "baseBranch": "auto", "tracker": "forgejo", "labels": { "enabled": true }, "qaGate": true }
JSON
```

A repository that *does* want to own and extend its descriptor commits one at `.ai/trackers/forgejo.md` in the normal way; the seam then leaves it alone, because it never overwrites a tracked path.

## Prerequisites

- **`tea` 0.15.1**, authenticated, with `jq`, `awk`, `sed` and `curl` available. Verify with the **auth-check** operation before a batch run; fail fast when unauthenticated.
- **Version floor: 0.15.1** — the version this descriptor was written and tested against, not an assumed minimum. Two things below exist only in this line and have no fallback here: the `tea api` escape hatch (every mutation goes through it) and `tea pulls edit --draft/--ready`. `github.md`'s own floor was not theoretical — it produced #14 and #18 — so **auth-check** warns rather than guessing.
- Tested against Forgejo `15.0.3+gitea-1.22.0` (`tea api /version`).
- All operations accept an optional `{repo}` (`owner/name`) through the `REPO` variable; when unset, `tracker_repo` derives it from the `origin` remote. It is never left to `tea`'s own `$PWD` inference — see Conventions.

### `tea api` reports failure in the body and still exits 0

This is the single most important fact about this descriptor, and the reason every operation below routes through the `tea_api` helper rather than calling `tea api` directly. Measured 2026-08-26 on `tea` 0.15.1 against Forgejo `15.0.3+gitea-1.22.0`:

```console
$ tea api --repo ajr/cezar-qa '/repos/{owner}/{repo}/pulls/9999' >/dev/null 2>&1; echo $?
0
$ tea api --repo ajr/cezar-qa '/repos/{owner}/{repo}/pulls/9999'
{"message":"The target couldn't be found.","url":"http://q7010-dev.local:8929/api/swagger","errors":[]}
```

So `tea api … || handle_error` never fires, `set -e` never trips, and a label that was never applied reads exactly like one that was. The status line is reachable — `-i` writes the HTTP headers to **stderr** while the body stays on stdout:

```console
$ tea api -i --repo ajr/cezar-qa '/repos/{owner}/{repo}/pulls/9999' 2>hdr >body; head -n1 hdr
HTTP/1.1 404 Not Found
```

`tea api` *does* exit non-zero for failures it detects itself, before any request goes out (`tea api -l nosuchlogin /user` → `Error: login name 'nosuchlogin' does not exist`, exit 1). That is why `tea_api` treats a missing status line as an error too, instead of assuming a response arrived.

**Do not "simplify" any operation below back to a bare `tea api` call.** The exit status of one is not evidence that anything happened.

## Conventions

- Issue and PR identifiers are numbers; in text they are written `#123`. Forgejo shares one number space between issues and pull requests, exactly as GitHub does, and labels/comments/assignees for both live under `/issues/{index}/…`.
- A PR is linked to the issue it resolves with `Fixes #{issueId}` (or `Closes #{issueId}`) in the PR body; Forgejo then closes the issue on merge.
- **Draft PRs are a title prefix.** Forgejo derives `draft` from the title; the accepted list is Gitea's default — `WIP:` and `[WIP]`, case-insensitive. `WIP x` and `Draft:` do **not** count. Measured 2026-08-25 on `ajr/cezar-qa#4`, and already encoded twice in this codebase (`skills/cez/scripts/forge.sh:82-100`, `packages/cezar/src/server/forge/forgejo-map.ts:55` — `WIP_PREFIX_RE = /^(?:\[wip\]|wip:)\s*/i`). The instance's *configured* list is not exposed by the API: 314 swagger routes contain zero occurrences of `work_in_progress` or `prefix`, and `/settings/repository` answers seven unrelated keys. That is why **create-pr** and **mark-pr-ready** both read `draft` back instead of trusting the prefix they sent.
- **Skill-facing serialization is fixed by `TEMPLATE.md`, not by the wire.** PR `state` is `OPEN` / `CLOSED` / `MERGED`; review states are `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`; timestamps are ISO-8601. Forgejo answers `open`/`closed` plus a separate `merged` boolean, and its review states come from Gitea's sources rather than from any documented contract. The `normalize_pr` / `review_decision` helpers do that mapping in one place.
- **Never let an unrecognized review state collapse to approved.** `review_decision` answers `review-required` for anything outside the declared dictionary and flags it — the rule `packages/cezar/src/server/forge/forgejo-map.ts:482` already follows.
- Claim/lock signals on an issue or PR are: assignee set to the automation user, the `in-progress` label, and a `🤖`-prefixed claim comment. All three are set on claim; the label is guarded (below). The `ci-monitoring` label is **not** a claim signal — it marks work that is finished and reported while its CI-result follow-up is still owed, and never makes another skill back off.
- Long, multi-line comment bodies are passed to `tea api` with `-F body=@<file>`, which reads the file into the JSON body, so formatting is preserved and the shell's argument limit is never in play.
- **The target repository is resolved explicitly, never inferred.** `tea` picks a login and a repository from `$PWD`'s remotes when not told otherwise, and #19's first defect was exactly this shape on the GitHub side: `gh repo view` without `set-default` resolved `upstream` rather than `origin`, so a guard checked one repository and mutated another. `tracker_repo` reads `$REPO` when a skill set one and otherwise parses `remote.origin.url` itself, and every command below interpolates the result into `--repo`.
- CI status truth comes from **get-pr-checks**; the set of *required* checks comes from **get-required-checks** (branch protection). When branch protection is not readable (404), treat every reported check as required.

## Label guards

Every label mutation goes through an existence guard so a missing label degrades to a logged skip instead of a failure, and `labels.enabled: false` in the config (`LABELS_ENABLED=false`) skips label operations entirely.

Four things here are deliberately *not* what `github.md` does. `github.md` is verbatim upstream and cannot be patched locally (#19), so its guards carry four defects; this file is ours from the first line and must not transliterate them:

1. **`tracker_repo` resolving the wrong repository** — addressed in Conventions above.
2. **`remove_label` discarding every failure.** `github.md` ends its DELETE with `|| true`, so a permission error, a typo'd label and a network failure are all silently "removed". Measured here, Forgejo answers `204` for removing a label that was never applied — the idempotent case needs no swallowing at all, which means *every* non-2xx is a real failure and is reported:

   ```console
   $ tea api -i -X DELETE --repo ajr/cezar-qa '/repos/{owner}/{repo}/issues/2/labels/probe%2046%20space'
   HTTP/1.1 204 No Content     # label applied → removed
   HTTP/1.1 204 No Content     # same call again, label not applied → still 204
   ```

3. **`label_exists` losing to SIGPIPE.** `github.md` writes `gh api --paginate … | grep -Fxq "$1"`. Under `set -o pipefail`, `grep -q` exits on the first match, the producer takes SIGPIPE, and the pipeline reports failure *for a label that exists*. `label_exists` below matches against a file, which has no upstream to break.
4. **`apply_label` never checking that the POST landed.** Given the exit-code measurement in Prerequisites, this is not a hypothetical: the guard reads its own label back out of the response.

One more thing `github.md` gets for free and this file does not: `tea api` has no `--paginate`, and this instance caps a page (`tea api /settings/api` → `max_response_items: 50`, `default_paging_num: 30`). A single unpaginated request would answer "not defined in this repo" for the 51st label of a taxonomy — a silent, wrong skip. `tracker_labels` loops.

## Runtime helpers

Every operation below assumes these are in scope. They are the whole of this descriptor's machinery; the operations themselves are one command each.

**Every ```bash block before `## Operations` is sourced as a helper definition** — that is the rule `packages/cezar/src/tracker-forgejo.test.ts` uses to assemble the preamble each operation runs with. A snippet that is *illustrative* rather than *runnable* (a measurement, an operator recipe) belongs in a ```console block, or it will execute in front of all 42 operations.

```bash
# --- target repository -----------------------------------------------------
# $REPO when a skill addresses another repository, otherwise `origin`, parsed
# here rather than left to tea's $PWD inference (#19, item 1). Never falls back
# to "whatever tea would have picked": a wrong repository is worse than a stop.
tracker_repo() {
  if [ -n "${REPO:-}" ]; then printf '%s' "$REPO"; return 0; fi
  url=$(git config --get remote.origin.url 2>/dev/null) || url=""
  [ -n "$url" ] || { echo "tracker_repo: no remote.origin.url and REPO is unset" >&2; return 1; }
  case "$url" in
    *://*) url=${url#*://} ;;                  # scheme
    *@*:*) url=${url#*@}; url=${url/:/\/} ;;   # scp-style  host:owner/name
  esac
  url=${url#*@}                                 # userinfo
  url=${url#*/}                                 # host[:port]
  # Trailing slash first: the other order leaves `…/ajr/orakton.git/` as
  # `ajr/orakton.git`, which then passes the `*/*` case below and is returned as
  # a repository handle.
  url=${url%/}; url=${url%.git}; url=${url%/}
  case "$url" in
    */*/*|*/) echo "tracker_repo: '$url' is not owner/name (from $(git config --get remote.origin.url))" >&2; return 1 ;;
    */*) printf '%s' "$url" ;;
    *) echo "tracker_repo: '$url' is not owner/name" >&2; return 1 ;;
  esac
}

# --- the API surface -------------------------------------------------------
# `tea api` exits 0 on every HTTP error (see Prerequisites), so the status line
# is the only verdict. `-i` puts it on stderr; the body stays on stdout.
# Leaves TEA_STATUS and TEA_BODY set for callers that need the failure detail.
tea_api() {
  _h=$(mktemp "${TMPDIR:-/tmp}/tea-h.XXXXXX"); _b=$(mktemp "${TMPDIR:-/tmp}/tea-b.XXXXXX")
  # `|| :` because a non-zero tea (a login it cannot resolve) must reach the
  # status check below, not abort the caller under `set -e`.
  tea api -i --repo "$(tracker_repo)" "$@" 2>"$_h" >"$_b" || :
  TEA_STATUS=$(sed -n '1s@^HTTP/[0-9.]* *\([0-9][0-9][0-9]\).*@\1@p' "$_h")
  TEA_BODY=$(cat "$_b"); rm -f "$_h" "$_b"
  if [ -z "$TEA_STATUS" ]; then
    # No status line at all: tea failed before the request went out (unknown
    # login, unreachable host). Reporting this as an HTTP error would be a lie.
    echo "tea api sent nothing for: $* -- ${TEA_BODY:-no output}" >&2; return 1
  fi
  case "$TEA_STATUS" in
    2??) printf '%s' "$TEA_BODY"; return 0 ;;
  esac
  echo "tea api $TEA_STATUS for: $* -- $TEA_BODY" >&2
  return 1
}

# --- label guards ----------------------------------------------------------
# Every label OBJECT in the target repo, as one JSON array. The loop is not
# optional: `tea api` has no --paginate and a page is capped (this instance:
# `tea api /settings/api` → max_response_items 50, default_paging_num 30).
#
# The loop stops on an EMPTY page and on nothing else. Stopping on a SHORT page
# instead — `[ "$_n" -lt 50 ] && break` — reads as the same thing and is not: it
# assumes the server honours `limit=50`, and `limit` is clamped to the instance's
# MAX_RESPONSE_ITEMS. An administrator who lowered that below 50 makes page one
# come back short, the walk stop early, and every label past it report as
# missing — at which point `apply_label` logs "not defined in this repo" and
# returns 0. That silent, wrong skip is the exact failure this walk exists to
# prevent, so it must not re-enter through the termination condition. One extra
# request per call buys the loop its independence from a server setting.
# Stopping on the empty page means the walk trusts the server to honour `page`.
# It mostly can — but "mostly" is not a termination condition, and a server that
# ignored `page` would spin this loop against the network forever, which is a
# worse failure than the truncation it replaces. So the walk is bounded, and
# hitting the bound is REPORTED rather than treated as the end of the list: at
# 50 per page it is 5000 labels, which no taxonomy reaches, so the bound can only
# mean the paging contract is not being kept.
TRACKER_LABEL_PAGES=${TRACKER_LABEL_PAGES:-100}
tracker_labels_json() {
  _page=1; _all='[]'
  while [ "$_page" -le "$TRACKER_LABEL_PAGES" ]; do
    _body=$(tea_api "/repos/{owner}/{repo}/labels?page=${_page}&limit=50") || return 1
    _n=$(printf '%s' "$_body" | jq 'length')
    if [ "$_n" -eq 0 ]; then printf '%s' "$_all"; return 0; fi
    _all=$(printf '%s\n%s' "$_all" "$_body" | jq -sc 'add')
    _page=$((_page + 1))
  done
  echo "tracker_labels: still receiving labels after $TRACKER_LABEL_PAGES pages; this instance is not honouring ?page= and the taxonomy cannot be read reliably" >&2
  return 1
}

# The same walk, names only, one per line. Under `set -o pipefail` a failed walk
# propagates through the pipe, which is what lets `label_exists` answer 2.
tracker_labels() { tracker_labels_json | jq -r '.[].name'; }

# NOT `tracker_labels | grep -Fxq "$1"`: grep -q exits on the first match, the
# producer takes SIGPIPE, and under `set -o pipefail` a label that DOES exist
# reports as missing (#19, item 3). grep reads a FILE here — nothing to break.
label_exists() {
  _f=$(mktemp "${TMPDIR:-/tmp}/tea-l.XXXXXX")
  if ! tracker_labels >"$_f"; then rm -f "$_f"; return 2; fi
  if grep -Fxq -- "$1" "$_f"; then rm -f "$_f"; return 0; fi
  rm -f "$_f"; return 1
}

# PR labels. $1 = label, $2 = PR number. Labels are added by NAME (measured:
# `-F 'labels=["probe 46 space"]'` → 200), so no id lookup is needed.
apply_label() {
  [ "${LABELS_ENABLED:-true}" = "true" ] || return 0
  # `label_exists "$1"; _e=$?` would abort under `set -e` before $? is ever read.
  _e=0; label_exists "$1" || _e=$?
  if [ "$_e" -eq 2 ]; then return 1; fi            # could not read the taxonomy: not a skip
  if [ "$_e" -ne 0 ]; then
    echo "Skipping label '$1' (not defined in this repo). Create it with: tea labels create --repo $(tracker_repo) --name '$1' --color ededed"
    return 0
  fi
  _out=$(tea_api -X POST "/repos/{owner}/{repo}/issues/$2/labels" \
                 -F "labels=$(jq -nc --arg l "$1" '[$l]')") || return 1
  # The POST answers with the issue's resulting label set. Reading our own label
  # back out of it is what separates "applied" from "the call 404'd, exit 0"
  # (#19, item 4).
  printf '%s' "$_out" | jq -e --arg l "$1" 'map(.name) | index($l) != null' >/dev/null || {
    echo "Label '$1' did not land on #$2: $_out" >&2; return 1; }
}

# Issues and PRs share the /issues/ endpoint, so this delegates; it keeps its own
# name because skills call the guards by name. $1 = label, $2 = issue id.
apply_issue_label() { apply_label "$1" "$2"; }

# Removal. $1 = label, $2 = PR or issue number. Removing a label that is not
# applied answers 204 on this instance, so there is no "expected failure" to
# swallow — every non-2xx is real and is reported (#19, item 2).
remove_label() {
  [ "${LABELS_ENABLED:-true}" = "true" ] || return 0
  # The name is a path segment: encode it, or a label with a space or a slash
  # addresses something else entirely.
  _enc=$(printf '%s' "$1" | jq -sRr @uri)
  tea_api -X DELETE "/repos/{owner}/{repo}/issues/$2/labels/${_enc}" >/dev/null || {
    echo "Failed to remove label '$1' from #$2 (HTTP ${TEA_STATUS:-?}): $TEA_BODY" >&2; return 1; }
}
remove_issue_label() { remove_label "$1" "$2"; }

# Pipeline labels are mutually exclusive: setting one removes the others first.
# Note the argument order, matching github.md: $1 = PR number, $2 = label.
set_pipeline_label() {
  [ "${LABELS_ENABLED:-true}" = "true" ] || return 0
  for _label in $PIPELINE_LABELS; do
    if [ "$_label" = "$2" ]; then continue; fi
    remove_label "$_label" "$1" || return 1
  done
  apply_label "$2" "$1"
}

# --- serialization ---------------------------------------------------------
# TEMPLATE.md fixes the skill-facing shape; Forgejo answers something else.
# One place does the mapping so no operation re-derives it.
#
# `mergeable` and `mergeStateStatus` are the fields skills read to decide whether
# a head can merge, and passing Forgejo's raw boolean through under github.md's
# NAME would be worse than omitting it: `om-auto-review-pr` step 4a tests
# `mergeable == "CONFLICTING"` / `mergeStateStatus == "DIRTY"`, and a `false`
# satisfies neither, so a conflicted head would be reviewed, fixed and pushed as
# though it merged cleanly. Forgejo exposes one bit here, so DIRTY is the only
# merge state this descriptor can assert; everything else is UNKNOWN rather than
# CLEAN, because Forgejo does not say whether the PR is behind, blocked or
# unstable, and a skill must not read our ignorance as a green light.
#
# `comments` is deliberately NOT in this object. Forgejo's `comments` is an
# integer count (measured on ajr/cezar-qa: `{"number":2,"comments":0}`, type
# number), where github.md answers the comment ARRAY — so mapping it through
# under the same name hands a consumer scanning for a `🤖` claim comment a
# number. It is exposed as `commentCount`, and the list comes from
# **list-issue-comments**.
normalize_pr() {
  jq '{
    number, title, url: .html_url, body: (.body // ""),
    state: (if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end),
    author: .user.login, isDraft: .draft,
    baseRefName: .base.ref, baseRefOid: .base.sha,
    headRefName: .head.ref, headRefOid: .head.sha,
    headRepository: (.head.repo.full_name // null),
    headRepositoryOwner: (.head.repo.owner.login // null),
    isCrossRepository: ((.head.repo.full_name // "") != (.base.repo.full_name // "")),
    maintainerCanModify: .allow_maintainer_edit,
    mergeable: (if .mergeable == true then "MERGEABLE"
                elif .mergeable == false then "CONFLICTING"
                else "UNKNOWN" end),
    mergeStateStatus: (if .mergeable == false then "DIRTY" else "UNKNOWN" end),
    mergeCommit: .merge_commit_sha,
    labels: [.labels[]?.name], assignees: [.assignees[]?.login],
    commentCount: .comments,
    createdAt: .created_at, mergedAt: .merged_at, closedAt: .closed_at,
    additions: .additions, changedFiles: .changed_files
  }'
}

# The review-state dictionary is a CONTRACT, not a measurement. Producing
# APPROVED / REQUEST_CHANGES on this instance is impossible with the available
# credentials (measured 2026-08-26: POST …/reviews {"event":"REQUEST_CHANGES"}
# → 422 "reject your own pull is not allowed"; {"event":"APPROVED"} → 422
# "approve your own pull is not allowed"; the host has one credential set, the
# token is not an admin — GET /admin/users → 403 — and no other account has a
# token). The left-hand side is derived from Gitea's sources, the same six
# values `packages/cezar/src/server/forge/forgejo-map.ts:428` knows.
#
# A state outside the dictionary must NEVER become approved: it resolves to
# review-required and is flagged, following forgejo-map.ts:482.
# The dictionary itself, written ONCE and interpolated by its three consumers.
# A contract copied per call site is a contract that drifts per call site, and a
# state that drifts to the wrong side here approves a PR nobody approved.
REVIEW_STATE_JQ='if   .dismissed                   then "DISMISSED"
                 elif .state == "APPROVED"         then "APPROVED"
                 elif .state == "REQUEST_CHANGES"  then "CHANGES_REQUESTED"
                 elif .state == "COMMENT"          then "COMMENTED"
                 else "UNRECOGNIZED" end'
# A review that has not been submitted is not a verdict: PENDING is the author's
# own unsubmitted draft and REQUEST_REVIEW is an invitation, so both are dropped
# before anything counts them.
REVIEW_SUBMITTED_JQ='select(.state != "PENDING" and .state != "REQUEST_REVIEW" and .state != "")'

review_state() {   # stdin: a Forgejo review object → the TEMPLATE.md state
  jq -r "$REVIEW_STATE_JQ"
}

# stdin: a Forgejo /pulls/{n}/reviews array → {reviews, latestReviews} in the
# TEMPLATE.md shape. get-pr needs these as fields: om-auto-review-pr step 3 reads
# `reviews` (falling back to `latestReviews`) to tell a review from a re-review,
# and step 2b mines the bodies for feedback already on the PR. `review_decision`
# reads the same route but answers only a decision string, so it cannot stand in.
# `latestReviews` is the newest submitted review per author, as github.md answers.
pr_reviews() {
  jq -c "[ .[] | $REVIEW_SUBMITTED_JQ
         | { author: .user.login, body: (.body // \"\"), submittedAt: .submitted_at,
             state: ($REVIEW_STATE_JQ) } ]
         | { reviews: ., latestReviews: (group_by(.author) | map(max_by(.submittedAt))) }"
}

review_decision() {   # $1 = PR number → {decision, unrecognized}
  tea_api "/repos/{owner}/{repo}/pulls/$1/reviews" | jq -c "
    [ .[] | $REVIEW_SUBMITTED_JQ | ($REVIEW_STATE_JQ) ] as \$states
    | if   (\$states | index(\"UNRECOGNIZED\")) then {decision:\"review-required\", unrecognized:true}
      elif (\$states | index(\"CHANGES_REQUESTED\")) then {decision:\"changes-requested\", unrecognized:false}
      elif (\$states | index(\"APPROVED\")) then {decision:\"approved\", unrecognized:false}
      else {decision:\"review-required\", unrecognized:false} end"
}
```

## Operations

### Identity and repository

#### auth-check
Verify the CLI is authenticated and new enough. → exit status (non-zero when unauthenticated), plus a warning on stdout when the client predates the version this descriptor was tested against.
```bash
# A live identity query, not `tea login list`: a stale token still lists fine.
tea_api /user >/dev/null || exit 1

# `tea --version` colours the number, and it does so even when stdout is a pipe:
#
#   $ tea --version | head -1 | cat -v
#   Version: ^[[1m0.15.1^[[0m	golang: 1.26.5	go-sdk: v1.2.0
#
# A parse anchored on `Version: *[0-9]` therefore matches nothing and reports
# every client as "unknown", i.e. warns on the very version it was written for.
# The ESC is built with printf rather than written as `\x1b`, which GNU sed
# understands and BSD sed does not.
ESC=$(printf '\033')
TEA_VERSION=$(tea --version 2>/dev/null \
  | sed -e "s/${ESC}\\[[0-9;]*m//g" -n -e '1s/.*Version:[[:space:]]*\([0-9][0-9.]*\).*/\1/p')
MIN_TEA_VERSION=0.15.1
if [ "$(printf '%s\n%s\n' "$MIN_TEA_VERSION" "$TEA_VERSION" | sort -V | head -n1)" != "$MIN_TEA_VERSION" ]; then
  echo "WARNING: tea ${TEA_VERSION:-unknown} predates $MIN_TEA_VERSION — this descriptor routes every mutation through 'tea api', which older clients do not have."
fi
```
`sort -V` exists on GNU and BSD/macOS `sort`; where it does not, compare `tea --version` against 0.15.1 by inspection and report the same warning.

#### current-user
→ the automation user's login.
```bash
CURRENT_USER=$(tea_api /user | jq -r '.login')
```

#### repo-info
→ `owner/name` handle and default branch of the target repository.
```bash
tea_api '/repos/{owner}/{repo}' | jq '{nameWithOwner: .full_name, defaultBranchRef: {name: .default_branch}}'
REPO=$(tracker_repo)
```

#### default-branch
→ the repository's default branch name (used when the config's `baseBranch` is `"auto"`).
```bash
BASE_BRANCH=$(tea_api '/repos/{owner}/{repo}' 2>/dev/null | jq -r '.default_branch // empty') || BASE_BRANCH=""
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@') || BASE_BRANCH=""
fi
if [ -z "$BASE_BRANCH" ]; then BASE_BRANCH="main"; fi
```

### Issues

#### get-issue
`{issueId}`, field list → issue data. Forgejo shares one number space between issues and PRs; this endpoint answers for both, and `.pull_request` is non-null when the number is a PR.
```bash
tea_api "/repos/{owner}/{repo}/issues/${ISSUE}" | jq '{
  number, title, body: (.body // ""), state: (.state | ascii_upcase),
  author: .user.login, url: .html_url,
  labels: [.labels[]?.name], assignees: [.assignees[]?.login],
  commentCount: .comments, isPullRequest: (.pull_request != null)
}'
```
**`commentCount` is a count, and it is named that way on purpose.** `github.md`'s `comments` is the comment **array**; Forgejo's is an integer (measured on `ajr/cezar-qa`: `{"number": 2, "comments": 0}`, type `number`). Mapping it through under github's name would hand a caller scanning for the `🤖` claim comment a number that quietly satisfies a truthiness test, so the shapes are kept distinguishable and the list has its own operation: **list-issue-comments**. The claim protocol's other two signals — the assignee and the `in-progress` label — are both in the object above, so a lock stays detectable from this operation alone.

#### search-issues
Query (text, state) → matching issues. `type=issues` keeps pull requests out of the result; drop it to search both.
```bash
tea_api "/repos/{owner}/{repo}/issues?state=${STATE:-open}&type=issues&q=$(printf '%s' "$QUERY" | jq -sRr @uri)&limit=50" \
  | jq '[.[] | {number, title, url: .html_url}]'
```

#### create-issue
Title, body, assignee, labels → created issue URL. Labels are passed as **ids** here (Forgejo's create endpoint takes ids, unlike the add-label endpoint which takes names), so they are resolved first; an unknown one is skipped with a log rather than failing the create.

The lookup walks the taxonomy through `tracker_labels_json` for the reason the Label guards section gives: a single `?limit=50` would answer "not defined in this repo" for the 51st label, silently and wrongly, and this operation has no more right to that bug than the guard does. The walk is captured once and read twice, so pagination costs no extra round trip per label.
```bash
ALL_LABELS=$(tracker_labels_json) || exit 1
LABEL_IDS=$(printf '%s' "$ALL_LABELS" \
  | jq -c --arg want "$LABELS" '($want | if . == "" then [] else split(",") end) as $w
                                | [.[] | select(.name as $n | $w | index($n)) | .id]')
# The log the contract promises. A label silently missing from a created issue is
# a pipeline state nobody set, discovered much later than here.
UNKNOWN=$(printf '%s' "$ALL_LABELS" \
  | jq -r --arg want "$LABELS" '[.[].name] as $have
                                | ($want | if . == "" then [] else split(",") end)
                                | map(select(. as $n | $have | index($n) | not)) | join(", ")')
[ -z "$UNKNOWN" ] || echo "Skipping labels not defined in this repo: $UNKNOWN"
tea_api -X POST '/repos/{owner}/{repo}/issues' \
  -f "title=${TITLE}" -F "body=@${BODY_FILE}" \
  -F "assignees=$(jq -nc --arg a "$LOGIN" '[$a]')" -F "labels=${LABEL_IDS}" \
  | jq -r '.html_url'
```

#### close-issue
`{issueId}`, reason, closing comment. Forgejo has no close *reason*; the reason is recorded in the closing comment, which is posted first so it is never lost if the state change fails.
```bash
tea_api -X POST "/repos/{owner}/{repo}/issues/${ISSUE}/comments" -F "body=@${BODY_FILE}" >/dev/null
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${ISSUE}" -f 'state=closed' | jq -r '.state'
```

#### comment-issue
`{issueId}`, body. `-F body=@<file>` reads the file into the JSON body, so multi-line bodies survive and never touch a command line.
```bash
tea_api -X POST "/repos/{owner}/{repo}/issues/${ISSUE}/comments" -F "body=@${BODY_FILE}" | jq -r '.html_url'
```

#### update-issue
`{issueId}`, new title and/or body. Edits the issue's own fields; does not touch labels or assignees (those have their own operations). Pass only what changed.
```bash
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${ISSUE}" -f "title=${TITLE}" >/dev/null
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${ISSUE}" -F "body=@${BODY_FILE}" >/dev/null
```
`tea issues edit ${ISSUE} --title … --description …` does the same interactively, but it takes the body as a command-line argument, so a long body is at the mercy of the argument limit and of the shell's quoting — script the API form.

#### assign-issue / unassign-issue
Forgejo has no add/remove assignee endpoints; the PATCH replaces the whole set. Read the current set and edit it, or a second skill's claim silently unassigns the first.
```bash
CURRENT=$(tea_api "/repos/{owner}/{repo}/issues/${ISSUE}" | jq -c '[.assignees[]?.login]')
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${ISSUE}" \
  -F "assignees=$(printf '%s' "$CURRENT" | jq -c --arg a "$LOGIN" '. + [$a] | unique')" >/dev/null
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${ISSUE}" \
  -F "assignees=$(printf '%s' "$CURRENT" | jq -c --arg a "$LOGIN" 'map(select(. != $a))')" >/dev/null
```

#### label-issue / unlabel-issue
Always through the guards: `apply_issue_label "<label>" ${ISSUE}` / `remove_issue_label "<label>" ${ISSUE}`.

#### get-issue-comment
Comment id → body, author, URL.
```bash
tea_api "/repos/{owner}/{repo}/issues/comments/${COMMENT_ID}" | jq '{body, user: .user.login, url: .html_url}'
```

#### list-issue-comments
`{issueId or prNumber}` → conversation comments (PR conversation comments are issue comments on Forgejo too). Paginated for the same reason the label guard is.
```bash
tea_api "/repos/{owner}/{repo}/issues/${ISSUE}/comments?page=${PAGE:-1}&limit=50" \
  | jq '[.[] | {id, user: .user.login, body, createdAt: .created_at, url: .html_url}]'
```

#### update-comment
`{commentId}`, new body → rewrite an existing conversation comment in place (issue and PR conversation comments alike). This is how marker-idempotent comments (label rationale, verification, claim take-overs) are updated on re-runs: find your `🤖 …` marker via **list-issue-comments**, then update that comment instead of posting a new one.
```bash
tea_api -X PATCH "/repos/{owner}/{repo}/issues/comments/${COMMENT_ID}" -F "body=@${BODY_FILE}" | jq -r '.html_url'
```

### Pull requests

#### get-pr
`{prNumber}`, field list → PR data, serialized as `TEMPLATE.md` requires (`OPEN`/`CLOSED`/`MERGED`, ISO-8601 timestamps) rather than as Forgejo answers.
```bash
# ONE object, as github.md answers — `reviews` / `latestReviews` merely live on
# their own route here, which is this descriptor's problem and not the caller's.
# A caller that never reads reviews can run the first line alone and skip the
# second request; anything that reads them must not have to merge two blobs.
PR_OBJECT=$(tea_api "/repos/{owner}/{repo}/pulls/${PR}" | normalize_pr) || exit 1
PR_REVIEWS=$(tea_api "/repos/{owner}/{repo}/pulls/${PR}/reviews" | pr_reviews) || exit 1
printf '%s\n%s' "$PR_OBJECT" "$PR_REVIEWS" | jq -sc 'add'
```

**What this answers, against the field list `github.md` documents.** The list is not a suggestion — skills name these fields — so every one is accounted for here rather than left to be discovered as a `null`:

| Field | Here |
|---|---|
| `number`, `title`, `url`, `body`, `state`, `author`, `isDraft` | `normalize_pr`, `state` as `OPEN`/`CLOSED`/`MERGED` |
| `baseRefName`, `baseRefOid`, `headRefName`, `headRefOid` | `normalize_pr` |
| `headRepository`, `headRepositoryOwner`, `isCrossRepository` | `normalize_pr` |
| `maintainerCanModify` | `normalize_pr`, from `allow_maintainer_edit` |
| `mergeable`, `mergeStateStatus` | `normalize_pr`, mapped — see the helper's note on why the raw boolean must not pass through under these names |
| `labels`, `assignees` | `normalize_pr` |
| `createdAt`, `mergedAt`, `closedAt`, `mergeCommit`, `additions`, `changedFiles` | `normalize_pr` |
| `reviews`, `latestReviews` | the second call, through `pr_reviews` |
| `comments` | **not** in `normalize_pr`. Forgejo's `comments` is an integer count, not the array `github.md` answers, so it is exposed as `commentCount` and the list comes from **list-issue-comments** |
| `files` | **get-pr-files**, its own operation, rather than a field — the changed-file list is what `om-auto-review-pr` scopes its review with |
| `commits` | `/repos/{owner}/{repo}/pulls/${PR}/commits`, deliberately not folded in. Skills do name it (`om-auto-review-pr/references/pr-metadata.md`, `om-pr-autopilot/references/diagnose.md`), but they decide "are there new commits" from `headRefOid`, which is in the object above — so folding it in would cost a third request per **get-pr** to answer a question already answered. Call the route directly if you need the list itself |
| `reviewDecision` | genuinely absent. `review_decision` is the replacement, and it is better than the field: it makes the unrecognized-state case explicit instead of hiding it behind a value |
| `closingIssuesReferences` | genuinely absent, and this one has real consumers to disappoint: `om-close-fixed-issues` calls it "the tracker's authoritative parse" and `om-auto-update-changelog` appends `(fixes #N)` from it. Forgejo exposes no parsed list on either **get-pr** or **list-prs**, so on a Forgejo project both skills fall back to reading `Fixes #n` out of the body themselves. Flagged here rather than left to be discovered as a `null` |

#### list-prs
State/search filters, field list, limit → PRs.
```bash
tea_api "/repos/{owner}/{repo}/pulls?state=${STATE:-open}&page=${PAGE:-1}&limit=${LIMIT:-50}" \
  | jq '[.[] | {number, title, url: .html_url, author: .user.login, labels: [.labels[]?.name],
                mergeable, headRefName: .head.ref, baseRefName: .base.ref,
                updatedAt: .updated_at, isDraft: .draft, assignees: [.assignees[]?.login],
                state: (if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end),
                createdAt: .created_at, mergedAt: .merged_at, closedAt: .closed_at}]'
```
Forgejo's `/pulls` filter has no `merged:>=<date>` search grammar. A "merged since" list is `state=closed` filtered client-side on `mergedAt`; an "unmerged closed" list is the same page with `.merged == false`.

#### search-prs
Free-text query (for example an issue reference) and state → matching PRs. `type=pulls` on the issue search is the only text search that reaches pull requests.
```bash
tea_api "/repos/{owner}/{repo}/issues?type=pulls&state=${STATE:-open}&q=$(printf '%s' "$QUERY" | jq -sRr @uri)&limit=50" \
  | jq '[.[] | {number, title, url: .html_url, state: (.state | ascii_upcase)}]'
```

#### create-pr
Base branch, draft flag, title, body → PR URL + number. A draft is the `WIP: ` title prefix (see Conventions) — and the result is read back, because the prefix list is the instance's, not ours.
```bash
TITLE_TO_SEND=$TITLE
if [ "${DRAFT:-false}" = "true" ]; then TITLE_TO_SEND="WIP: $TITLE"; fi
CREATED=$(tea_api -X POST '/repos/{owner}/{repo}/pulls' \
  -f "head=${HEAD_BRANCH}" -f "base=${BASE_BRANCH}" -f "title=${TITLE_TO_SEND}" -F "body=@${BODY_FILE}") || exit 1
PR_NUMBER=$(printf '%s' "$CREATED" | jq -r '.number')
PR_URL=$(printf '%s' "$CREATED" | jq -r '.html_url')
if [ "${DRAFT:-false}" = "true" ] && [ "$(printf '%s' "$CREATED" | jq -r '.draft')" != "true" ]; then
  echo "PR #$PR_NUMBER was created but is NOT a draft: this instance did not accept the 'WIP: ' prefix." >&2
  exit 1
fi
```

#### update-pr
`{prNumber}`, new title and/or new body → the PR's own title/body rewritten in place (not a comment), e.g. describing what a PR actually ships once its scope changed. Pass whichever changed; omit the other.
```bash
tea_api -X PATCH "/repos/{owner}/{repo}/pulls/${PR}" -f "title=${TITLE}" >/dev/null
tea_api -X PATCH "/repos/{owner}/{repo}/pulls/${PR}" -F "body=@${BODY_FILE}" >/dev/null
```
Editing the title of a draft PR keeps the `WIP:` prefix intact only if you send it; a title rewrite that drops the prefix silently promotes the PR. Compose the new title from the current one when the draft state must not change.

#### comment-pr
`{prNumber}`, body. PR conversation comments are issue comments on Forgejo, so this is the same endpoint as **comment-issue**.
```bash
tea_api -X POST "/repos/{owner}/{repo}/issues/${PR}/comments" -F "body=@${BODY_FILE}" | jq -r '.html_url'
```

#### attach-image-evidence
`{prNumber}`, a markdown comment body (without the images), a `{slug}` (e.g. `pr-{prNumber}`), and a list of local PNG paths → post one comment with the images embedded **inline**, and return the comment URL.

Forgejo *does* accept image bytes, through the issue-attachment endpoint — no evidence branch, and therefore nothing to say about never touching the change's own branch beyond: this operation does not go near it. Measured 2026-08-26 on `ajr/cezar-qa` (probe deleted afterwards): `POST /repos/{owner}/{repo}/issues/{n}/assets` with `-F attachment=@shot.png` → **201** with a `browser_download_url`.

Two things make this the one operation in this file that reaches past `tea`:

- The endpoint takes `multipart/form-data`, and `tea api`'s `-F` builds a **JSON** field, not a form part. Measured: `tea api -X POST … /assets -F 'attachment=@shot.png'` → `HTTP/1.1 500 Internal Server Error`. There is no `tea` verb for attachments either. So this one call is `curl`, authenticated with the credentials `tea` itself stores.
- Limits are the instance's and are enforced *here*, so an over-limit file degrades instead of failing the caller (`TEMPLATE.md:59`). From `tea api /settings/attachment`: `enabled: true`, `max_size: 2048` (KB), `max_files: 5`, `.png`/`.jpg` among the allowed types.

```bash
# tea's own config is the credential source — the same file `tea api` reads, so
# this cannot authenticate against a different instance than the rest of the file.
TEA_CFG=${TEA_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/tea/config.yml}
LOGIN_LINE=$(awk '
  function flush() { if (name != "") { n++; urls[n]=url; toks[n]=tok; if (def) chosen=n } }
  /^- name:/                         { flush(); name=$3; url=""; tok=""; def=0; next }
  /^[ \t]+url:[ \t]/                 { url=$2; next }
  /^[ \t]+token:[ \t]/               { tok=$2; next }
  /^[ \t]+default:[ \t]*true[ \t]*$/ { def=1; next }
  /^[^ \t-]/                         { flush(); name="" }
  END { flush(); if (n == 0) exit 1; if (!chosen) chosen=1
        sub(/\/+$/, "", urls[chosen]); printf "%s\t%s\n", urls[chosen], toks[chosen] }
' "$TEA_CFG") || { echo "no tea login in $TEA_CFG" >&2; exit 1; }
FORGE_URL=${LOGIN_LINE%%	*}; FORGE_TOKEN=${LOGIN_LINE##*	}
# Prove the credentials belong to the login `tea api` uses, rather than to some
# other block in the same file.
[ "$(curl -sf -H "Authorization: token $FORGE_TOKEN" "$FORGE_URL/api/v1/user" | jq -r .login)" \
  = "$(tea_api /user | jq -r .login)" ] || { echo "tea config login does not match the API login" >&2; exit 1; }

MAX_KB=$(tea_api /settings/attachment | jq -r '.max_size')
MAX_FILES=$(tea_api /settings/attachment | jq -r '.max_files')
BODY_IMAGES=""; DEGRADED=""; UPLOADED=0
for img in $IMAGES; do
  size_kb=$(( ($(wc -c < "$img") + 1023) / 1024 ))
  case "$img" in *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG) allowed=yes ;; *) allowed=no ;; esac
  if [ "$allowed" = no ] || [ "$size_kb" -gt "$MAX_KB" ] || [ "$UPLOADED" -ge "$MAX_FILES" ]; then
    DEGRADED="${DEGRADED}
- \`$img\` (${size_kb} KB) — not uploaded: the instance allows ${MAX_FILES} files of at most ${MAX_KB} KB, .png/.jpg only. The file is on the run host at that path."
    continue
  fi
  asset=$(curl -s -X POST -H "Authorization: token $FORGE_TOKEN" \
               -F "attachment=@${img}" \
               "$FORGE_URL/api/v1/repos/$(tracker_repo)/issues/${PR}/assets")
  url=$(printf '%s' "$asset" | jq -r '.browser_download_url // empty')
  [ -n "$url" ] || { DEGRADED="${DEGRADED}
- \`$img\` — upload failed: $asset"; continue; }
  # `browser_download_url` carries the instance's configured ROOT_URL, which on
  # this deployment is a THIRD host spelling — `q7010-dev.local:8929`, neither
  # the API host nor the container-internal one — and does not resolve from the
  # agent's network (measured: curl → 000). Re-point it at the host that just
  # authenticated (measured: 404 anonymous, 200 image/png with credentials).
  url="$FORGE_URL/${url#*://*/}"
  BODY_IMAGES="${BODY_IMAGES}
![$(basename "$img")](${url})"
  UPLOADED=$((UPLOADED + 1))
done

{ cat "$BODY_FILE"; printf '%s\n' "$BODY_IMAGES"
  if [ -n "$DEGRADED" ]; then printf '\n**Not attached:**%s\n' "$DEGRADED"; fi
} > "${BODY_FILE}.evidence"
tea_api -X POST "/repos/{owner}/{repo}/issues/${PR}/comments" -F "body=@${BODY_FILE}.evidence" | jq -r '.html_url'
```

Rendering in a private repository: the attachment URL is 404 anonymously and 200 `image/png` with credentials, so a signed-in reader sees the image inline and an anonymous link is dead. `ajr/cezar-qa` is itself `private: true`, which is what makes that measurement transfer. The comment is posted either way — the contract is to say what could not be attached, never to fail the caller.

#### assign-pr / unassign-pr
Assignees live on the shared `/issues/` endpoint for PRs too, and the same replace-the-whole-set caveat applies as for **assign-issue**.
```bash
CURRENT=$(tea_api "/repos/{owner}/{repo}/issues/${PR}" | jq -c '[.assignees[]?.login]')
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${PR}" \
  -F "assignees=$(printf '%s' "$CURRENT" | jq -c --arg a "$LOGIN" '. + [$a] | unique')" >/dev/null
tea_api -X PATCH "/repos/{owner}/{repo}/issues/${PR}" \
  -F "assignees=$(printf '%s' "$CURRENT" | jq -c --arg a "$LOGIN" 'map(select(. != $a))')" >/dev/null
```

#### label-pr / unlabel-pr
Always through the guards: `apply_label "<label>" ${PR}` / `set_pipeline_label ${PR} "<label>"` for the mutually exclusive pipeline group; direct removal: `remove_label "<label>" ${PR}`.

#### get-pr-diff
`{prNumber}` → full diff, or the changed-file list.
```bash
tea_api "/repos/{owner}/{repo}/pulls/${PR}.diff"
tea_api "/repos/{owner}/{repo}/pulls/${PR}/files?limit=50" | jq -r '.[].filename'
```

#### get-pr-files
`{prNumber}` → changed files with per-file status (added/modified/removed), paginated.
```bash
tea_api "/repos/{owner}/{repo}/pulls/${PR}/files?page=${PAGE:-1}&limit=50" \
  | jq '[.[] | {path: .filename, status}]'
```

#### checkout-pr
`{prNumber}` → the PR's head available locally (needed for cross-repository fork PRs where the head branch cannot be fetched from `origin`). This is a local git helper, not an API call, so it is the one place a `tea` verb is the right tool.
```bash
tea pulls checkout "${PR}" --repo "$(tracker_repo)" --branch
```

#### review-pr
`{prNumber}`, verdict (approve / request changes), body.
```bash
tea_api -X POST "/repos/{owner}/{repo}/pulls/${PR}/reviews" \
  -f 'event=APPROVED' -F "body=@${BODY_FILE}" | jq '{id, state}'
tea_api -X POST "/repos/{owner}/{repo}/pulls/${PR}/reviews" \
  -f 'event=REQUEST_CHANGES' -F "body=@${BODY_FILE}" | jq '{id, state}'
review_decision "${PR}"
```
Forgejo rejects self-review with `422 approve your own pull is not allowed` / `422 reject your own pull is not allowed` (measured 2026-08-26). Surface that instead of working around it, as `github.md:326` already requires. Read the verdict back with `review_decision`, which answers `review-required` — never `approved` — for a state outside the declared dictionary.

#### merge-pr
`{prNumber}`; squash is the default merge strategy. Forgejo has no "merge when checks pass" equivalent of `--auto`: a skill that wants that behavior watches the checks itself (**get-pr-checks**) and merges when they are green.
```bash
tea_api -X POST "/repos/{owner}/{repo}/pulls/${PR}/merge" -f 'Do=squash' >/dev/null
tea_api "/repos/{owner}/{repo}/pulls/${PR}" | jq '{merged, mergedAt: .merged_at}'
```
The merge endpoint answers `200` with an empty body, so the read-back is what distinguishes a merge from a request that was accepted and then blocked.

#### mark-pr-ready
Promote a draft PR by stripping the WIP prefix from its title — and prove it worked.
```bash
CURRENT_TITLE=$(tea_api "/repos/{owner}/{repo}/pulls/${PR}" | jq -r '.title')
# The prefixes are Gitea's default list, case-insensitive: `WIP:` and `[WIP]`.
READY_TITLE=$(printf '%s' "$CURRENT_TITLE" | sed -E 's/^(\[[Ww][Ii][Pp]\]|[Ww][Ii][Pp]:)[[:space:]]*//')
tea_api -X PATCH "/repos/{owner}/{repo}/pulls/${PR}" -f "title=${READY_TITLE}" >/dev/null || exit 1
if [ "$(tea_api "/repos/{owner}/{repo}/pulls/${PR}" | jq -r '.draft')" = "true" ]; then
  echo "PR #${PR} is still a draft after retitling to '${READY_TITLE}'. This instance's WIP prefix list is not '[WIP]'/'WIP:' — the API does not expose it (314 swagger routes, zero occurrences of 'work_in_progress'), so it has to be read from the instance config." >&2
  exit 1
fi
```
`tea pulls edit ${PR} --ready` performs the same strip. It is not used here for the reason the read-back exists: it reports success from the PATCH's exit status, which cannot distinguish a promotion from a title edit that left `draft` true.

#### get-pr-checks
`{prNumber}` → CI check runs with name, state, and link. Forgejo models these as **commit statuses** on the PR head.
```bash
HEAD_SHA=$(tea_api "/repos/{owner}/{repo}/pulls/${PR}" | jq -r '.head.sha')
tea_api "/repos/{owner}/{repo}/commits/${HEAD_SHA}/statuses?limit=50" \
  | jq '[.[] | {name: .context, state: (.status | ascii_upcase), link: .target_url}]'
tea_api "/repos/{owner}/{repo}/commits/${HEAD_SHA}/status" | jq '{state, total: .total_count}'
```
An empty `statuses` array with `total_count: 0` means *no CI ran*, which is not the same as *CI passed* — a repository with no Actions workflow answers exactly that (measured on `ajr/cezar-qa`). Treat it as "no signal" and say so, rather than as a green gate.

#### get-required-checks
Base branch → the set of required status checks. A 404 means branch protection is not configured or not readable — treat every reported check as required.
```bash
# The degradation has to happen HERE, not in whatever the caller appends. This
# operation's 404 is the measured DEFAULT on the tested instance, and every block
# in this file may be executed under `set -euo pipefail`: piping `tea_api`
# straight into jq makes that ordinary case return 1 and abort the calling skill
# before the rule above can be applied. Capture first, then decide.
PROTECTION=$(tea_api "/repos/{owner}/{repo}/branch_protections/${BASE_BRANCH}" 2>/dev/null) || PROTECTION=""
if [ -n "$PROTECTION" ]; then
  printf '%s' "$PROTECTION" | jq -r '.status_check_contexts[]?'
fi
```
Empty output therefore means "the forge requires nothing" — which for a merge decision reads as "every check the PR reports is required", exactly as an unreadable protection does. The two are deliberately indistinguishable, because the resulting decision is the same one.
Measured on `ajr/cezar-qa`: `/branch_protections` → `[]`, `/branch_protections/main` → `404`. Both mean "nothing is required by the forge", which for a merge decision reads as "every check the PR reports is required".

#### get-pr-comment / get-review-comment
Conversation comment id vs inline review comment id → body, author, URL. Forgejo has no flat `/pulls/{n}/comments` route (measured: 404), so an inline comment is addressed through the review that carries it.
```bash
tea_api "/repos/{owner}/{repo}/issues/comments/${COMMENT_ID}" | jq '{body, user: .user.login, url: .html_url}'
tea_api "/repos/{owner}/{repo}/pulls/${PR}/reviews/${REVIEW_ID}/comments" \
  | jq --arg id "$COMMENT_ID" '.[] | select(.id == ($id | tonumber)) | {body, user: .user.login, url: .html_url}'
```

#### list-review-comments
`{prNumber}` → every inline review comment on the diff (the conversation comments come from **list-issue-comments**; these are the ones anchored to a file and line).
```bash
tea pulls review-comments "${PR}" --repo "$(tracker_repo)" -o json \
  --fields id,path,line,body,reviewer,resolver,url
```
This is the one read where a `tea` verb beats the API: assembling the same list from `/pulls/{n}/reviews` plus a per-review `/comments` fetch is N+1 requests for a shape `tea` already flattens, and it carries `resolver` — which REST does not expose on the per-review route. `resolver` non-empty means the thread was resolved; treat every other comment as potentially open and judge it against the current diff. Consumers treat an unavailable operation as "inline feedback out of reach", not as a failure: they fall back to review bodies plus conversation comments and state the gap in their report.

### CI runs

CI status for a *PR* comes from **get-pr-checks** / **get-required-checks** above. The operations here address CI runs directly — needed when working from a bare branch, or when a failure diagnosis needs the actual logs.

**A caveat covering this whole section.** The routes below are Forgejo's Actions API and answer on the tested instance (`/repos/{owner}/{repo}/actions/runs` → `200 {"workflow_runs":[],"total_count":0}`), but no Actions run has ever executed there, so the *shapes* under `workflow_runs[]` are taken from the API definition and not from a live response. Treat a mismatch as a descriptor bug to fix here, not as a reason to bypass the operation. A repository with no Actions at all answers `total_count: 0` for every query, which is "no signal", never "green".

#### list-runs
Branch (or head SHA) → recent workflow runs with id, workflow name, status, and conclusion.
```bash
tea_api "/repos/{owner}/{repo}/actions/runs?branch=${BRANCH}&limit=20" \
  | jq '[.workflow_runs[]? | {databaseId: .id, workflowName: .name, status, conclusion,
                              headSha: .head_sha, url: .html_url, createdAt: .created_at}]'
```

#### get-run
Run id → status, conclusion, and per-job breakdown.
```bash
tea_api "/repos/{owner}/{repo}/actions/runs/${RUN_ID}" | jq '{status, conclusion, workflowName: .name, headSha: .head_sha, url: .html_url}'
tea_api "/repos/{owner}/{repo}/actions/runs/${RUN_ID}/jobs" | jq '[.jobs[]? | {id, name, status, conclusion}]'
```

#### get-run-failed-logs
Run id → the log output of the failed steps. This is the primary diagnosis input for CI failures. Forgejo has no "failed steps only" endpoint, so the failed jobs are selected first and their whole logs fetched.
```bash
for job in $(tea_api "/repos/{owner}/{repo}/actions/runs/${RUN_ID}/jobs" \
               | jq -r '.jobs[]? | select(.conclusion == "failure") | .id'); do
  echo "=== job $job ==="
  tea_api "/repos/{owner}/{repo}/actions/jobs/${job}/logs"
done
```

#### rerun-failed
Run id → re-execute the run. Use to disambiguate flaky failures before changing any code. Forgejo reruns the **whole** run, not only its failed jobs — say so when reporting, because the wall-clock cost is not the same as `gh run rerun --failed`.
```bash
tea_api -X POST "/repos/{owner}/{repo}/actions/runs/${RUN_ID}/rerun" >/dev/null
```

#### watch-run
Run id → block until the run completes, signaling success/failure. Forgejo has no streaming watch, so this is the polling fallback `TEMPLATE.md` allows, bounded by `ci.maxWaitMinutes` so a stuck run cannot hold a skill forever.
```bash
DEADLINE=$(( $(date +%s) + 60 * ${CI_MAX_WAIT_MINUTES:-40} ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(tea_api "/repos/{owner}/{repo}/actions/runs/${RUN_ID}" | jq -r '.status')
  case "$STATE" in
    completed|success|failure) break ;;
  esac
  sleep 20
done
CONCLUSION=$(tea_api "/repos/{owner}/{repo}/actions/runs/${RUN_ID}" | jq -r '.conclusion')
[ "$CONCLUSION" = "success" ]
```

### Labels

#### list-labels
→ all label names defined in the repo, paginated, so a repository with a large taxonomy is not truncated the way a single fixed-limit request is.
```bash
tracker_labels
```

#### create-label
Name, color, description. Never delete, rename, or recolor existing labels.
```bash
tea_api -X POST '/repos/{owner}/{repo}/labels' \
  -f "name=${LABEL}" -f "color=${COLOR}" -f "description=${DESCRIPTION}" | jq -r '.name'
```
Forgejo accepts the color with or without a leading `#` and stores it **without** one, so a consumer comparing colors must compare the stored form. Both measured on `ajr/cezar-qa`, probes deleted afterwards: `-f 'color=#ededed'` → `201`, `"color":"ededed"`; `-f 'color=0366d6'` → `201`, `"color":"0366d6"`. The bare form is what this file sends, here and from every `ensure_label` call below.

#### ensure-label-taxonomy
Create every label from the config's taxonomy that does not exist yet (skip ones that already exist per **list-labels**). Existence is checked against the full paginated list, so re-running on a repo with a large taxonomy does not re-create the labels past the first page.
```bash
ensure_label() {   # $1 = name, $2 = color, $3 = description
  # `label_exists` answers 2 for "could not read the taxonomy", and `if
  # label_exists …` cannot tell that apart from "missing" — it would create the
  # label blind, which is the one thing this instance does not protect against:
  #
  #   $ tea api -i --repo ajr/cezar-qa -X POST '…/labels' -f 'name=zz-probe-46-dup' …
  #   HTTP/1.1 201 Created   {"id":86,"name":"zz-probe-46-dup",…}
  #   $ …the identical call again
  #   HTTP/1.1 201 Created   {"id":87,"name":"zz-probe-46-dup",…}   # two labels, one name
  #
  # (measured 2026-08-26; both probes deleted afterwards). So a taxonomy we could
  # not read stops the loop — `apply_label` already draws this exact distinction.
  _e=0; label_exists "$1" || _e=$?
  if [ "$_e" -eq 0 ]; then return 0; fi
  if [ "$_e" -eq 2 ]; then
    echo "ensure_label: cannot read this repo's labels; refusing to create '$1' blind (a duplicate name would be created, not rejected)" >&2
    return 1
  fi
  tea_api -X POST '/repos/{owner}/{repo}/labels' \
    -f "name=$1" -f "color=$2" -f "description=$3" >/dev/null
}
ensure_label review            0366d6 "Ready for code review"
ensure_label changes-requested b60205 "Reviewer requested changes"
ensure_label qa                fbca04 "Manual QA in progress"
ensure_label qa-failed         b60205 "Manual QA failed"
ensure_label merge-queue       0e8a16 "Approved, ready to merge"
ensure_label blocked           b60205 "Blocked by a dependency"
ensure_label do-not-merge      b60205 "Hard merge block"
ensure_label bug               d73a4a "Bug fix"
ensure_label feature           a2eeef "New capability"
ensure_label refactor          cfd3d7 "No behavior change"
ensure_label security          b60205 "Security-relevant change"
ensure_label dependencies      0366d6 "Dependency update"
ensure_label documentation     0075ca "Docs only"
ensure_label needs-qa          fbca04 "Requires manual QA before merge"
ensure_label skip-qa           0e8a16 "Low risk, QA not required"
ensure_label qa-approved       0e8a16 "Manual QA passed"
ensure_label qa-self-verified  c5def5 "Self-QA exception used"
ensure_label in-progress       c5def5 "An automated skill is working on this"
ensure_label ci-monitoring     d4c5f9 "Work complete and reported; agent is watching CI results"
ensure_label do-not-close      c5def5 "Humans only: never auto-close this issue"
ensure_label priority-low      e4e669 "Cosmetic or follow-up work"
ensure_label priority-medium   fbca04 "Ordinary bug or feature"
ensure_label priority-high     d93f0b "Release-blocking"
ensure_label priority-extreme  b60205 "Outage or security incident"
ensure_label risk-low          0e8a16 "Isolated, low blast radius"
ensure_label risk-medium       fbca04 "Ordinary change with tests"
ensure_label risk-high         b60205 "Wide blast radius, review deeply"
```
