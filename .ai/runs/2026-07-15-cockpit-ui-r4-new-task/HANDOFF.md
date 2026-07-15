# Handoff — R4 (COMPLETE)

## State (final)

- **All 5 Steps done** (4 planned + 1.5 gate fix), `cf01558`..`d6e6bbb`, pushed.
- Final gate green: typecheck · build · `npm test` **1475/1475** · e2e **103/103** (agent-browser, real Chrome). See `final-gate-checks.md`.
- Step 1.4 was salvaged from a crashed session (implemented but uncommitted); verified before landing.
- Step 1.5 fixed a real SSE/bfcache socket leak the gate's e2e run exposed — full navigations parked documents holding `/api/events` sockets until the per-origin pool wedged page loads. pagehide closes, persisted pageshow reopens (seq high-water dedups run-stream replay); legacy reloads on restore.

## Next concrete action

**Phase R5 (git view + forge)** as a new run folder on this same branch/PR #396 — spec steps 16–18: server `/changes`, `/files`, `git/commit|push`, `/api/repo/changes`, `/api/repo/branch`, forge driver extraction + health `forge` + `capabilities.localHandoff`; `<Diff>` facade on `@pierre/diffs`; Changes/Files tabs; Repo view rebuild; Create PR→View PR; open-in-editor; mobile diff mode.

## Carry-forwards

- `/new` is fully React now; the legacy pin is gone, `?legacy=1` remains the escape hatch until R7.
- The rename machine is shared at `components/editable-title.tsx` (run header + table cell).
- `highlightSync`/`highlight` accept `tokenizeTimeLimit`; tests asserting full tokenization must pass `0`.
- All R1 handoff gotchas still apply (jsdom matchMedia, no `dark:` variant, Tailwind v4 theme quirks, drawer animation waits).
