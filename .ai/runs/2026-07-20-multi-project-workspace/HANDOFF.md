# Handoff — 2026-07-20-multi-project-workspace

**Last updated (cp5):** 2026-07-21T07:30:00Z — was 2026-07-20T17:31:20Z (cp4)
**Branch:** feat/multi-project-workspace
**PR:** https://github.com/open-mercato/cezar/pull/521 (three-signal lock held by pkarw)
**Current phase/step:** Phase 4 Step 4.1
**Last commit:** 3ccc943 — test(e2e): realign the suite with the project-scoped URL grammar (step 3.8)

## What just happened

- **Phase 3 complete (3.1–3.8).** This resume landed 3.3–3.8: multi-project
  sidebar with collapse persisted through `/api/workspace/ui-state`; new-task
  project pill (per-project drafts, scoped submit); settings split into project
  (`/p/<id>/settings`) and global (`/settings/global`) areas with store moves;
  project-scoped bookmarklets; Phase 3 `BACKWARD_COMPATIBILITY.md`; and a
  fix-forward e2e realignment.
- **Checkpoint 5 green** on the full gate: typecheck, 3030/3030 unit,
  test:unit 31/31, build + check:pack, test:package 8/8.
- **Two real defects found and fixed en route** (details in `NOTIFY.md`):
  1. A latent Step-3.1 `ProjectScopeProvider` effect-ordering bug — the scope
     was nulled from an effect *cleanup*, so the arriving project's first
     requests went out unprefixed and cached under the wrong key. Fixed inside
     3.4 (its acceptance test cannot pass without it).
  2. The e2e harness was mutating the operator's real `~/.cezar/config.json`
     (16 dead fixture entries pruned) and four specs depended on the operator's
     shell for `CEZ_REVIEW_GATE`. Fixed in 3.8.

## Next concrete action

- Dispatch **Step 4.1**: `GET /api/fs/browse` — home-rooted, realpath
  containment, dirs only, `CEZ_REMOTE` restriction. Security-sensitive: path
  escape attempts must be rejected, and the step's own test asks for exactly
  that plus the `isRepo` flag.

## Blockers / open questions

- None blocking. Two carry-forward notes:
  - **Branch is 29 ahead / 20 behind `origin/main`.** Merge `main` before this
    lands; two of the four residual e2e failures trace to `mock-claude.mjs`
    turn semantics that `main` has since changed (#473).
  - The global **Projects** settings pane is a routed `comingSoon` scaffold
    from 3.5 — **Step 4.4 owns filling it in**.

## Environment caveats

- Always run gates as `env -u CEZ_REMOTE …` — an ambient `CEZ_REMOTE` breaks a
  test on `main` too.
- **`npm test` does NOT include e2e.** E2E is `npm run test:e2e` /
  `web/app/e2e/vitest.config.ts`. Run it at every checkpoint that touched UI —
  checkpoint 5 is why this line exists.
- 4 residual e2e failures are pre-existing and individually accounted for in
  `checkpoint-5-checks.md`; do not chase them as regressions.
- Test env: `sh .ai/scripts/test-env-up.sh` (reuses a healthy env);
  agent-browser 0.32.1 installed. The registry under `.ai/qa/cez-home` now has
  three real projects registered for evidence capture — that is deliberate, and
  it is what makes the grouped sidebar render.

## Worktree

- Path: /home/pkarw/Projects/cezar/.ai/cezar/worktrees/d89e350f-8a3f-49a3-aa6d-a485293f1d8e
- Created this run: no (reused a cezar linked worktree; do NOT remove at cleanup)
- **Handover note:** the creator run's worktree (`eeb2f1f6`) went dormant
  2026-07-20T23:38 with status=failed. This resume took the branch over from
  worktree `d89e350f` and pushes to the same remote branch. `eeb2f1f6`'s local
  branch ref now lags far behind — re-sync it before ever resuming there.
