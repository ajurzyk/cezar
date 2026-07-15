# Run: Cockpit UI redesign — Phase R4 (New task + list)

- Date: 2026-07-15
- Branch: `feat/cockpit-ui-r1-platform-shell` (single consolidated PR #396)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"New task (full-screen, #386)", Implementation Plan steps 13–15
- Mode: Spec-implementation run

## Tasks

> Executors flip `Status` → `done` in their Step's commit, leave `Commit` = `pending`; dispatcher backfills SHAs.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Full-screen /new: hero composer, pickers (workflow/skill, runner, model, variants, base), drafts | done | cf01558 |
| 1 | 1.2 | Plan-mode toggle + plan review overlay (drag-reorder, save-as-chain, start) | done | 696a5e9 |
| 1 | 1.3 | Bookmarklet auto-start parity + re-point /new to the React shell | done | c0680f0 |
| 1 | 1.4 | List/table polish: header meta finishing touches + ⌘N routing + R4 loose ends | done | 2e82aa4 |
| 1 | 1.5 | SSE bfcache leak: close streams on pagehide, reopen on restore (React + legacy) | done | d6e6bbb |

## Goal
The full-screen new-task experience (#386, #383): shared composer on a hero surface with all pickers, plan-first mode with the review overlay (spec 008 parity), the protected bookmarklet contract auto-start moving to React (undoing the R1 review-fix legacy pin), and the remaining list polish.

## Non-goals
Git view (R5), settings (R6), system prompt in the composer (Settings-only by user decision).

## Notes
- The R1 review-fix pinned `/new` to legacy BECAUSE the composer didn't exist. Step 1.3 removes that pin only after proving auto-start parity (launch key validation, ?skill/ref/auto contract) via e2e.
- Step 15 of the spec (editable titles, ± stats) largely landed in R2/R3 — 1.4 sweeps what's left honestly.
