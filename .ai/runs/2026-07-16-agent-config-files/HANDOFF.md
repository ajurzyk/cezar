# Handoff — Agent config files

**State:** Phases 1–3 complete and verified at Checkpoint 2. Backend, editor, and both Settings sections landed; full fast gate green (1972+4 tests). Steps 1.1–1.5, 2.1–2.2, 3.1–3.4 done.

**Next concrete action:** Step 4.1 — worktree seeding in `src/workflows/run.ts`. After `createWorktree` (around line 745, where `state.cwd = wt.path`), for each catalog entry with `seeded:true` (Claude's `.claude/settings.local.json` and `CLAUDE.local.md`): if the source exists at `repoRoot` AND `git check-ignore` confirms it is ignored, copy it into `state.cwd` and idempotently append it to the common-dir `.git/info/exclude` (append only if absent). Follow the `materializeSkillDir` precedent (`run.ts:910-923`), emit a `note` event. No-op when absent, genuinely tracked, or no worktree.

**Then:** Step 5.1 — docs (AGENTS.md task-routing row for `src/agent-config/`, README section, BACKWARD_COMPATIBILITY.md §2 route list, CHANGELOG, note the `smol-toml` dep and that `/settings/mcp` now exists).

**Then:** final gate (step 7) — full `validation.commands` (typecheck, test, test:unit, build, test:package), the e2e suite (editor alignment), design-system pass, then `om-code-review` + `om-auto-review-pr`.

**Catalog seeded entries:** `claude.local.settings` (`.claude/settings.local.json`), `claude.local.memory` (`CLAUDE.local.md`). These are the ONLY `seeded:true` rows — verify via `CONFIG_FILES.filter(f => f.seeded)`.

**Invariant to preserve:** the hosted-mode write gate is by-mode and server-side (`src/server/server.ts` PUT handler, `capabilities().localHandoff`).

**Worktree:** `.ai/tmp/om-auto-create-pr-loop/agent-config-files-20260716-095538` (branch `feat/agent-config-files`).
