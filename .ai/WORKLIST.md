# Worklist — harden per-task worktree creation

Updated: 2026-07-16
PR: #441

- [x] Record the fail-closed isolation contract in spec 006 — verify by reviewing the dated hardening acceptance checks.
- [x] Make `createWorktree` idempotent and recover a surviving task branch after stale worktree metadata/path loss — verified with real-Git Vitest fixtures.
- [x] Stop isolated Git tasks before workflow execution when worktree creation remains unavailable — verified with a RunManager regression test that detects any repository-root command.
- [x] Preserve serialized repository-root execution for explicit opt-out tasks — verified with two parallel opt-out runs and an overlap detector.
- [x] Run the repository validation gate and review the complete PR diff — all commands in `.ai/agentic.config.json` passed.
- [ ] Commit and push the extension to `fix/issue-438-worktrees-separation`, then update PR #441.
