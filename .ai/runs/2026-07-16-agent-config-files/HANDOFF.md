# Handoff — Agent config files

**State:** in-progress — run folder just landed. No code Steps yet.

**Next concrete action:** Step 1.1 — write `src/agent-config/catalog.ts` (the `ConfigFileDef` type + the hardcoded table + `listConfigFiles(repoRoot)` / `findConfigFile(id)`), pure, no IO. Unit-test id uniqueness/URL-safety, `<repo>/AGENTS.md` = one entry two runners, `$CODEX_HOME` honoured, every entry has non-empty `precedence` + `docsUrl`.

**Authoritative source:** `.ai/specs/2026-07-16-agent-config-files.md` — architecture, API, catalog shape, edge cases. Do not redesign.

**Critical invariant (review-blocker):** hosted-mode gate is BY MODE — when `capabilities().localHandoff` is false every PUT 409s and `userMcp` is withheld. Step 1.5 must regression-test a repo-LOCAL id 409ing under `CEZ_REMOTE=1`.

**Worktree:** `.ai/tmp/om-auto-create-pr-loop/agent-config-files-20260716-095538` (branch `feat/agent-config-files`, deps installed).
