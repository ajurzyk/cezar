# Checkpoint 3 — Steps 3.1..3.3 (Phase 3: Data layer, partial)

- Commits covered: `4de5ac4`..`e503571`
- Touched areas: `web/app/src/api/**` (types, client, queries, events), `web/app/src/lib/{attention,task-groups}.ts`, `components/{app-shell-container,task-quick-list,list-view}.tsx`, `src/server/api-types.test.ts`

## Validation

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run typecheck:web` | **PASS** |
| `npm test` | **PASS** — **495/495** (24 files) |
| `npm run build` / `build:web` | **PASS** |
| `npm run test:e2e` (agent-browser) | **PASS** — 25/25 |

Artifacts: `checkpoint-3-artifacts/screenshot-{quick-list-expanded,shell-repo-chip}.png` — inspected; the quick-list matches the mockup (group labels, 7px dots in the right tones, `PR ↗` chip, `×2` variant tile with A/B letter chips + per-variant runner/tokens).

## What landed

- **Typed API client** mirroring the server's real zod schemas + `ApiError` carrying the server's `{error}`/`manual`/`command` verbatim (the degradation doctrine: 409 reasons must reach the UI unchanged). TanStack Query wired; sidebar repo/version/inbox chips fed from live data.
- **Global SSE + reconcile doctrine**: one `EventSource` for the app; `run`/`run-deleted`/`todos` **patch the cache in place** (never invalidate — a live run emits an event per step/token tick; invalidating would flood a server on the same laptop); `usage` (~2s, never persisted) lives in a separate external store so a tick can't re-render the app; reconcile (authoritative refetch) fires **only** on reconnect and visibility→visible.
- **`deriveAttention(run)`** — the one canonical status function (permission > error > waiting/review > running > unseen), pure and UI-free, with `ATTENTION_RANK` exported so the ladder is asserted, not inferred. Will also drive R6 notifications.
- **Quick-list** with buckets (Needs you / Working / Recent), variant-group collapsing (spec 010), queue positions, Active/Archived tabs shared with the future table.

## Honesty notes (deliberate non-fabrication)

- **`permission` and `unseen` attention buckets return `false`** — cezar emits no `permission.*` events (R2 reserves them) and persists no per-run "seen" marker. The slots exist in the union; two tests guard that nothing invents a source. R2 changes only those two predicates.
- **`titleSummary ?? title` is not implemented as the spec words it** — `RunRecord` has no `titleSummary` yet (R2 adds it), and the web types are compile-time-checked against the server, so adding it now would fail the gate. `runTitle()` marks the single plug-in point.
- **A drift guard exists and bites**: `src/server/api-types.test.ts` asserts mutual assignability between 20 server types and their web mirrors, and lives on the server side because `npm run typecheck` (gate) covers `src/**` while `typecheck:web` does not. Verified by deliberately breaking a type. **Unguarded gap**: `HealthResponse`/`RepoResponse` envelopes are composed inline in `server.ts` route handlers with no exported type to compare against (their leaf types are guarded).
- **E2E "Working" bucket is not coverable by fixture** — a `serve` boot runs `manager.recover()`, which re-queues/settles/resumes non-terminal runs, so a fixture can't hold that bucket still. Covered by jsdom tests only; recorded in the spec file's header comment.

## Real defects caught this window

1. An `async` IIFE inside agent-browser's `eval` would have asserted `undefined === undefined` and **passed on nothing** (its `eval` returns the expression's value; a promise is not a value). Rewritten to fetch from Node.
2. E2E caught a wrong expected order in "Needs you" — the variant group (30m) correctly outranks the PR review (40m) on the recency tie-break.

## Residual / follow-ups

- **`typecheck:web` still not in the validation gate** — recommend folding it in at Step 4.4.
- Extract `HealthResponse`/`RepoResponse` into named interfaces in `server.ts` to close the drift gap.
- Legacy painted `waiting` and `review` both amber; the mockup shows them distinct — we follow the mockup (review = violet, matching the violet PR chip).
