# Notifications — GitHub timeline events

Append-only, UTC timestamps, newest at the bottom.

- **2026-07-21T00:00Z — run start.** `om-auto-fix-issue 525` classified #525 as a feature request
  and routed to the feature path. Spec `.ai/specs/2026-07-20-github-timeline-events.md` was already
  written and merged via PR #527, so no spec-authoring step was needed.
- **2026-07-21T00:00Z — decision: engine.** 20 Steps across 3 phases with UI work needing
  screenshots → `om-auto-create-pr-loop` rather than plain `om-auto-create-pr`.
- **2026-07-21T00:00Z — decision: branch reuse.** Working in the existing cez linked worktree
  rather than creating a nested one; branch cut fresh from `origin/main` (`67cdd2f`) so the merged
  spec is present.
- **2026-07-21T11:31Z — pre-existing failure identified.** `src/server/request-validation.test.ts`
  → "rejects an open-in with no target (400)" fails with 409≠400. Verified against a clean
  `origin/main` worktree: **fails there too**, so it is pre-existing drift, not this branch's doing.
  Not fixed here (out of scope); noted so the final gate is not misread as green-with-a-regression.
