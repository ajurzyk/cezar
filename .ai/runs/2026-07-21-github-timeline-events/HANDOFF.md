# Handoff — GitHub timeline events

**Updated:** 2026-07-21, checkpoint 1
**Branch:** `feat/github-timeline-events`
**PR:** [#552](https://github.com/open-mercato/cezar/pull/552) (draft)
**Spec:** `.ai/specs/2026-07-20-github-timeline-events.md`
**Issue:** #525

## Where things stand

**Phase 1 server side is done and green** (Steps 1.1–1.5, five commits). The thread is now sourced
from `/issues/{n}/timeline` behind a bounded page loop; `commented` rows flow through the unchanged
`normalizeComments`, everything else through the new `normalizeEvents`. `comments[]` is pinned
byte-identical by test. 30 new unit cases, all passing; `npm run typecheck` clean.

Nothing is user-visible yet — the client still ignores `events[]`.

## Next Step

**1.6** — mirror `GithubTimelineEvent` and the optional `events` field into
`web/app/src/api/types.ts` (around `:513-532`), matching `src/server/forge/types.ts` exactly.
Then **1.7**, the first user-visible step: `EventRow`, the client-side interleave, `labelColors`
threading, the `Activity · N comments` header, and the empty-guard fix.

## Resume in 30 seconds

1. `git checkout feat/github-timeline-events && npm ci`
2. `PLAN.md` Tasks table — first `todo` row is next.
3. **Read `PLAN.md`'s "Load-bearing details" before touching `src/server/forge/github.ts`.** Those
   nine points are live-API facts; several have a naive implementation that is silently wrong.
4. One commit per Step; flip the Tasks row in the same commit.

## Gotchas found so far

- **A page-insensitive `gh` mock hides paging bugs.** The fixtures in
  `fetchGithubComments timeline integration` are page-aware for a reason — don't simplify them.
- **`src/server/request-validation.test.ts` has one failure that is pre-existing on `main`**
  (409 ≠ 400). Verified against a clean base worktree. Not this branch's; don't chase it.
- `noUncheckedIndexedAccess` is on — indexed access in tests needs `!`.

## Blockers

None.
