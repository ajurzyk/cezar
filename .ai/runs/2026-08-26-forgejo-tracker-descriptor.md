# Execution plan — Forgejo tracker descriptor + a delivery seam that keeps it out of the repo

Issue: ajurzyk/cezar#46 · Branch: `feat/issue-46-forgejo-tracker-descriptor` · Base: `main` (`ea155448`)

## Goal

Give a Forgejo project a tracker descriptor the `om-*` skills can execute — `.ai/trackers/forgejo.md`,
written against the `tea` CLI — and a delivery seam that puts it (and `.ai/agentic.config.json`) inside a
run's worktree **without** the run's branch or the target repository ever carrying a pipeline file.

## Scope

- `.ai/trackers/forgejo.md` — the authored source, all 42 operations `github.md` names.
- `packages/cezar/src/pipeline-seam.ts` — the delivery seam, plus its wiring in `createWorktree`.
- Tests for both: a descriptor-driven harness that executes each operation's own bash block with `tea`
  stubbed on `PATH`, and a real-git test for the seam.

## Non-goals

- `.ai/trackers/github.md` — byte-identical, it is verbatim upstream (#19).
- Any skill edit. Any change to `ForgeDriver` / the cockpit's Forgejo support (#12, PR #45).
- `.ai/cezar/workflows/issue-to-pr.yaml`'s hardcoded `gh` calls — the issue names this as a known
  follow-up, deliberately out of scope.
- Producing the `APPROVED` / `CHANGES_REQUESTED` review states on the live instance: the issue records
  that as impossible with the available credentials. The descriptor *declares* the dictionary.

## Measurements this plan rests on (all taken 2026-08-26 in this container)

| Fact | Command | Result |
|---|---|---|
| `tea` present + authenticated | `tea --version`; `tea login list` | `0.15.1`; `q7010 http://q7010-dev:8929 ajr (default)` |
| **`tea api` exits 0 on HTTP errors** | `tea api --repo ajr/cezar-qa '/repos/{owner}/{repo}/pulls/9999' >/dev/null 2>&1; echo $?` | `0`, body `{"message":"The target couldn't be found."...}` on **stdout** |
| status line is reachable | `tea api -i … 2>hdr >body` | `HTTP/1.1 404 Not Found` on **stderr** |
| label add/remove take a **name** | `POST …/issues/2/labels -F 'labels=["selftest"]'` / `DELETE …/labels/selftest` | `200` / `204` |
| paging is capped | `tea api /settings/api` | `max_response_items: 50`, `default_paging_num: 30`; `X-Total-Count` header present |
| attachment limits | `tea api /settings/attachment` | `enabled:true`, `max_size:2048` (KB), `max_files:5`, `.png`/`.jpg` allowed |
| per-worktree hiding works | `git config extensions.worktreeConfig true` + `git config --worktree core.excludesFile` | linked worktree clean and `git add -A` stages nothing; **main checkout still shows `?? .ai/`** |
| baseline green | `bash …/.ai/cezar/gates/baseline.sh` | 336 files / 6602 tests / 76 s |

## Risks

- **The seam changes `.git/config` of the repository under work** (`extensions.worktreeConfig = true`).
  It is behaviour-neutral for the main checkout — measured above — but it is a write. Mitigated by:
  activating the seam only for a repo that actually provisions a pipeline, refusing when git's own
  documented migration hazard applies (`core.bare = true` / `core.worktree` set), and verifying the
  hiding before any pipeline file is written.
- **A per-worktree `core.excludesFile` overrides the user's global one.** Mitigated by composing: the
  generated file starts with the contents of whatever excludes file was effective before.
- `tea` 0.15.1 carries `tea api` and `pulls edit --ready`, which upstream 0.9.x does not. The descriptor
  records 0.15.1 as the version actually tested, not an assumed floor.

## Implementation Plan

### Phase 1: the delivery seam

1.1 Red tests for `pipeline-seam.ts` in `packages/cezar/src/pipeline-seam.test.ts`: real git repo + linked
worktree; assert a provisioned pipeline is invisible to `git status`/`git add -A`/`git diff base..HEAD` in
the worktree, still visible in the main checkout, and that the seam is a total no-op for a repo with no
provision directory.

1.2 Implement `pipeline-seam.ts`: `provisionPipeline(repoRoot, worktreePath)` — compose the excludes file
from the previously effective one, enable `extensions.worktreeConfig`, set `--worktree
core.excludesFile`, verify the hiding, then copy `<repoRoot>/.ai/cezar/pipeline/**` into the worktree.
Refuse (and deliver nothing) when hiding cannot be proven.

1.3 Wire it into `createWorktree` and prove the negative end to end: a simulated run commits its work and
`git diff <base>..HEAD --name-only` lists no pipeline file.

### Phase 2: the descriptor's spine and its test harness

2.1 `forgejo.md` — Prerequisites, Conventions, Label guards, and the `tea_api` status-checking helper that
answers the exit-code-0 measurement; plus Identity/repository operations.

2.2 `tracker-forgejo.test.ts` — a harness that extracts an operation's own bash block from the markdown,
runs it with a stub `tea` on `PATH`, and asserts on the argv the operation *sent*. Cover the four
Identity ops and the three guards, including the four #19 defects.

### Phase 3: issue, pull-request and review operations

3.1 Issue operations (`get-issue` … `update-comment`), with the descriptor's own tests.

3.2 Pull-request operations through `list-review-comments`, including **mark-pr-ready** reading `draft`
back and failing loudly, and the review-state dictionary resolving an unknown state to `review-required`.

3.3 **attach-image-evidence** against `/assets`, with the measured limits and the over-limit degradation.

### Phase 4: CI, labels, and the acceptance checks

4.1 CI-run and label operations, closing the 42-heading set; assert heading parity with `github.md` and
that no section body is empty.

4.2 Full gate (`baseline.sh`, then the configured `validation.commands`), heading-parity check,
`git diff main..HEAD --name-only` proof, PR + labels + review pass.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: the delivery seam

- [x] 1.1 Red tests for the seam — dda38dc6
- [x] 1.2 Implement `pipeline-seam.ts` — dda38dc6
- [x] 1.3 Wire into `createWorktree` and prove the negative — dda38dc6

### Phase 2: the descriptor's spine and its test harness

- [ ] 2.1 Prerequisites, Conventions, guards, Identity operations
- [ ] 2.2 Descriptor-driven hermetic test harness

### Phase 3: issue, pull-request and review operations

- [ ] 3.1 Issue operations
- [ ] 3.2 Pull-request operations, mark-pr-ready readback, review dictionary
- [ ] 3.3 attach-image-evidence

### Phase 4: CI, labels, and the acceptance checks

- [ ] 4.1 CI-run and label operations, 42-heading parity
- [ ] 4.2 Full gate, PR, labels, review pass
