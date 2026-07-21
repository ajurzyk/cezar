# Handoff — 2026-07-20-multi-project-workspace

**Last updated (cp6):** 2026-07-21T10:15:00Z — was 2026-07-21T07:30:00Z (cp5)
**Branch:** feat/multi-project-workspace
**PR:** https://github.com/open-mercato/cezar/pull/521 (three-signal lock held by pkarw)
**Current phase/step:** Phase 5 Step 5.1
**Last commit:** a0fb7f4 — test(e2e): pin the shared env registry shape + grouped-sidebar coverage (step 4.5)

## What just happened

- **Phase 4 complete (4.1–4.5).** `GET /api/fs/browse` with realpath
  containment; `POST /api/projects` + the folder-browser dialog;
  `POST /api/projects/checkout` with `checkout-progress` SSE and partial-clone
  cleanup; `DELETE /api/projects/:id` + the global Projects settings pane; and
  a fix-forward that pins the shared e2e env's registry shape.
- **Checkpoint 6 green**: typecheck, 3098/3098 unit, test:unit 31/31, build +
  check:pack, test:package 8/8. E2E 166 passed / 3 failed — exactly the three
  documented pre-existing residuals.
- Phase 3's earlier work and its two defect fixes are recorded in
  `checkpoint-5-checks.md`; Phase 4's security review of the browse containment,
  the clone cleanup guard, and the deregister-only removal is in
  `checkpoint-6-checks.md`.

## Next concrete action

- Dispatch **Step 5.1**: docs — AGENTS.md routing rows, README multi-project
  section, `.env.example`. Then 5.2 (`cezar projects` CLI) and 5.3 (file the
  `liveInstancesExist()` follow-up issue), then the final gate.

## Blockers / open questions

- None blocking. Two carry-forward notes:
  - **Branch is 29 ahead / 20 behind `origin/main`.** Merge `main` before this
    lands; two of the four residual e2e failures trace to `mock-claude.mjs`
    turn semantics that `main` has since changed (#473).
  - The Step-4.3 clone dialog surfaces a missing `gh` as a 503 in the DIALOG
    rather than disabling the menu item (the shell renders without a
    QueryClient). Deliberate; recorded in `NOTIFY.md`.

## Environment caveats

- Always run gates as `env -u CEZ_REMOTE …` — an ambient `CEZ_REMOTE` breaks a
  test on `main` too.
- **`npm test` does NOT include e2e.** E2E is `npm run test:e2e` /
  `web/app/e2e/vitest.config.ts`. Run it at every checkpoint that touched UI —
  checkpoint 5 is why this line exists.
- 4 residual e2e failures are pre-existing and individually accounted for in
  `checkpoint-5-checks.md`; do not chase them as regressions.
- Test env: `env -u CEZ_REMOTE sh .ai/scripts/test-env-up.sh` (reuses a healthy
  env); agent-browser 0.32.1 installed. **Boot it with `CEZ_REMOTE` scrubbed** —
  the operator's shell exports `CEZ_REMOTE=1`, which puts the server in hosted
  mode and narrows `/api/fs/browse`'s root to a `projectsDir` that does not
  exist, so the add-project dialog answers "browse root is not available".
- The shared registry (`.ai/qa/cez-home/config.json`) is now pinned per-run by
  Step 4.5's vitest `globalSetup`, so e2e no longer depends on its local shape.
  Leave it at `projects: []`; do not hand-register projects into it.

## Worktree

- Path: /home/pkarw/Projects/cezar/.ai/cezar/worktrees/d89e350f-8a3f-49a3-aa6d-a485293f1d8e
- Created this run: no (reused a cezar linked worktree; do NOT remove at cleanup)
- **Handover note:** the creator run's worktree (`eeb2f1f6`) went dormant
  2026-07-20T23:38 with status=failed. This resume took the branch over from
  worktree `d89e350f` and pushes to the same remote branch. `eeb2f1f6`'s local
  branch ref now lags far behind — re-sync it before ever resuming there.
