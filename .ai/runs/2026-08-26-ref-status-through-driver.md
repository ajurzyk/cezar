# Execution plan — Forge seam: reference status through the driver

Issue: #12 (`ajurzyk/cezar`)
Source doc: `.ai/specs/2026-08-14-forge-seam-closure.md` § "Stage C — reference status through the
driver" (the spec landed on `docs/forge-seam-closure`, merged as #9; read with
`git show 7d0e5120:.ai/specs/2026-08-14-forge-seam-closure.md`).

## Goal

Route `GET /api/v1/github/ref-status` through `ForgeDriver` so a Forgejo project's task chips carry
a reference status, without moving the per-repo ref-status cache out of `forge/github.ts` and
without changing a single byte of the GitHub payload.

## Scope

- `forge/types.ts` — `ForgeRefStatusResult` + an **optional** `refStatus?` driver method.
- `forge/github.ts` — extract the ref-status cache seam (write-with-eviction, a warm read that
  preserves a cached `null`, the batch cadence) and wire `refStatus` into `createGithubDriver`.
- `forge/forgejo-map.ts` — a sibling schema for the one `GET issues/{n}` read (kind + state).
- `forge/forgejo.ts` — implement `refStatus` on the Forgejo driver.
- `server.ts` — the route resolves a driver and degrades when the method is absent.
- Tests for every one of the above.

### Non-goals (settled by the issue and the spec — not reopened here)

- **No `CEZ_DRY_RUN=1` fixture for `refStatus`.** Under dry-run the Forgejo driver keeps degrading
  to `{ available: false, … }` exactly as it does today. A dry-run reference chip for Forgejo is #31.
- **`ForgeRefStatusResult` is not re-exported from `forge/index.ts`** — its precedent
  `ForgeChecksResult` is absent from that block.
- **No `forge/shared/` extraction.** Cross-driver reuse stays by import while there are two drivers
  (spec, Invariants §4).
- **The upper rungs of the Forgejo PR ladder** (`review-required`, `changes-requested`, checks) stay
  unreachable: they cost three more reads per number and are a follow-up with its own budget
  question. An open, non-draft pull request is **absent from the map**, never `ready`.
- `readCachedRefStatuses`, `forgetRefStatus` and `refNumberFromUrl` **call sites are untouched**.
- No symbol MOVED out of `forge/github.ts`; no existing signature changed.

## Design

`readCachedRefStatuses` (`server.ts:5459`, the runs index) is synchronous while resolving a driver
needs I/O, so it cannot become a driver method — and does not need to. `refStatusCache` is keyed
`repoRoot␀#number` and its TTL table is pure and forge-agnostic: **per-repo infrastructure, not
per-forge behaviour**. Only FILLING it is driver-specific, so only the fetch joins the driver.

The three symbols `forge/github.ts` gives up, and why each is load-bearing:

| New export | Why it cannot be served by something already exported |
|---|---|
| `rememberRefStatus(repoRoot, number, resolved)` | The only production write today is inline in `fetchGithubRefStatus`, together with the `storedAt` stamping and the LRU eviction that bounds the map. It must **evict**, not merely set. |
| `peekRefStatus(repoRoot, number)` | `readCachedRefStatuses` folds a cached `null` (a proven absence) into "absent" (`if (!hit || !hit.resolved …) continue`), so a second driver could not tell a proven absence from a cache miss and would re-query it forever. |
| `refStatusBatchRecheckAfter(entries)` | `batchRecheckAfter` is private. A second driver inventing its own TTL table would silently disagree with `readCachedRefStatuses` about the freshness of the same rows. |

`fetchGithubRefStatus` is refactored to go through `rememberRefStatus`/`peekRefStatus` itself, so
there stays exactly ONE write path and ONE freshness policy over that cache.

### The Forgejo ladder, bounded to what one read supports

One `GET /repos/{owner}/{repo}/issues/{n}` settles both what a number IS and what state it is in:
Forgejo answers that endpoint for pull requests too and the payload carries a `pull_request` member.
Measured against a live instance (`15.0.3+gitea-1.22.0`) it carries `state` and
`pull_request: {merged, merged_at, draft, html_url}` — so `draft` comes free and the `WIP:`-prefix
fallback the spec left open is not needed.

| Number is | Answer | Why |
|---|---|---|
| issue, open | `open` | direct |
| issue, closed | `completed` | Forgejo has no state-reason, so `not-planned` is unreachable |
| PR, merged | `merged` | `pull_request.merged` |
| PR, closed not merged | `closed` | |
| PR, open + draft | `draft` | `pull_request.draft` |
| PR, open + not draft | **absent from the map** | checks and reviews are unread; `ready` would assert the opposite of the truth for a red or changes-requested PR |

**Failed is not absent.** A `404` is a proven absence and is cached as such. Anything else —
transport failure, 5xx, 401/403 — caches nothing and degrades the whole payload to
`{ available: false, reason, recheckAfterMs }`.

Fan-out is bounded by the same `FJ_CHECKS_CONCURRENCY = 8` chunking loop `forgejoListChecks` uses.
The per-kind request cap is already enforced route-side (`parseRefNumbers` + `GH_REF_STATUS_MAX`).

## Risks

- **Byte-identical GitHub payload.** The route moves onto `resolveForgeOrGithub`, whose no-forge
  answer is `createGithubDriver(repoRoot, null)` — the same path `forge-seam-api.test.ts` already
  pins. `github-ref-status-api.test.ts` and `ref-status-invalidation.test.ts` must stay green with
  **no edits to their assertions**; that is the guard, not a hope.
- **Refactoring `fetchGithubRefStatus`'s cache write** touches an upstream-owned function body. Its
  `github.test.ts` suite IS the regression test for TTL, eviction and failed-is-not-absent, and
  stays green unedited.
- **Tightening `forgejoIssueSchema`** would risk `listIssues`, which parses the same rows. Mitigated
  by adding a **sibling** schema for this read instead of extending the shared one.

## Implementation Plan

### Phase 1 — the seam and the GitHub side

1.1 `forge/types.ts`: add `ForgeRefStatusResult` (both branches carrying a REQUIRED
`recheckAfterMs`) and the optional `refStatus?` method.
1.2 `forge/github.ts`: extract `rememberRefStatus`, `peekRefStatus`, `refStatusBatchRecheckAfter`;
route `fetchGithubRefStatus` through them; wire `refStatus` into `createGithubDriver`. Tests in
`forge/github.test.ts` for the three new symbols.
1.3 `server.ts`: `/github/ref-status` resolves a driver (`loadForgeInputs` + `resolveForgeOrGithub`)
and degrades to `{ available: false, reason, recheckAfterMs: null }` when `refStatus` is absent.
Route test for the degrade in `forge-seam-api.test.ts`.

### Phase 2 — the Forgejo driver

2.1 `forge/forgejo-map.ts`: a sibling schema for the one `issues/{n}` read, plus its tests.
2.2 `forge/forgejo.ts`: `forgejoRefStatus` + driver wiring. Tests cover the ladder row by row, a
mixed batch whose kind comes from the payload rather than the request, a 404 cached as a proven
absence, a transport failure degrading rather than throwing, and the shared cache being both
honoured (a warm entry is not re-queried) and written (`readCachedRefStatuses` sees it afterwards).
2.3 `forge-seam-api.test.ts`: the route answering for a Forgejo repo through the driver.

### Phase 3 — gate

3.1 Full validation gate (`npm run typecheck`, the suite, build, package tests) and a diff re-read
for scope creep.

## Progress

PR: #45

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The seam and the GitHub side

- [x] 1.1 ForgeRefStatusResult and the optional refStatus method — eb5e3fdc
- [x] 1.2 Extract the ref-status cache seam and wire the GitHub driver — eb5e3fdc
- [x] 1.3 Route /github/ref-status through the driver — 2b7e66d5

### Phase 2: The Forgejo driver

- [x] 2.1 Sibling schema for the one issues/{n} read — 278a8622
- [x] 2.2 forgejoRefStatus and driver wiring — 36847117, 75ef0cb9
- [x] 2.3 Route-level coverage for a Forgejo repo — 65b9b879

### Phase 3: Gate

- [x] 3.1 Full validation gate — 65b9b879 (gate run, no code change)
