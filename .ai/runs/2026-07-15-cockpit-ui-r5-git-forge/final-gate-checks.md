# Final gate — R5 (Git view + forge)

Covers Steps 1.1–1.7 (`e1fc7bd`..`84e6837`). Checkpoint 1 covered 1.1–1.5; this gate covers the full phase.

## Checks

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | PASS |
| `npm run build` | PASS |
| `npm test` (full unit) | PASS — 1673/1673 |
| `npm run test:e2e` (full suite: 118 tests incl. task-changes, task-files, repo-git) | PASS — 118/118 |

## What the phase delivered

- Forge driver seam (`src/server/forge/`): gh-CLI logic behind `ForgeDriver`; `/api/github` shape untouched. Health additively gains `forge` + `capabilities.localHandoff` (`CEZ_REMOTE`/non-loopback ⇒ hosted mode, open-in-cli 409s).
- Session git API: structured `/api/runs/:id/changes`, traversal-safe `/files` (+image-only raw mode with nosniff/no-script CSP), `git/commit`, `git/push` — all 409-with-reason.
- Repo API: `/api/repo/changes`, `/api/repo/branch`, additive `?structured=1` on `/api/repo/commit/:sha`.
- `<Diff>` facade (own renderer; `@pierre/diffs` evaluated and rejected — see NOTIFY 07:25) with unified/split, word-level marks, shared Shiki singleton.
- Changes tab + git action policy object (pure, self-explaining disabled entries), Files tab (lazy tree + preview), Repo view on the same components (commits, branches, forge gating), mobile unified+wrap.

## UI verification

e2e covers all three surfaces live (real Chrome, dry-run servers): real commit readback in Changes, image decode assertion in Files, real commits/branches in /git. Screenshots: `final-gate-artifacts/` (files-desktop, repo-git-desktop, repo-git-commit, repo-git-iphone) + checkpoint-1-artifacts (changes-desktop/mobile).

## Style compliance

Design-guardian test green inside `npm test`. Full-branch style pass deferred to spec completion (R7 gate), per plan.
