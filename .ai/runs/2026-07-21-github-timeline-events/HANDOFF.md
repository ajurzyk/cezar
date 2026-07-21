# Handoff — GitHub timeline events

**Updated:** 2026-07-21 (run start)
**Branch:** `feat/github-timeline-events`
**PR:** (opening)
**Spec:** `.ai/specs/2026-07-20-github-timeline-events.md`
**Issue:** #525

## Where things stand

Run just started. Run folder committed; no code Steps landed yet.

## Next Step

**1.1** — add `ForgeTimelineEventKind` / `ForgeTimelineEvent` to `src/server/forge/types.ts`, add
optional `events?` to `ForgeCommentsData`, re-export both through `src/server/github.ts`.
Typecheck-only, no behavior change.

## Resume in 30 seconds

1. `git checkout feat/github-timeline-events && npm ci`
2. Read `PLAN.md`'s Tasks table — first `todo` row is the next Step.
3. Read the "Load-bearing details" section of `PLAN.md` before touching
   `src/server/forge/github.ts`; those nine points are API facts the spec verified against live
   endpoints and are the ones an implementer gets wrong.
4. One commit per Step; flip the Tasks row in the same commit.

## Blockers

None.
