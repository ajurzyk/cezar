# Notify — 2026-07-20-multi-project-workspace

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-07-20T12:19:46Z — run started
- Brief: Implement issue #520 — multi-project workspace (per-user ~/.cezar registry, project-scoped cockpit, config migrations) per `.ai/specs/2026-07-20-multi-project-workspace.md`.
- External skill URLs: none

## 2026-07-20T12:47:00Z — checkpoint 1 (steps 1.1..1.5)
- Phase 1 workspace foundation minus API routes: paths helpers, config module, registry ops, migrations + 001, boot wiring + harness CEZ_HOME pinning.
- Validation green: typecheck; vitest src/workspace+src/paths 48/48; build/check:pack; test:package 8/8 (incl. new boot-registration assertions).
- UI pass skipped: no UI touched this window (Phase 3 onward).
- Decision: PLAN.md Commit cells reconcile to pushed SHAs at checkpoints (per-step amend flow records lag-by-one SHA — SHA-in-tree cannot converge).
- Delegations: steps 1.1–1.5 each implemented by one sequential executor subagent (executor-dispatch pattern).
- PR #521 opened early (draft) at the user's request for live progress; lock claimed.

## 2026-07-20T13:12:00Z — checkpoint 2 (steps 1.6..1.7, Phase 1 close)
- GET /api/projects + additive health fields (never projects[].root, #431) + BC docs §2/§9.
- Validation green: typecheck; scoped vitest 48/48; FULL suite 2843/2843 (env -u CEZ_REMOTE — shell ambient CEZ_REMOTE=1 breaks one pre-existing test on base too).
- Phase 1 complete; upgraded users see no behavior change.

## 2026-07-20T17:03:13Z — checkpoint 3 (steps 2.1..2.5)
- Project contexts, 53-route context-resolver refactor with manifest-driven parity suite, per-dataDir todos watchers, per-project usage filtering, workspace maxParallel semaphore (#347 exemption tested cross-project).
- Validation green: typecheck; FULL suite 2873/2873; build; test:package 8/8.
- Incident: step-2.2 executor cut by session limit mid-run; resumed from transcript; tree verified clean before resume — no partial state landed.

## 2026-07-20T17:31:20Z — checkpoint 4 (steps 2.6..2.9, Phase 2 close)
- Cache isolation fixes (github list/comments, team-skills) + regressions; workspace config/ui-state routes (projectsDir probe, semaphore refresh); GET /api/workspace/events (stamped, usage split, legacy stream protected); BC docs.
- Validation green: typecheck; FULL suite 2895/2895; test:unit 31/31; build; test:package 8/8.
- Phase 2 complete — server fully project-scoped behind byte-identical aliases.

## 2026-07-21T05:20:00Z — om-auto-continue-pr-loop resume
- Resumed by: @pkarw (re-entry — the three-signal lock from the creator run was still held by the same user)
- Resume point: Step 3.3 (source: PLAN.md Tasks table; HANDOFF.md agreed at 3.1, but 3.1/3.2 landed after it was last written — table is fresher)
- PR head SHA: cfc159b (origin/feat/multi-project-workspace)
- Worktree handover: the creator run's worktree (task eeb2f1f6) went dormant 2026-07-20T23:38 with status=failed and no live process. This resume works the branch from worktree d89e350f instead and pushes to the same remote branch. The dormant worktree's local branch ref will lag — do not resume it without re-syncing.
- Salvaged work: that session left an unpushed `cezar autosave` commit (cd954c4) carrying partial Step 3.3 — AppShell `projectGroups` slot + `AddProjectMenu`, `useProjectRuns`/`useWorkspaceUiState` queries, `WorkspaceUiState` type, `capBuckets()`. Decision: keep the changes, drop the autosave commit (unpushed, so no PR history is rewritten) and land them inside the proper Step 3.3 commit, which still owes the project-groups component, its wiring, and component unit tests.

## 2026-07-21T06:05:00Z — decision: latent Step-3.1 defect fixed inside Step 3.4 (cf132d8)
- `ProjectScopeProvider` reset the module scope from its `[projectId]` effect CLEANUP. React runs every destroy before any create, so on a project change the scope was nulled between the provider's render and the remounted children's mount effects — the arriving project's first requests (`/api/skills`, `/api/workflows`, `/api/config`, `/api/repo`) went out UNPREFIXED and cached under the wrong key.
- Blast radius was wider than the pill: every in-tree cross-project navigation had the same shape, including the Step-3.3 sidebar project links.
- Fix: the reset moved into its own mount-only effect, with a unit regression test.
- Why not its own commit: Step 3.4's own acceptance test ("switch project → picker data and draft isolated") cannot pass without it, so splitting would have landed a knowingly-red Step.
- Second decision (3.4): the project pill is hidden in a single-project workspace, following the Step-3.3 sidebar precedent (groups mount only when the registry holds >1). Spec and mockups are silent on the gate; covered by a test.

## 2026-07-21T06:25:00Z — decisions: Step 3.5 settings split (496f051)
- Retention + worktrees panel split out of Resources into a new PROJECT-scoped `worktrees` section, per the spec's "Resources→Worktrees" wording; the old `/settings/resources` retention e2e was retargeted and renamed.
- Moved sections keep their old URLs: both `/p/<id>/settings/<global-id>` and the legacy flat spelling redirect to the global twin, so pre-split bookmarks still land. **Carry into Step 3.7's BACKWARD_COMPATIBILITY update.**
- The global Projects pane is a routed `comingSoon` scaffold with a comment pointing at Step 4.4 (the global nav needed all four mockup sections present).
- Appearance e2e now reads workspace ui-state under the pinned `CEZ_HOME` (`.ai/qa/cez-home`) instead of the repo's `.ai/cezar`.

## 2026-07-21T07:10:00Z — BLOCKER at checkpoint 5: e2e suite never ran during Phase 3
- Checkpoint 5's unit gate is fully green (typecheck; vitest 3030/3030 across 185 files; test:unit 31/31; build + check:pack; test:package 8/8), but the **e2e suite is 16 failed / 51 passed / 1 skipped across 7 focused specs**.
- Root cause of the miss: `npm test` is `vitest run` against the DEFAULT config, which excludes e2e — e2e lives behind `npm run test:e2e` / `web/app/e2e/vitest.config.ts`. Every Phase 3 executor reported "full gate green" truthfully and still never executed a single e2e spec. The per-Step scratch sanity check cannot catch this class of break by construction.
- The failures are NOT environmental. They are stale assertions against the pre-3.2 flat URL grammar: `new-task.e2e.ts` expects `/new` but the app now redirects to `/p/<id>/new`; `smoke.e2e.ts` waits on `nav a[href="/github"]` but nav hrefs are now scoped. Steps 3.5/3.6 updated the three settings specs they touched; the shared specs (smoke, new-task, quick-list) were never revisited.
- One failure needs genuine triage rather than a mechanical URL update: `smoke.e2e.ts > marks exactly one nav item active` expects `['Skills']` and gets `['Settings']`, which may be a real nav-active regression from the Step-3.5 settings split rather than a stale assertion.
- Decision: halt dispatch before Phase 4. Fix forward with a new Step **3.8** appended to the Tasks table (the run's convention — never rewrite a landed Step), then re-run checkpoint 5.

## 2026-07-21T07:30:00Z — checkpoint 5 (steps 3.3..3.8, Phase 3 close)
- Landed this window: multi-project sidebar (3.3), new-task project pill (3.4), settings project/global split (3.5), project-scoped bookmarklets (3.6), Phase 3 BC docs (3.7), e2e realignment (3.8).
- Validation green: typecheck; vitest 3030/3030 across 185 files; test:unit 31/31; build + check:pack (297 files); test:package 8/8. All under `env -u CEZ_REMOTE`.
- E2E after the 3.8 fix-forward: 162 passed / 4 failed / 4 skipped (21 of 25 files green), from 16 failed at checkpoint entry. The 4 residuals are pre-existing and individually accounted for in `checkpoint-5-checks.md` — verified via `git log origin/main..HEAD` that this branch never touched `mock-claude.mjs` or `src/runs/store.ts`.
- Real regression #2 found this window (harness, not product): e2e was mutating the operator's real `~/.cezar/config.json` — 12 self-spawning specs never pinned `CEZ_HOME`, so since Phase 1 every run registered its `/tmp/cezar-e2e-*` fixture into the developer's live registry. 16 dead entries pruned; `fixtureServeEnv()` now pins `CEZ_HOME`. Second-order effect: once the registry held >1 project the sidebar switched to the grouped shell, so flat-shell specs failed by run ORDER — a genuinely confusing failure mode now closed.
- Also fixed in 3.8: four specs (review-gate, task-changes, task-files, variants-compare) silently required an operator shell carrying `CEZ_REVIEW_GATE=1` (opt-in, default OFF since #489); now pinned by the harness.
- Process finding worth carrying: `npm test` is `vitest run` against the DEFAULT config and EXCLUDES e2e. Per-Step scratch checks cannot catch a broken cockpit URL grammar by construction — only the checkpoint's e2e pass can. Recorded in HANDOFF.md's environment caveats.
- UI evidence captured in `checkpoint-5-artifacts/` against the live dry-run env with three real projects registered (the grouped sidebar only renders above one project): `sidebar-multi-project.png`, `new-task-project-pill.png`, `settings-global.png`.
- Carry-forward: branch is 29 ahead / 20 behind `origin/main` — merge `main` before landing.
- Phase 3 complete. Next: Step 4.1.

## 2026-07-21T09:05:00Z — correction + new fix-forward Step 4.5 (e2e registry-shape coupling)
- The Step-4.2 executor reported 5 `smoke.e2e.ts` failures as "pre-existing and unrelated". That attribution was wrong, and the cause was MINE: to capture the checkpoint-5 sidebar screenshots I registered three real projects into the shared test-env registry (`.ai/qa/cez-home/config.json`, gitignored local state). Above one project the shell renders Phase 3's grouped sidebar, so smoke's flat-nav selectors stopped matching.
- Reset the registry to `projects: []` and re-ran: **smoke is 19 passed / 1 skipped, fully green.** So the failures were neither pre-existing nor caused by Step 4.2.
- The underlying fragility is real and is introduced BY this PR: `smoke.e2e.ts` asserts the flat single-project shell, which now holds only while the pinned `CEZ_HOME` registry has ≤1 project. Any developer who registers a second project — the entire point of this feature — will see smoke fail with selectors that look broken rather than shape-dependent. Step 3.8 pinned `CEZ_HOME` for the SELF-SPAWNING specs; smoke rides the SHARED test env, whose registry is mutable local state.
- Decision: track as fix-forward Step **4.5** — make the shared-env specs deterministic about registry shape (either pin/reset the registry at env-up, or assert both shapes explicitly) rather than silently depending on the operator's local state.
- Process note: this is the second time an executor labelled a failure "pre-existing" without proving it. Verify that attribution before accepting it — here it was one `git`-free experiment (empty the registry, re-run) to disprove.

## 2026-07-21T09:35:00Z — decision: Step 4.3 defers the `gh`-unavailable gate one click (95d0b88)
- The spec wants "Clone from GitHub…" DISABLED with a reason when `gh` is unavailable. That needs `GET /api/health` inside `AddProjectMenu`, but the app shell must render where no QueryClient is provided (the reason the dialogs mount only while open).
- Implemented instead: the menu item stays enabled and the DIALOG surfaces the server's 503 verbatim — `gh CLI not found — install it and run 'gh auth login'`. Same information, delivered at the moment it is actionable, without a query in the shell.
- Documented at the component call site. Revisit in Step 4.4 if the menu-level gate is wanted after all.
- Cleanup guard reviewed by the dispatcher and confirmed tight: the target is created by a NON-RECURSIVE `mkdir` before `gh` runs, which is simultaneously the atomic existence check (EEXIST ⇒ 409, existing dir never opened) and the ownership proof authorizing deletion. `cleanupCheckout` additionally requires `lstat`-confirmed directory, not a symlink, and `dirname(realpath(target)) === realpath(projectsDir)` exactly — so it cannot touch the root itself, anything nested deeper than one level, or anything outside the root.

## 2026-07-21T10:15:00Z — checkpoint 6 (steps 4.1..4.5, Phase 4 close)
- Landed this window: `GET /api/fs/browse` (4.1), folder-browser dialog + `POST /api/projects` (4.2), clone flow + `checkout-progress` SSE + partial-clone cleanup (4.3), global Projects pane + `DELETE /api/projects/:id` (4.4), e2e registry-shape determinism + first grouped-sidebar e2e coverage (4.5).
- Validation green: typecheck; vitest 3098/3098 across 190 files; test:unit 31/31; build + check:pack (299 files); test:package 8/8.
- E2E: 166 passed / 4 skipped / 3 failed — exactly the three documented pre-existing residuals. Step 4.5's acceptance was a deliberate POLLUTION EXPERIMENT, not a single green run: with 3 fake projects seeded and the pin disabled, smoke reproduced the checkpoint-5 incident (5 failed); with the pin active under the same polluted registry, smoke + 6 siblings went 48 passed / 0 failed, twice.
- Dispatcher security review (read the code, did not just accept the reports): browse containment (lexical gate before any syscall, authoritative realpath gate, `root + sep` prefix so `/home/bob-evil` cannot pass as inside `/home/bob`, escaping symlinks never listed, errors never echo a resolved path); `cleanupCheckout` (non-recursive `mkdir` as both atomic existence check and ownership proof; deletes only a non-symlink directory whose realpath'd parent IS the realpath'd root); `DELETE /api/projects/:id` (deregisters only, and deliberately avoids `RunStore.open` because it would `mkdir` into the folder being forgotten).
- Incidental live verification: the first evidence capture showed "browse root is not available" because the operator's shell exports `CEZ_REMOTE=1` and the env was booted without scrubbing it — the 4.1 hosted-mode root narrowing behaving exactly as specified, confirmed in a real browser. Recaptured under `env -u CEZ_REMOTE`.
- UI evidence in `checkpoint-6-artifacts/`: `settings-projects-pane.png`, `add-project-folder-browser.png`.
- Phase 4 complete. Next: Phase 5 (5.1–5.3), then the final gate.

## 2026-07-21T10:50:00Z — defect found during Step 5.1: `worktreeRetentionDefault` is a dead setting
- The Step-5.1 executor declined to document `resources.worktreeRetentionDefault` and flagged it instead. Verified by the dispatcher: the claim holds.
- `GET/PUT /api/workspace/config` (step 2.7) reads and writes it, `src/workspace/config.ts` schemas it, and the Step-3.5 Worktrees settings section tells the user it "only seeds projects that never set their own" — but **no enforcement path consults it**. `src/server/project-context.ts:191`, `src/index.ts:186` and `src/workflows/run.ts:620` all read the PER-REPO `worktreeRetention` and fall back to a hardcoded `?? 10`.
- Severity: a user-facing setting that silently does nothing, with UI copy actively asserting that it does. Worse than an absent feature, because it invites the user to rely on it.
- Decision: fix forward as Step **5.4** — make the workspace default actually seed the per-project fallback (replace the hardcoded `?? 10`), or remove the field and its UI copy. Fixing is preferred: the field is already in the persisted config schema and in `BACKWARD_COMPATIBILITY.md`'s workspace-config surface, so removing it is the more disruptive option.
- Credit where due: this was caught only because the executor was instructed to VERIFY every doc claim against the code rather than describe intent. Two earlier "pre-existing" attributions in this run turned out to be wrong under the same scrutiny.
