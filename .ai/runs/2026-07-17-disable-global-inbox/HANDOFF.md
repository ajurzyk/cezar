# Handoff — disable the global follow-up inbox by default (#471)

**Run folder:** `.ai/runs/2026-07-17-disable-global-inbox/`
**Branch:** `fix/disable-global-inbox` (base `main`)
**Plan:** `PLAN.md` — the `## Tasks` table is the authoritative status source.

## State

Run started. Plan drafted, no Steps landed yet.

## The one thing to know

PR #444 already built the machinery (per-run `generateFollowups`, the
`HANDOFF_ONLY_INSTRUCTIONS` / `FOLLOWUP_INSTRUCTIONS` split, `CEZ_TODOS_FILE` shadowing).
It defaults to **enabled**. This run flips the default to **off** and lifts the switch from
per-run to a global `CEZ_FOLLOWUPS=1` opt-in. Do not rebuild what #444 already did.

Per-task handoff/notes and the `cezar autosave` git commits are **out of scope** — see
PLAN.md "Non-goals".

## Next concrete action

Step 1.1 — add `followups: boolean` to `Capabilities` in `src/server/capabilities.ts`,
resolved as `env.CEZ_FOLLOWUPS === '1'`, with unit tests.

## Blockers

None. One open question was raised with the user and answered with "ok finish the task",
so the run proceeds on the recommended reading: gate the inbox, leave `autosaveCommit` alone.
