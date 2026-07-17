# Handoff — disable the global follow-up inbox by default (#471)

**State: COMPLETE.** PR: https://github.com/open-mercato/cezar/pull/476 (`fix/disable-global-inbox`)

Every row in `PLAN.md`'s Tasks table is `done` (1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 4.1-review-fix,
4.2-review-fix). Full gate green on the merged tip `a6a51c9`: typecheck, 2160 tests / 130 files,
build + check:pack, test:package. `om-code-review` returned clean after its findings were fixed.

## What shipped

`CEZ_FOLLOWUPS=1` (opt-in, default off) gates the global inbox. `followupsEnabled()` in
`src/handoff.ts` is the single source of truth; `RunManager` enforces it as a live ceiling (start,
continue, each step spawn, restart recovery) so `cezar run` is covered, not just the HTTP route;
`/api/health` reports it so the web hides the Inbox nav/badge/toggle. Entries are hidden, never
deleted — the off→on round trip is proven lossless against the built server.

Per-task handoff, notes and `CEZ:DONE` untouched, per the issue.

## Next concrete action

None — awaiting human review + QA (`needs-qa` + `qaGate: true` keep it unmergeable until QA signs
off; `qa-approved` is not this skill's to give).

## Open items for the user (both in the PR summary + NOTIFY.md)

1. **`autosaveCommit` interfered.** 15 "cezar autosave" commits interleaved with the Steps, and one
   committed a half-resolved `main` merge (conflict markers) — the blocker review caught. The
   1:1 step↔commit contract cannot hold while it runs. Left alone; the repo squash-merges. This is
   also the answer to #471's ambiguous "autosaves": the repo's own meaning is these commits, and
   they do interfere. Not disabled — they are the crash-recovery point and the issue body only
   complained about stalled handoffs.
2. **Unrelated pre-existing bug.** Running cezar's test suite inside a cezar task leaks mock
   follow-ups into the real `.ai/cezar/todos.json` (`scripts/mock-claude.mjs:162` writes on every
   invocation, including the `CEZ_DRY_RUN` binary probe, inheriting the parent's `CEZ_TODOS_FILE`).
   7 entries from this task removed (backup `todos.json.bak-471`); 11 remain from other tasks.
   This PR fixes it going forward.
