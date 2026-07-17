# Notifications — disable the global follow-up inbox by default (#471)

Append-only, UTC, newest at the bottom.

- 2026-07-17T07:30Z — **run start.** Issue #471 ("disable global task list, and autosaves").
  Branch `fix/disable-global-inbox` off `main`. Classified as a Spec-implementation run
  (>5 files, 2 packages, new `CEZ_*` env contract surface).
- 2026-07-17T07:30Z — **decision (scope).** Two ambiguities were raised with the user, who
  replied "ok finish the task" without picking. Proceeding on the recommended reading, both
  recorded in PLAN.md Non-goals/Risks:
  (a) "autosaves" = the agent-side follow-up writes, **not** `autosaveCommit` git commits —
      those are the crash-recovery point and stay.
  (b) The whole inbox goes dark by default (nav + endpoints + prompt), not just the prompt —
      a visible but never-populated Inbox would be confusing.
- 2026-07-17T07:30Z — **finding.** The worktree was based on `84b56b6`, but `origin/main` is at
  `9fb96b4` and already contains PR #444 (`feat/generate-followups-toggle`), which built the
  per-run toggle and the prompt split. Scope shrank accordingly: this run flips #444's default
  and makes the switch global rather than building the mechanism.
- 2026-07-17T07:30Z — **finding.** Cezar has **no global handoff feature**. The only global
  handoff is the user's personal `~/.claude/CLAUDE.md` convention, outside this repo. Cezar's
  handoff is strictly per-task. Nothing to do here; reported to the user.
- 2026-07-17T07:30Z — **risk (BC).** `BACKWARD_COMPATIBILITY.md` freezes the `/api/todos`
  endpoints (line 28) and `todos.json` (line 44). Default-off breaks that contract as written;
  the issue is an explicit owner instruction, so the BC doc is updated in the same PR (Step 3.1)
  and the break is called out in the PR summary.
- 2026-07-17T07:55Z — **finding (process, worth the user's attention).** cezar's own
  `autosaveCommit` (`src/git-worktree.ts:105`) has been committing this worktree in the
  background throughout the run: 13 `cezar autosave` commits are interleaved with the Step
  commits and absorbed most of the code, so each Step's commit ended up holding little more
  than its PLAN.md row. The branch content is correct and the gate is green — but the
  **1:1 step↔commit contract this skill mandates is not achievable while the autosaver runs**,
  and per-Step bisectability is lost. Not rewritten: the history is honest, no one else is on
  this branch, and the repo squash-merges PRs, so the noise disappears on merge. Rewriting
  pushed commits to chase tidiness is the riskier move.
  This is also direct evidence for the open question in #471: the repo's own meaning of
  "autosaves" is exactly this, and it does interfere. Reported to the user rather than acted on
  — disabling it was explicitly put in Non-goals (it is the crash-recovery point).
- 2026-07-17T07:55Z — **scope addition (Step 1.3).** The route-level gate left `cezar run`,
  the inbox's "▶ Run" and variants ungated — they call `startRun` directly and `!== false` read
  the absent flag as enabled. Ceiling moved into `RunManager` with `followupsEnabled()` in
  `handoff.ts` as the single source of truth. Covered end-to-end through the real engine.
- 2026-07-17T07:55Z — **checkpoint 1.** Steps 1.1, 1.2, 1.3, 2.1, 2.2, 3.1 landed
  (45959a4..8b4ed98). Full gate green: `npm run typecheck` clean, 2106 tests pass across 125
  files (server + web projects). No UI screenshots: the checkpoint's UI changes are covered by
  the component suites, and no dev server was started for this run.
- 2026-07-17T08:05Z — **blocker (found + fixed).** `om-code-review` caught conflict markers
  committed in `web/app/src/components/app-shell.tsx`: cezar's autosaver committed the `main`
  merge mid-resolution. Local `tsc`/`vitest` passed off the working tree, so a clean CI checkout
  would have failed to build. Resolved in `5d92a7f` (both `inboxAvailable` and main's `banner`
  kept — orthogonal additions). Zero markers on the pushed tip; verified with `git grep` against
  the remote ref.
- 2026-07-17T08:05Z — **review fixes (Step 4.2-review-fix, `a6a51c9`).** Three Low findings, all
  real: `recover()` left the record echoing `generateFollowups:true` for a run that produces none
  (normalized; first-ever test for `recover()`, verified to fail without the fix); `/inbox` flashed
  "Inbox empty" before health landed (keyed on `isPending`, so a *failing* health request still
  reaches the empty state instead of blanking the route forever); `capabilities.ts` claimed a live
  env flip works, which is half-true for `followups` (watcher is boot-time).
- 2026-07-17T08:05Z — **merge.** Six PRs landed on `main` mid-run (#448–#454); merged in, one
  conflict, gate re-run green (2160 tests / 130 files).
- 2026-07-17T08:10Z — **run end.** PR #476 opened, labelled (review/bug/needs-qa/priority-medium/
  risk-medium), summary comment posted, lock released. Status: complete, awaiting human review+QA.
