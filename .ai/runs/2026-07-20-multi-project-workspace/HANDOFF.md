# Handoff — 2026-07-20-multi-project-workspace

**Last updated:** 2026-07-20T17:03:13Z
**Branch:** feat/multi-project-workspace
**PR:** https://github.com/open-mercato/cezar/pull/521 (draft, opened early for live progress; three-signal lock held by pkarw)
**Current phase/step:** Phase 2 Step 2.6
**Last commit:** 9abbf6e — feat(workspace): workspace semaphore

## What just happened
- Steps 2.1–2.5 done: ProjectContexts + RunManager.dispose, server.ts context-resolver refactor (53 routes mirrored, parity suite), per-dataDir todos watchers, usage fan-out scoping, workspace semaphore (#347 exemption preserved cross-project).
- Checkpoint 3 green: typecheck, FULL suite 2873/2873, build, test:package 8/8.

## Next concrete action
- Dispatch Step 2.6: per-project cache keying (GitHub list/comments caches, team-skills cache) + isolation regression tests.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: yes (test-env scripts exist under .ai/scripts; CEZ_HOME now pinned there)
- Browser / UI checks: not yet needed (UI starts Phase 3); agent-browser provider configured
- Database/migration state: n/a

## Worktree
- Path: /home/pkarw/Projects/cezar/.ai/cezar/worktrees/eeb2f1f6-4537-4918-9e4b-96463a0c80c8
- Created this run: no (reused cezar linked worktree; do NOT remove at cleanup)
