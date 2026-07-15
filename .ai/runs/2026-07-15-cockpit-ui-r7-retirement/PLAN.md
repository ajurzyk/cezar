# Run: Cockpit UI redesign — Phase R7 (Retirement + polish)

- Date: 2026-07-15
- Branch: `feat/cockpit-ui-r1-platform-shell` (single consolidated PR #396)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"Phase R7 — Retirement" (Implementation Plan steps 21–22), §"Compatibility policy" (waiver expiry)
- Mode: Spec-implementation run

## Tasks

> Executors flip `Status` → `done` in their Step's commit, leave `Commit` = `pending`; dispatcher backfills SHAs.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Delete legacy web app: app.js/style.css/legacy index.html, `?legacy=1`, no-dist fallback → build-hint page | done | 6f848d2 |
| 1 | 1.2 | Packaging flip: `files` ships `web/dist` (+ svg), tarball bundle check in the gate; retire the BC waiver | done | 7b2eefb |
| 1 | 1.3 | iOS + degradation-matrix e2e sweep: iPhone viewport across every view; forge-off/degraded states where reachable | done | adeb2a4 |
| 1 | 1.4 | README refresh: recapture all 6 `docs/screenshots/*.png` against the new UI via agent-browser; prose sweep | done | 9552c87 |
| 1 | 1.5 | Stabilize e2e: badge-proof nav labels, settled dnd-kit keyboard reorder | done | c7da6b9 |
| 1 | 1.5-review-fix | check-pack: Windows-safe npm fallback invocation | done | 6d66e13 |

## Goal

Retire the legacy vanilla UI (spec step 21), flip npm packaging to the built React app, expire the redesign compatibility waiver, prove the new UI on iOS-size viewports and degraded environments, and refresh the README gallery so the shop window shows the shipped product (spec step 22). This closes the R1–R7 program.

## Non-goals

New features or visual changes to the React app (beyond fixes the sweep itself surfaces). MCP/keyboard Settings sections. Any release/publish action — packaging is flipped and verified, publishing is a human step.

## Implementation Plan

### Step 1.1 — Delete the legacy web app
- Delete `web/app.js`, `web/style.css`, and the legacy `web/index.html`. Keep `web/open-mercato.svg` only if something still references it (README/new app) — otherwise delete and drop its route.
- `src/server/static-ui.ts`: retire `legacyRequested`/`?legacy=1`; the no-dist case now resolves to a small built-in "run `npm run build:web`" hint page (spec: dev fallback) instead of the legacy page. `resolveIndexHtml`/`resolveGetRequest` and their tests updated; legacy asset routes (`/app.js`, `/style.css`) removed from `server.ts`.
- Sweep `src/` and docs for remaining `?legacy=1` / legacy-UI references (e.g. the SPA catch-all comment, `AGENTS.md` web-UI row, README if it mentions the escape hatch). Protected surfaces (BACKWARD_COMPATIBILITY.md §2, e.g. the legacy text answer route) stay — "legacy" there means response-shape vintage, not the web app.
- Unit tests updated/added: static-ui resolution matrix without the legacy branch; server tests that asserted legacy serving now assert the hint page.

### Step 1.2 — Packaging flip + bundle check + waiver expiry
- `package.json` `files`: drop `web/index.html`, `web/app.js`, `web/style.css` (and the svg if deleted in 1.1); ship `dist`, `web/dist`, `scripts`, `README.md`.
- Bundle check in the validation gate: a script (e.g. `scripts/check-pack.mjs` wired as `npm run check:pack` inside `npm run build` or `prepublishOnly`) fails when `web/dist/index.html` would be missing from the tarball (`npm pack --dry-run --json`) — this pins the R1 "tarball shipped no UI" bug class. Design-guardian is already in the gate via `npm test` (record, don't duplicate).
- `BACKWARD_COMPATIBILITY.md`: the redesign waiver expires at R7 per spec — mark it expired/retired; the post-R7 protected surfaces are the ones listed outside the waiver.
- Unit test for the pack-check logic where practical (pure function over the pack file list).

### Step 1.3 — iOS + degradation-matrix e2e sweep
- New `web/app/e2e/ios-sweep.e2e.ts`: iPhone-viewport (390×844) pass over every primary view (`/`, `/inbox`, `/git`, `/github` when forge is on, `/skills`→settings routes, `/workflows`, `/settings/*`, `/new`, a task thread) asserting: no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`), the drawer/menu chrome is reachable, and a screenshot per view.
- Degradation matrix, honestly reachable states only: forge gating is already covered live (github.e2e); assert the no-dist hint page via a unit test on `resolveIndexHtml` (booting a second env without dist is not worth a live spec — state the pin in the spec file).
- Fix forward any layout bugs the sweep surfaces (same Step if trivial, new Step if not).

### Step 1.4 — README screenshots + prose
- Recapture all six gallery shots against the live dry-run env through the agent-browser provider, same framing/intent as today: `live-run.png` (running task thread), `review-gate.png`, `variants-compare.png`, `plan-chain.png` (plan overlay), `workflow-builder.png`, `github-issues.png`. Desktop viewport, light or dark consistently (match the current gallery's theme), replace files in `docs/screenshots/`.
- Sweep README prose for descriptions of the old chrome (tabs, styling, `?legacy=1`) and update; alt texts stay truthful to what each shot shows.
- Docs-only step: no unit tests; the recapture procedure and env state land in the commit body.

## External References

None beyond the source spec. No new dependencies anticipated.
