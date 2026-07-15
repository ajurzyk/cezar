# Checkpoint 1 — R5 steps 1.1..1.5

- Steps covered: 1.1 (e1fc7bd) .. 1.5 (57d9fdc)
- Areas touched: server (forge seam, session git API, repo API), web (diff facade, Changes tab, git action policy)

## Checks

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` (full unit) | PASS — 1628/1628 (incl. 36 forge/health, 25 git-changes, git-actions policy suite, 34 diff facade, api-types drift guards) |
| `npm run test:e2e` (full suite incl. new task-changes.e2e.ts) | PASS — 109/109 on rerun; first pass had 1 flake, not reproduced across two consecutive full green runs |

## Artifacts

- `checkpoint-1-artifacts/changes-desktop.png` — Changes tab: tree + unified diff + policy toolbar (View PR primary)
- `checkpoint-1-artifacts/changes-mobile.png` — iPhone viewport, forced unified+wrap

## Notes

- `@pierre/diffs` rejected after evaluation (NOTIFY 07:25 entry) — facade ships our renderer, swap seam stays in `diff.tsx`.
- e2e honestly covers what dry-run reaches (real commit readback, View PR state, deep links); Create PR→View PR transition, push, and 409s pinned in unit tests.
