# Run: Codex-desktop-parity UI redesign — specification + mockups

- Date: 2026-07-14
- Branch: `feat/codex-ui-redesign-spec`
- Base: `main`
- Type: docs/spec (no product code changes)
- Source brief: redesign the whole cezar cockpit UI/UX to Codex-desktop parity using React + Vite + Tailwind + shadcn/ui, keeping 100% of current functionality. Deliverable of THIS run is the specification (`.ai/specs/2026-07-14-codex-ui-redesign.md`) plus HTML mockups built with shadcn styling on real cezar data, with screenshots attached to the PR — so the spec can be approved visually and then implemented autonomously.

## Goal

Produce an implementation-ready, phased specification for the full UI redesign, grounded in research (Codex desktop, Claude Code, opencode web, paseo, mercato-sandboxes visual language, agent event protocols incl. ACP), with high-fidelity HTML mockups and screenshots that prove the design direction.

## Decisions locked with the user (2026-07-14)

1. **UI stack**: full rewrite of `web/` as React + Vite + Tailwind + shadcn/ui, compiled to static assets served by the existing Hono server; zero runtime deps for end users unchanged.
2. **Spec shape**: one master spec, phased; the normalized agent-event protocol, git GUI + forge drivers, and Settings tab are phases inside it.
3. **Git GUI depth**: review + ship actions (diffs, changes/files tab, commit, push, branch, View PR / create PR via driver) — no hunk staging, no rebase UI. Degrades to plain git when `gh` is absent; forge-driver seam for GitLab etc. later (GitHub-only for now, features hidden when no forge is available).

## Scope

- In: research notes (`.ai/analysis/`), the spec, HTML mockups (under `docs/mockups/`), screenshots (committed + attached to PR), pipeline bootstrap files (`.ai/agentic.config.json`, tracker descriptor, SDLC.md, AGENTS.md, CODE_REVIEW.md, BACKWARD_COMPATIBILITY.md — generated this run because the repo had no pipeline config).
- Non-goals: NO changes to product code (`src/`, `web/`) in this run; no dependency changes; implementation happens in follow-up runs driven by the spec's Implementation Plan.

## Related issues

Folded into the spec as requirements: #390 (git integration look), #389 (task list: auto-summary titles, git +/- stats), #386 (full-screen new-task composer), #385 (searchable skills dropdown in GitHub tab), #383 (plan mode not marked selected), #382 (TODO/plan checkbox lists), #381 (tool-result display), #380 (skills autocomplete), #378 (dark-mode selector clipped), #377 (project skills first/bold).

## Risks

- Research sources (Codex desktop, external repos) are external; findings recorded to `.ai/analysis/` so the spec stays reviewable offline.
- Mockups are static HTML approximations of the future React app — close enough for visual approval, not pixel-contracts.
- The repo had no `.ai/agentic.config.json`; it was bootstrapped with `om-setup-agent-pipeline --defaults` and ships in this PR. Validation gate = `npm run typecheck` + `npm run build` (docs-only run: gate proves the repo stays healthy).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Research

- [x] 1.1 Parallel research: cezar code map, Codex desktop UX, agent event protocols (Claude/Codex/OpenCode/ACP), opencode web UI, paseo, mercato-sandboxes visuals, diff/highlighting tech — 4b804d3
- [x] 1.2 Commit distilled research notes to .ai/analysis/ — 06fcf59

### Phase 2: Specification

- [x] 2.1 Spec skeleton with resolved decisions (.ai/specs/2026-07-14-codex-ui-redesign.md) — 4b804d3
- [x] 2.2 Full spec: architecture, normalized event protocol, view-by-view UX, git GUI + forge drivers, settings, mobile-first rules, edge cases, risks — 5f913fa
- [x] 2.3 Phased implementation plan (each step shippable, app always working) — 5f913fa

### Phase 3: Mockups

- [ ] 3.1 Mockup scaffold: shared shadcn-style tokens/CSS + real cezar data extracted from the live app
- [ ] 3.2 Mockups: chat/run thread (tool calls, todo/plan, review gate), new-task full-screen composer
- [ ] 3.3 Mockups: git/changes/files view, session task list, settings (skills), mobile variants
- [ ] 3.4 Screenshots (desktop + iPhone viewport) committed under docs/mockups/screenshots/

### Phase 4: Ship

- [ ] 4.1 Validation gate (npm run typecheck, npm run build) + self-review (om-code-review lens)
- [ ] 4.2 Open PR with screenshots embedded, labels normalized
- [ ] 4.3 om-auto-review-pr autofix loop until clean
- [ ] 4.4 Summary comment + cleanup
