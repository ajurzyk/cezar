# Final gate — disable the global follow-up inbox by default (#471)

Fired at spec completion: every row in `PLAN.md`'s Tasks table is `done`
(Steps 1.1, 1.2, 1.3, 2.1, 2.2, 3.1 — `45959a4..e537e67`). Subsumes the pending checkpoint.

## Full validation gate (`validation.commands`, in order)

| # | Command | Result |
|---|---------|--------|
| 1 | `npm run typecheck` | **pass** — server (`tsconfig.test.json`) + web (`web/app/tsconfig.json`), no errors |
| 2 | `npm test` | **pass** — 125 files, 2106 tests, both vitest projects (`server` + `web`) |
| 3 | `npm run test:unit` | **pass** — 4/4 |
| 4 | `npm run build` | **pass** — tsc + vite bundle + `check:pack ok — 231 files, 68 under web/dist` |
| 5 | `npm run test:package` | **pass** — 1/1 |

Working tree clean after the build (no generated drift).

## What the new tests actually prove

- `src/server/capabilities.test.ts` (new, 21 tests) — `followups` is off by default; only an exact
  `'1'` opts in (`'true'`/`'yes'`/`'on'`/`'0'` do not); independent of deployment mode.
- `src/server/inbox-gate.test.ts` (new, 7 tests) — off: `GET /api/todos` → `200 []`, both mutators
  → `409` naming the flag, and a pre-existing entry is **hidden, not destroyed** (flipping the flag
  back on returns it verbatim). On: the endpoints behave exactly as before, unknown ids still 404.
- `src/server/start-run.test.ts` (+4) — the capability is a hard ceiling on `generateFollowups`: an
  omitted flag pins to `false`, a client asking `true` is overridden **with a 201, not an error**,
  and an enabled server can still opt a single run out.
- `src/workflows/system-prompt.test.ts` (+4, new suite) — end-to-end through the real engine and
  the mock CLI, driving `RunManager` directly (the `cezar run` door): without the flag the agent's
  `--append-system-prompt` is `HANDOFF_ONLY_INSTRUCTIONS`, contains no `CEZ_TODOS_FILE`, writes no
  `todos.json`, and **leaks nothing into a parent cezar's inherited inbox**; the per-task handoff
  journal and `CEZ:DONE` still arrive; a client asking for follow-ups cannot override the gate;
  `CEZ_FOLLOWUPS=1` restores the inbox.
- `web/app/src/components/nav-items.test.ts` (+5) — each gate owns exactly its own item; both
  default to absent before health answers; the result is always an ordered subset of `NAV_ITEMS`.
- `web/app/src/components/app-shell-container.test.tsx` (+2) — the Inbox item and badge disappear,
  every other view is untouched, and `/api/todos` is never requested.
- `web/app/src/routes/inbox.test.tsx` (+3) — a deep-linked `/inbox` says the inbox is **off** (not
  the lie "Inbox empty") and names the flag; the list is not held hostage while health is in flight.
- `web/app/src/routes/new-task.test.tsx` (+3) — the composer's toggle disappears, posts
  `generateFollowups:false`, and does **not** overwrite the remembered preference it never offered.

## Pre-existing tests updated (contract changes, not weakened)

- `system-prompt.test.ts` — its own comment called it "the positive control … flipping the
  `generateFollowups` default … would stop every run from producing inbox entries with the whole
  suite still green". It caught the flip exactly as designed. Re-expressed: the composition suite
  now pins `CEZ_FOLLOWUPS=1` (it is about prompt composition), and the gate gets its own suite.
- `start-run.test.ts` — "keeps generateFollowups absent for old clients (enabled by default)" now
  reads "…on an inbox-enabled server"; the default-off case is asserted in the new suite.
- `health-forge.test.ts` — exact-shape `capabilities` assertions gained `followups`; `CEZ_FOLLOWUPS`
  is now cleared in `beforeEach` and restored in `afterEach` so an ambient value on a dev box
  cannot decide the result.
- Seven web fixtures gained the now-required field: `followups: true` where the suite exercises the
  inbox/nav/composer (so their existing assertions stay meaningful), `false` where it is irrelevant.

## Integration suite

**Skipped — the repo has no integration/E2E suite wired for this gate.** `web/app/e2e/*.e2e.ts`
(including `inbox.e2e.ts`) are driven by `npm run test:e2e` → `.ai/scripts/e2e.sh`, which is not in
`validation.commands` and needs a provisioned browser + dev server this run never started. Recorded
rather than silently passed over. The UI surfaces changed here are covered by the component suites
above, which render the real components against stubbed health payloads.

## Manual end-to-end verification

Beyond the suites, the built server was driven directly — see `final-gate-artifacts/`:

- default (no flag): `/api/health` → `capabilities.followups:false`; `GET /api/todos` → `[]` even
  with a seeded entry on disk; `DELETE` → `409`.
- `CEZ_FOLLOWUPS=1`: `capabilities.followups:true`; `GET /api/todos` → the seeded entry, intact.

## Design-system / style compliance

No such skill or lint is configured in `.ai/agentic.config.json` (`reviewChecklist: null`, no style
command) and none exists under `.ai/skills/`. Skipped. The web changes add no new markup or styling
— they gate existing components — so there is no new design surface to check.

## Style compliance residual findings

None.
