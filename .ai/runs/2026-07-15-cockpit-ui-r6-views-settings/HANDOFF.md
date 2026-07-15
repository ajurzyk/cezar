# Handoff — R6

## State

**R6 complete** — all 8 Tasks rows done (`f06ecbb`..`ad323d1`), final gate green
(`final-gate-checks.md`: typecheck · 1850 unit · build · e2e 143/143 via agent-browser ·
design-guardian clean). Same branch/PR #396. Next phase: **R7** (legacy retirement, packaging
flip, README screenshots) — open a new run folder per the program spec
`.ai/specs/2026-07-14-cockpit-ui-redesign.md`.

## What R6 delivered

- 1.1 GitHub tab (forge-gated nav, cmdk workflow/skill dropdowns #385) — `f06ecbb`
- 1.2 Inbox restyle (attention dots, Run/Dismiss, CenteredState) — `67ce236`
- 1.3 Registry-driven Settings shell + Appearance — `b6c854f`
- 1.4 Skills under Settings (#377 project-first, #384 stable scroll) — `32b3484`
- 1.5 Agents section: consolidated `PUT /api/config` edit surface (runner, per-runner model
  presets, system prompt single edit place, base branch); additive `GET /api/config`; composer
  `resolveModel` falls back to the configured preset — `9c20080`
- 1.6 Workflows builder on dnd-kit (canvas, palette drag, YAML import/export/preview, 8-step
  limit; capability parity, no API changes) — `33b46d0`
- 1.7 Browser notifications via `deriveAttention` (hidden-tab only, off by default, Settings
  toggle persisted as additive `notifications` ui-state key) — `4123e01`
- 1.8 e2e drift fixes (forge-gated nav settle; 4 settings sections) — `ad323d1`

## Anchors (carry into R7)

- Forge gating: `health.forge.available`; smoke/github e2e settle the nav on the live payload.
- `deriveAttention` (`web/app/src/lib/attention.ts`) is the single status grammar — the
  notification trigger (`run-notifications.tsx`) feeds off `wantsAttention`; do not fork it.
- Settings registry: `web/app/src/routes/settings/registry.tsx` — `mcp`/`keyboard` still
  hidden placeholders.
- API shapes protected (BACKWARD_COMPATIBILITY.md): config/ui-state changes were additive only.
- e2e notification coverage is deliberately unit-pinned (headless Chrome can't display them) —
  stated in `run-notifications.test.tsx`.
- All prior gotchas hold (R1/R4/R5 handoffs).
