# Handoff — Cockpit UI redesign, Phase R2 (Protocol v2)

## State (final — R2 COMPLETE)
- 8/8 Steps. Gate + e2e green (959 unit / 44 e2e). All work on the single consolidated PR #396 branch `feat/cockpit-ui-r1-platform-shell`.
- Next: **Phase R3 (thread view)** — new run folder `.ai/runs/2026-07-14-cockpit-ui-r3-thread/`, same branch/PR. Spec steps 8–12. Key inputs ready: `useRunEvents` (both SSE names), `web/app/src/protocol/` mirror, plan dock semantics (plan.updated full-replacement), image events ride v1 only until R3 links by itemId.

## Context
- The protocol contract: spec §"Normalized agent-event protocol v2" + the authoritative mapping tables in `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §7 (READ THESE FIRST).
- R1's conventions all apply (see the R1 run folder's HANDOFF "Rules"/"Gotchas" sections — same worktree family, same gate: `npm run typecheck` · `npm test` · `npm run build` + `npm run test:e2e` via agent-browser).
- R1 left honest slots this phase fills: `titleSummary` (runTitle() in task-groups), `±` diffStat (tasks table renders `—`), `permission`/`unseen` predicates in `lib/attention.ts`.

## Resume
`om-auto-continue-pr-loop <R2 prNumber>` once the PR exists; until then continue the run folder on the branch.
