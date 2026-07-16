# Run: harden worktree creation

Date: 2026-07-16
Branch: `fix/issue-438-worktrees-separation` (detached local worktree; push target is the PR branch)
Start commit: `60df2c42e63b42b5a9596807e81c7b1bb4791ddd`
Request: Extend PR #441 so every isolated Git task either receives a proper worktree or stops before executing.

## Assumptions

- PR #441 is the intended extension target based on the preceding conversation.
- The original failure text is no longer present in retained local run events; all retained Git runs record `worktree ready`.
- A deleted worktree with a surviving `cez/<id8>` branch is a concrete reproducible failure in the current one-shot `git worktree add -b` implementation.
- Explicit `worktree: false` and non-Git operation are intentional repository-root modes and remain supported under the existing exclusive lease.

## Spec Updates

- `.ai/specs/006-worktree-queue.md`: added the 2026-07-16 fail-closed and recovery contract.
- `.ai/WORKLIST.md`: added verifiable implementation and validation tasks.

## Tasks

- [x] Add idempotent/recovery behavior to `createWorktree` — verified with focused real-Git tests.
- [x] Fail an isolated Git run before its first step when worktree creation is unrecoverable — verified with a RunManager regression test.
- [x] Keep explicit opt-out runs serialized — verified with a parallel overlap regression test.
- [x] Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and `npm run test:package` in order.
- [x] Review, commit, push, and update PR #441 — implementation commit `a9ebcf8`.

## Execution Log

### 2026-07-16 18:00 Europe/Warsaw

- Inspected: issue #438, PR #441, spec 006, `src/git-worktree.ts`, `src/workflows/run.ts`, worktree tests, and retained local run records.
- Found: retained Git runs all report successful worktree creation, so the original stderr is unavailable.
- Found: `createWorktree` always calls `git worktree add -b`; a surviving task branch makes retries fail instead of recover.
- Found: RunManager catches every creation error and silently executes in `repoRoot`, contrary to the isolation contract.

### 2026-07-16 19:31 Europe/Warsaw

- Changed: `createWorktree` now prunes stale metadata, recognizes registered worktrees through canonical filesystem paths, repairs recoverable paths, reattaches surviving task branches, and preserves unregistered non-empty directories.
- Changed: isolated Git tasks now fail before workflow execution if worktree recovery remains impossible; explicit opt-out and non-Git runs retain the repository-root lease.
- Ran: `npm test -- src/git-worktree.test.ts src/workflows/run-isolation.test.ts`.
- Result: 2 files, 15 tests passed.
- Ran: `npm run typecheck`.
- Result: passed after installing the PR branch's locked dependencies with `npm ci`; the first attempt used the parent checkout's stale dependencies and could not resolve `@clack/prompts`.

### 2026-07-16 19:32 Europe/Warsaw

- Ran: `npm run typecheck` — passed.
- Ran: `npm test` — 123 files, 2,040 tests passed.
- Ran: `npm run test:unit` — 4 tests passed.
- Ran: `npm run build` — TypeScript, Vite, and check:pack passed (231 package files, 68 built UI files).
- Ran: `npm run test:package` — packaged dry-run CLI E2E passed.
- Reviewed: `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`, full local diff, and `git diff --check`; no protected API, state, CLI, workflow, or package surface changed.

### 2026-07-16 19:34 Europe/Warsaw

- Committed: `a9ebcf8 fix(worktrees): fail closed and recover task branches`.
- Pushed: `HEAD` to `origin/fix/issue-438-worktrees-separation` without rewriting history.
- Updated: PR #441 description and summary comment with recovery behavior, fail-closed semantics, verification, and residual risk.

## Final Status

- Completed: diagnosis, specification, implementation, focused tests, full validation, compatibility review, commit/push, and PR update.
- Not completed: none.
- Residual risks: a genuinely read-only or corrupt Git repository now fails an isolated task instead of allowing it to execute in the user's root; the error is retained on the run for recovery/action.

### 2026-07-17 Review round 2 — code review findings on PR #441

Addressed the `CHANGES_REQUESTED` review on the repository-root lease. The
`git-worktree.ts` half of the PR was approved as-is; findings 5 and 6 were the
only changes made there.

- Finding 1 (major, verified regression): a lease waiter sat in `active` and
  outside `waiting`, so it burned a `maxParallel` slot while idle and starved
  isolated worktree runs — the exact parallelism this PR set out to preserve.
  Lease waiters now park in `waiting` for the duration of the wait, following
  the #347 precedent. The store status stays `running`, so the GUI never shows
  a lease-blocked run as awaiting user input.
- Finding 2 (major, architectural): decided to **accept and document** that a
  parked root run holds the lease until its session ends. A parked session is
  still live and writes to the working tree on resume, so releasing the lease
  at the park would reintroduce the concurrent-edit bug #438 fixes. The
  semantics are now stated in the `acquireRepoRoot` doc comment. Finding 1's
  fix means isolated runs keep flowing regardless of a held root lease.
- Finding 3 (minor): `cancel()` could not free a run blocked on the lease — it
  reported success while the run kept its slot until the holder released. The
  lease wait is now abortable via `interrupt`. This also surfaced a case the
  review did not name: `cancel()` can land between the run going `running` and
  reaching `acquireRepoRoot`, while `interrupt` is still the default no-op, so
  the method now checks `cancelled` before entering the chain.
- Finding 4 (latent): `state.releaseRepoRoot` is assigned before `await
  previous`, so a `dropActive` during the wait can no longer strand the tail
  pending forever. The pre-grant release is chained behind `previous` — a run
  that has not yet acquired must not hand the tree to the next waiter.
- Finding 5 (minor): the worktree reuse paths re-anchored `baseBranch` from the
  current config, shifting `merge-base` under an existing task. A run that
  already recorded a fork point now keeps it.
- Finding 6 (nit): hoisted the per-entry `canonicalPath(absolutePath)` out of
  both `.find()` predicates.

Tests: added `src/workflows/run-lease.test.ts` — real-Git (worktree creation
not mocked, unlike `run-isolation.test.ts`) coverage that a lease-blocked run
does not consume a parallel slot, and that cancel-while-blocked settles without
waiting for the holder. Both tests were confirmed to fail against the pre-fix
commit and pass after, so they pin the regression rather than merely passing.

- Ran: `npm run typecheck` — passed.
- Ran: `npm test` — 124 files, 2,042 tests passed.
- Ran: `npm run test:unit` — 4 tests passed.
- Ran: `npm run build` — TypeScript, Vite, and check:pack passed.
- Ran: `npm run test:package` — packaged dry-run CLI E2E passed.

Residual risks: unchanged from the first round, plus the documented finding-2
semantics — a `worktree: false` run parked for user input owns the working tree
until its session ends, so other root runs queue for that period. This is
deliberate: the alternative is concurrent edits to the user's tree.
