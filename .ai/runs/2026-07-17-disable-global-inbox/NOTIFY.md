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
