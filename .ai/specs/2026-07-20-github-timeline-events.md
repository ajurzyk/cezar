# GitHub tab: full timeline events (commits, labels, merges) with per-commit CI markers

Tracking issue: [#525](https://github.com/open-mercato/cezar/issues/525)

## TLDR

The GitHub tab's detail thread renders conversation comments and PR review summaries and nothing else — the commits, label changes, assignments, merges, force-pushes and cross-references that make up the rest of a tracker's history are never fetched. This spec swaps the thread's comment fetch for GitHub's REST **timeline** endpoint, which returns comments *and* events in one stream, adds a compact `EventRow` alongside the existing `ThreadEntry`, and hangs a ✓/✗/○ CI glyph off each commit row via one batched GraphQL rollup query. The result reads like github.com's conversation tab: discussion interleaved with what actually happened to the branch.

This is the explicitly-named follow-up to [`2026-07-18-github-comment-threads.md`](./2026-07-18-github-comment-threads.md), whose Out of scope ends with *"Timeline events (labels, assignments, cross-references, commits)."*

## Resolved questions (autonomous defaults)

Authored unattended; each default is overridable before implementation starts — comment on #525 to override.

- **Q1 — REST `/issues/{n}/timeline` or GraphQL `timelineItems`?** **REST timeline.** Decisive evidence: a `commented` row from the timeline is shape-identical to a row from today's `/issues/{n}/comments` (verified against PR #517 — same `id`, `user`, `body`, `created_at`, `html_url`), so `normalizeComments` (`github.ts:371`) is reused unchanged and `comments[]` keeps coming out byte-identical. It also matches the established `gh api … --paginate` idiom at `:455` and the per-boundary zod discipline. GraphQL `timelineItems` would need inline fragments for each rendered kind plus a second normalization path for comments, for no user-visible gain.
- **Q2 — which events render in v1?** An **allowlist**, not a denylist: `committed`, `labeled`/`unlabeled`, `assigned`/`unassigned`, `merged`, `closed`/`reopened`, `head_ref_force_pushed`, `cross-referenced`, `renamed`. Everything else is dropped silently. Real data confirms the noise this excludes — PR #517's timeline carries `subscribed` (×2), `mentioned` (×2) and `review_requested` (×2), none of which github.com surfaces as conversation rows either. An allowlist also means a new GitHub event type can never crash or clutter the thread; it is simply not rendered.
- **Q3 — do `reviewed` timeline events replace the `/pulls/{n}/reviews` call?** **No — and they are dropped from the allowlist to avoid double-rendering.** Timeline `reviewed` events *do* carry a `body` key (verified — present, though `null` for bare approvals), so they are a technically viable source. The reason to keep the existing `/pulls/{n}/reviews` call (`:458`) is not capability but duplication and churn: it is already normalized to `ForgeComment{kind:'review'}`, already chipped in the UI (`REVIEW_CHIP`, `github.tsx:671`), and already filters empty-bodied `COMMENTED`/`PENDING` reviews (`normalizeReviews`, `:386-405`). Sourcing reviews from both would render each review twice.
- **Q4 — how are per-commit check states fetched?** One **batched aliased GraphQL query** (`repository { c0: object(oid:…) { ... on Commit { statusCheckRollup { state } } } … }`), one alias per commit SHA, chunked at **50 SHAs per query**. Verified against this repo: aliases resolve independently and an unknown SHA returns `null` rather than erroring the whole query, so partial results degrade cleanly. `oid` requires a **full 40-char SHA** in both literal and variable form — an abbreviated value fails with `Could not coerce value "babda63" to GitObjectID` (verified both ways). The timeline supplies full SHAs, so this constrains fixtures and tests, not production data.
- **Q5 — new endpoint or extend the existing one?** **Extend `GET /api/github/comments/:kind/:number`, additively.** One fetch, one cache entry, one client hook; the response gains an optional `events[]` beside the unchanged `comments[]`. A sibling route would double the round-trips and force the client to reconcile two independently-cached streams. The route name becomes mildly inaccurate — accepted over a breaking rename (§2), noted in Out of scope as an optional future alias.
- **Q6 — commit run grouping?** **Collapse consecutive `committed` events by the same author — entirely client-side.** The wire carries a flat list of `committed` events, each with its own `sha`, `message` and `checks`; `EventRow`'s parent groups them for display and expands to the individual commits on click. Keeping the grouping off the wire means no data is discarded by the collapse (each grouped commit keeps its message and CI glyph), the server stays a pure normalizer, and the grouping heuristic can change without a §2 conversation.
- **Q7 — does `ForgeComment.kind` widen to cover events?** **No.** Events get their own `ForgeTimelineEvent` type. Widening `kind` beyond `'comment'|'review'` is additive on the wire but silently breaks client narrowing at `web/app/src/api/types.ts:520` and the `REVIEW_CHIP`/`ThreadEntry` pair (`github.tsx:671-712`) — a type-level break `tsc` catches here but that any external consumer of the documented shape would eat at runtime.
- **Q8 — one spec or two?** **One.** The sibling spec made this its Q1, so it is asked here too. Timeline events and per-commit CI markers are a **layered** pair, not a bundle: the markers have nothing to attach to until commit rows exist, so they cannot ship first or independently, and they are the specific ask that motivated #525 ("displayed with ci markers as they are on GitHub"). Commit-run grouping (Q6) *is* independently separable — it is a pure client-side view — and is bundled into Phase 2 only because an ungrouped 40-commit PR is a worse experience than no commits at all. Split verdict: cohesive, keep together.

## Problem Statement

`fetchGithubComments` (`src/server/forge/github.ts:443-474`) makes exactly two calls: `gh api repos/{o}/{r}/issues/{n}/comments --paginate` (`:455`) and, for PRs only, `.../pulls/{n}/reviews --paginate` (`:458`). There is no call to `/issues/{n}/timeline`, `/issues/{n}/events`, `/pulls/{n}/commits`, or GraphQL `timelineItems` anywhere in the repository — commits, label transitions, assignments, merges, force-pushes and cross-references simply do not exist in cezar's data layer.

The practical cost is that the GitHub tab shows *discussion without consequence*. On PR #517 the thread renders nine comments — including agent checkpoint evidence describing commits by SHA — while the two `committed` events those comments describe, the five `labeled` transitions, the `merged` event and the `cross-referenced` link to #520 are all invisible. A reviewer reading cezar cannot tell whether a PR was merged, when CI went green, or that the branch was force-pushed under a comment thread.

CI status compounds this. `ghCheckRunSchema` (`:59-63`) and `rollupToChecks` (`:82-88`) already collapse `gh`'s `statusCheckRollup` array into a single `passing|failing|pending|null` for the *item*, discarding every check's name, conclusion and URL — and that rollup is attached to the PR, never to a commit. So even with commits rendered there is nothing to hang a status marker on.

## Proposed Solution

Three additive changes along the seam the sibling spec established:

1. **Swap the comment fetch for the timeline fetch** — `/issues/{n}/comments` becomes `/issues/{n}/timeline`, split at the zod boundary into `commented` rows (through the existing `normalizeComments`) and allowlisted event rows (through a new `normalizeEvents`). The PR reviews call stays as-is.
2. **Batched per-commit CI** — one aliased GraphQL query resolving `statusCheckRollup { state }` for the commit SHAs in the timeline, attached to `committed` events. Wrapped in try/catch: failure leaves commits unglyphed, exactly as `fetchCommentCounts` (`:167`) degrades counts to `0`.
3. **Render** — `GithubThread` (`github.tsx:602`) interleaves `comments` and `events` client-side and maps the result, branching on a discriminant: `ThreadEntry` (`:680`) for comments and reviews, a new compact single-line `EventRow` for events.

Alternatives considered:

- *GraphQL `timelineItems`* — rejected per Q1: an inline-fragment union plus a second comment-normalization path, replacing a working zod-guarded seam for no user-visible gain.
- *A sibling `/api/github/timeline/:kind/:number` route* — rejected per Q5: two round-trips and two caches for one interleaved list.
- *Reusing `/pulls/{n}/commits` for commits* — rejected: PR-only (issues have no commits), and it returns commits without their timeline position.
- *Merging the two streams server-side into one ordered `entries[]`* — rejected: it would either reshape the protected response or force a combined entry cap that silently drops `comments[]` contents the endpoint returns today (see §Risks). The server stays a normalizer; ordering is presentation.
- *Fetching per-check detail (names, conclusions, logs)* — out of scope; the badge already deep-links to `${item.url}/checks` (#415).

## Architecture

**`src/server/forge/github.ts`** owns everything `gh`, unchanged as a principle. `fetchGithubComments` keeps its signature and its bounded LRU (`commentsCache`, `COMMENTS_CACHE_MAX = 50`, `:420-431`) — the cached value simply carries `events[]` too.

**Two independent caps, never a combined one.** `mergeThread` (`:409-416`) keeps capping comments+reviews at `THREAD_ENTRY_CAP = 200` exactly as today, so `comments[]` is bit-for-bit what the endpoint returns now. Events get their own separate `TIMELINE_EVENT_CAP = 200`. A combined cap would mean a thread with 150 comments and 100 events returns ~120 comments — silently removing response contents from a §2-protected surface. Timeline pagination is capped at **10 pages** in the spirit of `paginateCounts` (`:144-162`); hitting either the page cap or an entry cap sets the existing `truncated` flag.

**The timestamp trap.** `mergeThread` sorts by raw `createdAt` string compare — correct for ISO-8601 UTC, and every existing entry has one. Timeline events do **not** uniformly: verified against PR #517, `committed` events have `created_at: null` and carry their real timestamp at `author.date`, and `reviewed` events use `submitted_at`. A naive mapping produces `createdAt: null` on every commit, which string-sorts to the top and silently reorders the whole history. `normalizeEvents` therefore resolves the timestamp **per event type**, and any event still lacking one is dropped rather than merged at an arbitrary position. This is the single highest-risk detail in the spec and gets a dedicated unit test.

**Actor identity is not uniform either.** Most events carry `actor { login, avatar_url }`, but `committed` carries only a git `author { name, email, date }` — no login, no avatar, and the email may not map to a GitHub account. `ForgeTimelineEvent.actor` is therefore a display string (git author name for commits, login elsewhere) with `avatarUrl` optional. **`author.email` is read for nothing and never leaves `normalizeEvents`** — there is no email field on the wire type, and the boundary schema strips it (see below), so raw addresses do not reach the client or sit in the LRU.

**The repo handle.** The Phase 2 GraphQL query needs `owner`/`name`, which `gh api graphql` does not expand from the `{owner}/{repo}` placeholders the REST calls rely on — this is exactly why `fetchGithub` pays for a separate `gh repo view --json nameWithOwner` first (`:212-213`). `fetchGithubComments` has no handle today, so Phase 2 must resolve one via the exported `parseOwnerName` (`:185`) and degrade to no glyphs when the slug is not a clean two-part name. This is a real added subprocess call per opened thread with commits, accounted for in §Risks.

**Boundary schema.** `ghTimelineEventSchema` is a plain `z.object` with a loose `event: z.string()` and optional kind-specific fields — **extras stripped**, per `CODE_REVIEW.md`'s zod rule and matching `ghIssueCommentSchema` (`:342`). Permissiveness toward unknown event *types* comes from the loose discriminant plus the allowlist, not from `.passthrough()`.

**`web/app/src/routes/github/github.tsx`** gains `EventRow` as a sibling of `ThreadEntry`, sharing the existing tone tables (`CHECKS_TONE`/`CHECKS_GLYPH`, `:745-755`) for the commit glyph rather than a parallel palette, and receiving `labelColors` — which today stops at `GithubDetail` (`:322`) and is not passed into `GithubThread` (`:590`). Both rows carry `data-kind` on their `<li>` so component tests key off one attribute. The client owns the interleave (a stable sort on `createdAt`) and the commit-run grouping.

Cross-cutting: the manual refresh mutation (`github.tsx:112-118`) invalidates only `queryKeys.github({limit: FULL_LIMIT})` and never open `queryKeys.githubComments` keys (`queries.ts:72`) — a pre-existing staleness bug this spec fixes, because it now hides commits and merge state, not just late comments.

## Data Model

Additive to `src/server/forge/types.ts` (`ForgeComment` at `:43-60` and `ForgeCommentsData` at `:63-72` are **unchanged**):

```ts
export type ForgeTimelineEventKind =
  | 'committed' | 'labeled' | 'unlabeled' | 'assigned' | 'unassigned'
  | 'merged' | 'closed' | 'reopened' | 'head_ref_force_pushed'
  | 'cross-referenced' | 'renamed'

export type ForgeTimelineEvent = {
  id: string                    // `evt-${n}` — n is the index in the post-allowlist, post-sort
                                // event array, so ids are unique and cannot collide with
                                // ThreadEntry's `${kind}-${id}` keys. Timeline rows carry no
                                // stable id of their own.
  kind: ForgeTimelineEventKind
  actor: string                 // login, or git author name for `committed`
  avatarUrl?: string            // absent for `committed`
  createdAt: string             // ISO-8601, resolved per event type (see Architecture)
  url?: string
  // kind-specific, all optional:
  sha?: string                  // committed — full 40-char
  message?: string              // committed — first line, capped at 120 chars
  checks?: 'passing' | 'failing' | 'pending' | null   // committed; see below
  label?: { name: string; color?: string }            // labeled / unlabeled
  subject?: string              // assigned/unassigned login; renamed new title
  refNumber?: number            // cross-referenced
  refTitle?: string             // cross-referenced
  refIsPr?: boolean             // cross-referenced
}
```

`checks` distinguishes three states with three renderings: **absent** (the rollup query failed or was skipped) and **`null`** (the commit has no CI configured) both render no glyph but are kept distinct for diagnosis — tests assert the value, not a visual difference; `'passing'|'failing'|'pending'` render the glyph.

No grouping fields on the wire — commit runs are collapsed client-side (Q6), so each commit keeps its own `message` and `checks` even inside a collapsed group.

`ForgeCommentsData` gains one optional field: `events?: ForgeTimelineEvent[]`. Mirrored verbatim at `web/app/src/api/types.ts:514-532`, re-exported through `src/server/github.ts`, and pinned type-exact in `src/server/api-types.test.ts` with `satisfies Exact<>` (the mechanism already used for `GithubItem`/`GithubData` at `:121-122`, which the sibling spec skipped for `ForgeComment`).

Caps: `message` 120 chars; `TIMELINE_EVENT_CAP = 200` on events, `THREAD_ENTRY_CAP = 200` on comments+reviews, independently. `COMMENT_BODY_CAP` untouched.

No persisted state, no migration: fetched, cached in memory for 60 s, never written to `.ai/cezar/`.

## API Contracts

`GET /api/github/comments/:kind/:number` — params and validation unchanged (`server.ts:1429-1440`, zod `commentsParams`, 400 on bad kind/number, `refresh=1` busts the cache). Response gains one optional field:

```jsonc
{
  "available": true,
  "comments": [ /* ForgeComment[] — unchanged shape, contents and cap */ ],
  "events":   [ /* ForgeTimelineEvent[] — NEW, optional, independently capped */ ],
  "truncated": false          // set when EITHER stream is capped, or the page cap is hit
}
```

Degradation contract, matching the tab's rule that GitHub failures never error the view:

- Timeline call fails → fall back to `/issues/{n}/comments`; `events` absent; thread renders as today.
- Repo handle unresolvable or checks query fails → events returned, `checks` absent, no glyphs.

**Timeout budget.** `gh()` defaults to a 15 s timeout (`:90`). The fallback is taken only when the timeline call fails in a way retrying can fix — a 404/`ENOENT`-class failure falls through immediately rather than spending a second 15 s window, capping the degrade path at roughly one timeout plus the reviews call rather than two.

## UI/UX

`EventRow` is deliberately *not* a `ThreadEntry`: single line, muted foreground, no card, no avatar block — icon + actor + phrase + `shortAge`, matching github.com's density so events read as connective tissue between comments rather than competing with them.

| Kind | Rendering |
|---|---|
| `committed` | ⚙ glyph + `{actor} committed {sha:7} {message}` + CI glyph (✓/✗/○, omitted when `checks` is absent or `null`); collapsed runs read `{actor} added {n} commits` and expand to the individual rows, each keeping its own message and glyph |
| `labeled` / `unlabeled` | `{actor} added/removed the {label}` label — chip reuses `labelColors` (newly threaded into `GithubThread`) |
| `assigned` / `unassigned` | `{actor} assigned/unassigned {subject}` |
| `merged` | ⑃ glyph, accent tone — `{actor} merged this` |
| `closed` / `reopened` | `{actor} closed/reopened this` |
| `head_ref_force_pushed` | `{actor} force-pushed` |
| `cross-referenced` | `{actor} referenced this in #{refNumber} {refTitle}` — links out |
| `renamed` | `{actor} renamed this to {subject}` |

The section header at `:646` is **retitled from `Comments · N` to `Activity`**, with the comment count kept as a secondary `· N comments`. Heading a twenty-row list `Comments · 2` would be incoherent. Note this is a different surface from the sibling spec's Q3, which settled the semantics of the **row badge** — that badge is unchanged and still counts conversation comments only.

The empty-state guard at `:638` (`if (data.comments.length === 0) return null`) must become `comments.length + events.length === 0`. Left as-is it would hide the entire feature on its motivating case: a merged PR with commits, labels and a merge event but no conversation comments renders nothing at all.

Keyboard access, light/dark theming and mobile safe areas follow the existing rows; the commit-group expander is a real `<button>` with `aria-expanded`.

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| Timeline call fails / rate-limited | Fall back to `/issues/{n}/comments`; thread renders as today, `events` absent. Never errors the tab. |
| Timeline 404s or `gh` missing | Fall through immediately without a second 15 s window (see timeout budget). |
| Repo handle unresolvable (not a clean `owner/name`) | Events returned without `checks`; no glyphs. Logged once. |
| Checks GraphQL query fails | Events returned, `checks` absent, no glyph. Logged once, not surfaced. |
| Unknown / new GitHub event type | Dropped by the Q2 allowlist. Never rendered, never throws. |
| Event with no resolvable timestamp | Dropped rather than merged at an arbitrary sort position. |
| Unknown SHA in the rollup query | Alias resolves `null`; that commit renders without a glyph. Verified. |
| Commit with no CI configured | `statusCheckRollup: null` → `checks: null` → no glyph (distinct value from absent). |
| >50 commits | Checks query chunked at 50 SHAs; a failed chunk costs only its own glyphs. |
| >10 pages of timeline | Stops at the cap, `truncated: true`, existing truncation row links to GitHub. |
| >200 events or >200 comments | Independent caps; `truncated: true`. `comments[]` is never shortened by event volume. |
| Issue (not PR) | No `committed`/`merged`/`head_ref_force_pushed` events exist; reviews call skipped as today. |
| PR with commits but no comments | Renders — the empty guard counts both streams. |
| `CEZ_DRY_RUN=1` | `mockGithubComments` serves fixture events including a mixed-state commit group. |
| No `gh` / no remote / offline | Unchanged: `{available: false, reason}` per the AGENTS.md GitHub rule. |

## Risks & Impact Review

**Blast radius.** One server module (`forge/github.ts`), two type files, one route (response only), one component. No state files, no CLI surface, no runner seam.

**`BACKWARD_COMPATIBILITY.md` §2.** `GET /api/github` is a protected surface (`:31`), and both `src/server/github.ts:1-8` and `forge/types.ts:23-24` annotate `ForgeItem` "do not reshape". Every change here is additive: `events?` is a new optional field, `ForgeComment.kind` does not widen (Q7), and `comments[]` keeps its exact shape, contents **and cap** — guaranteed structurally by Q1 (same normalizer, same source rows) and by the two-independent-caps rule in §Architecture. No field or content is removed, so §2's required path is satisfied without a deprecation window.

**Housekeeping the spec must land:** `GET /api/github/comments/:kind/:number` postdates the §2 route inventory and is **not currently listed** there. It gains a second consumer contract in this work and must be added in the same PR.

**Rollback.** Revert the PR; the endpoint returns to comments-only and the client's `events ?? []` renders an empty event set. No data to migrate back, no state written, no user-authored file touched. There is **no runtime kill switch** — zero config forbids adding a `CEZ_*` flag for this, so rollback means a revert, not a toggle. (The timeline fallback path is a failure handler, not an operator control.)

**Zero config.** No new `CEZ_*` flag, no new setting, no `.env.example` delta — the feature is discovered from the same `gh` auth the tab already requires and degrades to today's behavior when unavailable, per AGENTS.md.

**Performance.** Phase 1 is net-neutral: timeline replaces comments, one call for one. Phase 2 adds **two** subprocess calls per opened thread that contains commits — the `gh repo view` handle lookup and the batched rollup query — both behind the existing 60 s LRU, so the cost is per-thread-open, not per-render. The handle lookup is the same one `fetchGithub` already pays at `:212-213`.

## Phasing

- **Phase 1 — timeline fetch + event rows** (shippable alone): timeline endpoint, event model, `normalizeEvents`, client-side interleave, `EventRow`. Commits render without CI glyphs.
- **Phase 2 — CI markers + commit grouping** (shippable alone on top of 1): handle resolution, batched rollup query, glyphs on commit rows, client-side run collapsing with expander.
- **Phase 3 — polish + hardening** (shippable alone on top of 2): refresh-invalidation fix, dry-run fixtures, type pins, e2e coverage, §2 route-inventory update.

## Implementation Plan

**Phase 1 — timeline fetch + event rows**

1. `src/server/forge/types.ts`: add `ForgeTimelineEventKind` / `ForgeTimelineEvent`; add optional `events?` to `ForgeCommentsData`. Leave `ForgeComment` untouched. Re-export both through `src/server/github.ts` (the shim `api-types.test.ts:76` imports from). Typecheck only — no behavior change.
2. `src/server/forge/github.ts`: add `ghTimelineEventSchema` beside `ghIssueCommentSchema` (`:342`) — plain `z.object`, extras stripped, loose `event: z.string()`, optional kind-specific fields. Add `TIMELINE_EVENT_KINDS` (the Q2 allowlist, excluding `reviewed` per Q3) and `TIMELINE_EVENT_CAP = 200`. Unit tests: unknown event types parse then drop rather than throw; `reviewed` excluded; extras stripped (assert `author.email` is absent from the parsed object).
3. `src/server/forge/github.ts`: add `normalizeEvents(rows)` — allowlist filter, **per-type timestamp resolution** (`committed` → `author.date`, default → `created_at`), per-type actor resolution (`committed` → git author name, default → `actor.login`), kind-specific field mapping, 120-char message cap, `evt-${n}` id synthesis over the sorted post-allowlist array, `TIMELINE_EVENT_CAP` applied. Drop events with no resolvable timestamp. Unit tests: one per event kind against fixtures captured from a real timeline; a dedicated test asserting `committed` lands at `author.date` and never `null`; id uniqueness; cap applied.
4. `src/server/forge/github.ts`: in `fetchGithubComments` (`:443-474`), replace the `:455` call with `/issues/{n}/timeline` (`--paginate`, 10-page cap); split rows — `event === 'commented'` through the existing `normalizeComments` (`:371`), the rest through `normalizeEvents`. Keep the `:458` reviews call unchanged. Wrap in try/catch falling back to the old comments call, skipping the fallback on 404/`ENOENT`-class failures (timeout budget). Set `truncated` when the page cap is hit. Unit tests: split correctness; **`comments[]` byte-identical to pre-change output for the same input** (the §2 guarantee); fallback path; fast-fail path; page-cap truncation.
5. `src/server/forge/github.ts`: leave `mergeThread` (`:409-416`) **unchanged** — it keeps capping comments+reviews at 200 exactly as today. Events are returned as their own array; no server-side interleave. Unit test: `mergeThread`'s output is unaffected by event volume.
6. `web/app/src/api/types.ts`: mirror `GithubTimelineEvent` and optional `events` on `GithubCommentsData` (`:514-532`).
7. `web/app/src/routes/github/github.tsx`: add `EventRow` (compact single-line, `data-kind` on the `<li>`); add a client-side interleave (stable sort on `createdAt`) over `comments` + `events ?? []` and map the result at `:648-652`; thread `labelColors` from `GithubDetail` (`:322`) into `GithubThread` (`:590`); retitle the header (`:646`) to `Activity · N comments`; change the empty guard (`:638`) to count both streams. Component tests: one render case per event kind; interleave ordering; label chip colored; header text; **a PR with events but zero comments renders rows** (the H4 case).

**Phase 2 — CI markers + commit grouping**

8. `src/server/forge/github.ts`: resolve the repo handle in `fetchGithubComments` via `gh repo view --json nameWithOwner` + the exported `parseOwnerName` (`:185`), mirroring `fetchGithub` (`:212-213`). Degrade to no checks when the slug is not a clean two-part name. Unit tests: handle parsed; malformed slug degrades without throwing.
9. `src/server/forge/github.ts`: add `fetchCommitChecks(repoRoot, owner, name, shas)` — batched aliased GraphQL (`c{i}: object(oid:)`), chunked at 50 SHAs, adapting each single `statusCheckRollup.state` enum into the array shape `rollupToChecks` (`:82`) expects (`[{state}]`) so the existing vocabulary is reused rather than duplicated. try/catch → empty map. Unit tests: alias mapping; unknown-SHA `null`; chunk boundary at 50; the `rollupToChecks` adapter; degrade-on-failure.
10. `src/server/forge/github.ts`: call it when `committed` events exist; attach `checks` per SHA. Unit test: events carry `checks`; on failure events still return with `checks` absent (asserting absent, not `null`).
11. `web/app/src/routes/github/github.tsx`: render the CI glyph on commit rows reusing `CHECKS_GLYPH`/`CHECKS_TONE` (`:745-755`). Component tests: glyph per state; no glyph when `checks` is absent and when `null`.
12. `web/app/src/routes/github/github.tsx`: collapse consecutive same-author `committed` runs client-side; expander `<button>` with `aria-expanded`. Unit tests on the grouping helper: author change ends a run; a non-commit event interrupts a run; a single commit is not grouped. Component test: collapsed render, expand reveals per-commit messages **and** per-commit glyphs.

**Phase 3 — polish + hardening**

13. `web/app/src/routes/github/github.tsx:112-118`: fix the refresh mutation to also invalidate open `queryKeys.githubComments` keys (`queries.ts:72`). Component test asserting both invalidations.
14. `src/server/forge/github.ts`: extend `mockGithubComments` (`:478`) with fixture events — a mixed-state commit group, a label change, a cross-reference, a merge — so `CEZ_DRY_RUN=1` demos the feature offline. Fixture SHAs must be full 40-char (Q4).
15. `src/server/api-types.test.ts`: pin `GithubTimelineEvent` / `GithubCommentsData` type-exact with `satisfies Exact<>` alongside the existing `GithubItem`/`GithubData` pins (`:121-122`), closing the drift gap the sibling spec left open for `ForgeComment`.
16. `src/server/github-comments-api.test.ts`: extend the dry-run route assertions (`:43`, `:55`) to cover `events[]` and the unchanged `comments[]` shape.
17. `BACKWARD_COMPATIBILITY.md` §2: add `GET /api/github/comments/:kind/:number` to the route inventory (`:31`) and note `events?` as an additive field.
18. `web/app/e2e/github.e2e.ts`: add thread coverage — currently **none** exists (the sibling spec's step 9 called for it and it never landed). Assert a dry-run thread renders comments, a commit row, and a CI glyph.
19. Full gate: `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`, plus `npm run test:e2e`; manual pass under `CEZ_DRY_RUN=1 npm run dev` with a screenshot for QA evidence.

## Out of scope

- Per-check drill-down (individual check names, conclusions, logs) — the badge already deep-links to `${item.url}/checks` per #415; this spec adds a rolled-up glyph per commit only.
- Posting, editing, or reacting to timeline items — the tab stays read-only, per the sibling spec.
- Inline diff-anchored PR review comments and review-thread resolution state — still deferred to a future diff view.
- Background polling / webhooks for live timeline updates — the 60 s TTL + manual refresh model is unchanged.
- Renaming `GET /api/github/comments/:kind/:number` to something timeline-accurate, or adding a `/timeline` alias — a §2 route change for cosmetics; revisit only if a second consumer appears.
- Rendering `subscribed`, `mentioned`, `review_requested` and other events github.com also omits from the conversation view.
- Reactions on comments, and events GitHub hides behind its own "load more" pagination.
