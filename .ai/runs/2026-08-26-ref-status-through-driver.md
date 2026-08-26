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

### Phase 4: Review pass (om-auto-review-pr engine)

- [x] 4.1 Fix the unproven-404 cache and the missing dry-run short-circuit — f46c51ff
- [x] 4.2 Re-run the full gate after the fixes — f46c51ff

### Phase 5: Resume (om-auto-continue-pr)

Phases 1–4 arrived fully checked, so this resume had no pending step to execute. What it owed
instead was the verification those checkboxes assert — a full gate re-run at the PR head and a
fresh-context re-read of the diff — plus the `Tracking plan:` line the PR body was missing, without
which no later resume could find this file through the ordinary path.

The re-read found two defects, both introduced by 4.1's own fix:

- [x] 5.1 Settle an anonymous 404 against warm cache evidence, not only a fresh read — 67022ae1
- [x] 5.2 Drop the stale "the ref-status family has no driver seam yet" line the seam made false — 8eec8f2d
- [x] 5.3 Re-run the full gate after the fixes — 67022ae1 (gate run, no code change)

### Phase 6: Independent review pass (om-auto-review-pr, fresh context)

The first review of this PR by a context that did not write any of it — Phase 4 was the review
engine run by the authoring session, and Phase 5 was that session reviewing its own two fixes. It
reviewed the whole diff against `main`, not just the newest commits, and it verified its one
substantive claim by measurement rather than by reading.

Verdict: **changes requested**, one major and three minors, no blockers. GitHub refuses
`--request-changes` on a self-authored PR, so the report was posted as a comment and the pipeline
label moved to `changes-requested` regardless.

The major: the dry-run branch added by 4.1 degraded to `available: false`, on the stated grounds
that this "reproduces what a Forgejo project's chips did before this method existed". Measured, it
does not — pre-seam the route called `fetchGithubRefStatus` for every repo, whose dry-run branch
answers `{available: true, prs: {}, issues: {}, recheckAfterMs: 60000}`. Those are different UI
states: `available: true` with the number absent is `state: 'unknown'` (the neutral chip, rechecked
each minute), while `available: false` is `state: 'unavailable'` — headline "Status unavailable" —
whose `null` cadence becomes `Infinity`, so the chip never refreshes again. Every reference chip in
an offline Forgejo demo had become an error state, against `AGENTS.md`'s own "`CEZ_DRY_RUN=1` fakes
every network answer" and the four dry-run fixtures this driver already carries.

- [x] 6.1 Answer dry-run from the fixture catalog on the live ladder, cache nothing — aa6353f1
- [x] 6.2 Cap the request list per kind in the driver, as `sanitizeRefNumbers` does — aa6353f1
- [x] 6.3 Name the two known limits the prose had left out: a cached `null` cannot prove
      readability (so the anonymous-404 gate has a narrow residual), and the shared cache drops the
      `apiBase` discriminator all six sibling caches carry — aa6353f1
- [x] 6.4 Re-run the full gate after the fixes — aa6353f1 (gate run, no code change)

Both new guards were mutation-checked by restoring the exact original defect: the dry-run degrade
fails 3 of the new cases, and dropping the `.slice` fails the cap case.

### Phase 7: Cache-key split found by the independent review — issue #50

The independent review of head `1aeee99c` found one major that no test on this branch can see, and
it is a **behavioural regression against `main`, for GitHub-hosted projects too**. Filed with its
three candidate fixes, their measured costs, and its named test cases as **issue #50** — read that
issue body before writing anything; it is the specification for this phase.

In one line: this PR moved the ref-status cache's write key. `server.ts:4927-4928` resolves the
driver through `resolveForgeOrGithub(repoRoot, repoInfo, …)`, which **ignores its first argument**
whenever `resolveForge` succeeds (`forge/index.ts:173` and `:180` both build on `repoInfo.root`, the
git top-level). The read (`server.ts:5478`) and both invalidations (`server.ts:4227`, `:4975`) still
key by `project.root`. The two are the same string only while a project is registered *at* its
repository's top level — and `shouldRegisterProject` (`workspace/projects.ts:115-120`) rejects only
`$HOME` and task worktrees, so registering a subdirectory is allowed and silently splits the key.

Consequences: the runs index never hydrates a reference chip warm, and a cockpit merge invalidates
nothing, so the pre-merge answer stands for up to `REF_STATUS_MERGED_TTL` (24 h).

Constraints that are not negotiable in this phase (full text in #50):

- Issue #50 lists **three** candidates and requires the implementer to **state which one was taken
  and why** in PR #45's body, including what it did or did not do to `/github/checks`. Pick
  deliberately; do not take the first thing that compiles.
- `github-ref-status-api.test.ts` and `ref-status-invalidation.test.ts` must keep passing **with
  zero edits to their assertions**. If a candidate needs them edited, that candidate is wrong.
- `refStatusCache.set` must still appear exactly twice (`rememberRefStatus` and the test-only
  seeder). Do not add a third writer to route around the key problem.
- Both readers must land on the writer's key. Aligning only `readCachedRefStatuses` or only
  `forgetRefStatus` leaves the other silently broken and is not a fix.
- `runs-index-api.test.ts:347` and `:369` seed the cache through `__seedRefStatusCacheForTests`
  with `realpathSync(repoRoot)` — any candidate that changes the key has to check those two.
- Ad-hoc `npx vitest run …` invocations need a `TMPDIR=/tmp` prefix (the gate script pins it; a
  bare invocation lets `mkdtempSync` land inside a git repo and reddens files this phase must not
  touch).

Do **not** revert `dryRunForgejoRefStatus` while in here: issue #12's scope decision 1 was retired
on 2026-08-26 with the measurement that disproved its premise, and the dry-run path is ratified.

**Candidate 2 was taken** — an explicit cache root on the factories, defaulted to `repoInfo.root`,
with only the ref-status route opting out. The reasoning, and what it did (nothing) to
`/github/checks`, is in PR #45's body under "The cache key, and which candidate closed it". The
option is named `refStatusRoot` rather than a generic `cacheRoot` precisely so #50's stated cost —
"a rule someone has to keep, which of the two roots a new cache should use" — is answered in the
type instead of in someone's memory: the doc on `ForgeDriverCacheRoots` (`forge/types.ts`) states
the rule, and a cache read only from inside a driver has no field to reach for.

- [x] 7.1 Align the ref-status cache key across the writer and both readers — choose one of #50's
      three candidates and record the choice and its reasoning in PR #45's body — bbfebb12
- [x] 7.2 RED-first guard: "ref-status writes and reads one key when the project root is below the
      repository top level" in `forge-seam-api.test.ts` — `git init` at `<tmp>`, pass
      `<tmp>/packages/app` as `createApp`'s `repoRoot`, no `registerProject()` — bbfebb12
- [x] 7.3 RED-first guard: "a merge invalidates the entry the route wrote when the project root is
      below the top level" — the `forgetRefStatus` half, same file — bbfebb12
- [x] 7.4 No-regression case: "a project root that is the repository top level keeps its existing
      key" — same file — bbfebb12
- [x] 7.5 If the candidate touched `forge/index.ts`: "resolveForgeOrGithub builds both drivers on
      the documented root" in `forge/index.test.ts` (a new case — no test asserts on
      `resolveForgeOrGithub` today) — bbfebb12
- [x] 7.6 Mutation-check every guard by restoring the original defect (`repoInfo.root` back where
      the fix took it out) and paste each red `npx vitest run <file> -t "<name>"` output into a
      `## Mutation checks` section of PR #45's body — bbfebb12
- [x] 7.7 Re-run the full gate; quote the file/test counts against the 336 / 6646 reference at
      `1aeee99c` and state the difference — bbfebb12

Five guards were written, and all five were mutation-checked (7.6). Four restore a defect the fix
removed — the route's missing pin, `resolveForge` not forwarding it, the driver root taken from the
caller (candidate 1 wearing a different name), and the `??` fallback dropping the pin. The fifth,
7.4, is a no-regression case rather than a defect guard: the ORIGINAL defect leaves it green by
construction, which is the whole point of it, so it was checked against the inverse mutation — a
pinned root that is not `project.root` (a trailing-slash normalization slip), which reddens it.

### Phase 8: the gate's own flake — `automations-gate.test.ts` under load

The `verify` step of this run failed the full gate at head `829d442e` on a case this PR does not
touch and did not write:

```
 ❯ server src/server/automations-gate.test.ts (21 tests | 1 failed)
   × starts once the flag is on, so the gate is the only thing holding it back
```

`automations-gate.test.ts` came in with `e8db2931` on `main` and is outside this PR's diff
(`git diff origin/main...HEAD` does not list it), so nothing here caused it — but a red gate is a
red gate, and "pre-existing failure" is not a category this repo has. The cause is in the test, and
it is load-sensitive rather than random.

`boot()` slept a flat 50 ms and then asserted. That is a wall-clock budget for a chain that spawns
processes: with the flag ON, `server.ts:5657-5665` awaits `getRepoInfo(project.root)` per project —
up to four `git` children — between the gate decision and `automationScheduler.start()`. With the
flag OFF the chain returns synchronously at the decision and never pays that cost, which is exactly
why only the ON case failed, and only inside a full-suite run with every worker busy.

- [x] 8.1 Reproduce the gate's failure deterministically: make the warm-up chain slow (300 ms before
      `automationScheduler.start()`) and confirm the ON case goes red with the reported assertion —
      670b53b5
- [x] 8.2 Replace the ON case's time budget with a synchronization point — `vi.waitFor` on the spy
      itself, so only a scheduler that never starts can fail it — 670b53b5
- [x] 8.3 Give the OFF case a real starting line: wait for `SkillsUpdateCoordinator.prototype.start`
      (`server.ts:5652`, one line above the gate check) before the grace period, so the grace covers
      the gate decision instead of covering `listProjects()` — 670b53b5
- [x] 8.4 Mutation-check both halves against the defect each one guards, and re-run the full gate —
      670b53b5

The OFF case keeps a grace period (`OFF_GRACE_MS`, 250 ms) because it cannot be given a
synchronization point: the gate's whole point is that nothing further happens, so there is no event
to wait for. It is strictly more margin than before — it now begins after `listProjects()` has
resolved rather than having to cover it — and a false pass there costs only guard sensitivity, never
a red gate. A first draft dropped the grace entirely and was rejected by its own mutation check:
with the gate removed, the OFF case passed. That is recorded below as mutation A.

**Mutation checks.** Three, all against a `server.ts` restored byte-identical afterwards
(`diff` against a pre-mutation copy, empty).

1. The reported failure itself — `.then(() => new Promise((r) => setTimeout(r, 300)))` inserted
   before `automationScheduler.start()`, against the **old** helper:

```
$ TMPDIR=/tmp npx vitest run packages/cezar/src/server/automations-gate.test.ts
AssertionError: expected "start" to be called 1 times, but got 0 times
 ❯ boot src/server/automations-gate.test.ts:213:23
 Test Files  1 failed (1)
      Tests  1 failed | 20 passed (21)
```

   The same mutation against the new helper: `Tests 21 passed (21)`.

2. Mutation A — `if (!automationsEnabled()) return;` deleted, the #801 defect the OFF case exists to
   catch:

```
$ TMPDIR=/tmp npx vitest run packages/cezar/src/server/automations-gate.test.ts -t "never starts polling"
AssertionError: expected "start" to be called +0 times, but got 1 times
      Tests  1 failed | 20 skipped (21)
```

3. Mutation B — the same line forced to `if (true) return;`, so the scheduler never starts:

```
$ TMPDIR=/tmp npx vitest run packages/cezar/src/server/automations-gate.test.ts -t "starts once the flag is on"
 FAIL  src/server/automations-gate.test.ts > … > starts once the flag is on, so the gate is the only thing holding it back
      Tests  1 failed | 20 skipped (21)
```
