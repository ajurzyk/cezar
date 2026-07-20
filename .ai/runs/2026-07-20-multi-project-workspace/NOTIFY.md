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
