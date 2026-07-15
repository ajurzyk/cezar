# Handoff — R7

## State

**R7 complete — the R1–R7 redesign program is done.** All 5 Tasks rows done (`6f848d2`..`c7da6b9`) plus the `origin/main` merge (`63a2d78`). Final gate green (`final-gate-checks.md`): typecheck · vitest 1855 · node:test unit · build + check:pack · packaged CLI · e2e 154/154 ×3 · design-guardian clean. PR #396 body flips to `Status: complete`.

## What R7 delivered

- 1.1 Legacy web app deleted (`app.js`/`style.css`/legacy `index.html`, `?legacy=1` retired; no-dist → built-in build-hint page) — `6f848d2`
- 1.2 Packaging flip (`files` ships `web/dist`; `check:pack` tarball gate inside `npm run build`; BC redesign waiver expired) — `7b2eefb`
- 1.3 iOS sweep e2e (11 views at 390×844: overflow, chrome, screenshots; degradation matrix pinned where honestly reachable) — `adeb2a4`
- 1.4 README gallery recaptured against the React cockpit (6 shots, dark, 3200×2000) + prose sweep — `9552c87`
- 1.5 e2e stabilization (badge-proof nav labels; settled dnd-kit keyboard reorder) — `c7da6b9`
- Merge: `origin/main` (#398 CI validation) reconciled — vitest stays `npm test`, node:test suites land as `test:unit`/`test:package`, ci.yml updated, tarball expectations moved to `web/dist`.

## Carry-forward notes

- The npm release (packaging flip live) is a human step — `prepublishOnly` runs the full build + pack gate.
- Settings registry still has hidden `mcp`/`keyboard` placeholders (post-program work).
- dnd-kit keyboard driving in e2e must sync on `aria-pressed` + live-region announcements (see workflows.e2e.ts) — reuse that pattern for future drag specs.
