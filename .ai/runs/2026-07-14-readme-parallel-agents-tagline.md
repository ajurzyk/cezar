# Run: README tagline + multi-backend agent strategies

- Date: 2026-07-14
- Slug: readme-parallel-agents-tagline
- Branch: feat/readme-parallel-agents-tagline
- Owner: pkarw
- Type: docs-only

## Overview

**Goal:** Update `README.md` to (1) add "Parallel coding agents orchestrator" as the
tagline and (2) document the multi-backend / mixed-agent capability — Claude Code,
Codex, and OpenCode runners, selectable per config default, per task, and per
workflow step.

**Brief:** make changes to readme add "Parallel coding agents orchestrator" as a
tagline; add info on supporting multiple and mixed coding agents strategies
(claude, codex, opencode, pi ...).

### Scope

- `README.md` only.

### Non-goals

- No code changes, no changes to other docs.
- No claim that a `pi` backend exists — it does not (verified in
  `src/core/agent-runner.ts`: `RunnerId = 'claude' | 'codex' | 'opencode'`).
  `pi` is mentioned only as an example of a backend the pluggable `AgentRunner`
  seam could host.

### Facts verified against the code

- Runners: `claude` (Claude Code CLI, stream-json), `codex` (`codex app-server`,
  JSON-RPC over stdio), `opencode` (`opencode serve`, HTTP + SSE) —
  `src/core/agent-runner.ts`, `src/core/runner-factory.ts`.
- Backend detection probes installed CLIs; GUI offers only installed runners —
  `src/core/backend-detect.ts`, `src/config.ts`.
- Selection layers: `defaultRunner` in `.ai/cezar/config.json` → per-task pick in
  the GUI → per-step `runner:` in workflow YAML — `src/config.ts`,
  `src/workflows/types.ts`, `src/server/server.ts:54`.
- Env overrides: `CEZ_CODEX_BIN`, `CEZ_OPENCODE_BIN` (`src/core/backend-detect.ts`),
  `CEZ_CLAUDE_BIN` (already documented).
- Parallel variants share a single runner per group (`src/server/server.ts:354`)
  — mixed-agent claims stay at task/step level.

### External References

None (`--skill-url` not provided).

## Risks

- Overclaiming backend support (esp. `pi`) — mitigated by verifying every claim
  against `src/core/` and phrasing `pi` as an extensibility example.
- README drift vs. origin/main gallery section — branch is cut from origin/main
  (8a51b8a) which already includes the screenshot gallery.

## Implementation Plan

### Phase 1: README edits

- 1.1 Add the tagline "Parallel coding agents orchestrator" to the header and
  soften Claude-only phrasing in header/intro (mention codex/opencode).
- 1.2 Add a "Coding agent backends" section documenting the three runners, the
  three selection layers (config default → per task → per step), mixed-agent
  workflow strategies, and extensibility (pi etc. via the AgentRunner seam);
  update the workflow YAML example with a `runner:` override, the env-var table
  with `CEZ_CODEX_BIN`/`CEZ_OPENCODE_BIN`, and the config example with
  `defaultRunner`.

### Phase 2: Validation and PR

- 2.1 Docs-only gate: re-read the full diff; run `npm run typecheck` +
  `npm run build` as a belt-and-braces check.
- 2.2 om-code-review self-review, open PR, normalize labels, om-auto-review-pr
  loop, summary comment.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: README edits

- [x] 1.1 Add tagline and update header/intro phrasing — 4e9b178
- [x] 1.2 Add multi-backend section and update examples/tables — 4e9b178

### Phase 2: Validation and PR

- [x] 2.1 Docs-only validation gate (typecheck + build green)
- [x] 2.2 Self-review, PR #388 (draft), labels `documentation·review·risk-low·skip-qa`; review loop on demand via `/om-auto-review-pr 388`
