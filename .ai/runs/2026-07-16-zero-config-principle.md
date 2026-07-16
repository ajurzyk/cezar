# Execution plan: document the zero-config principle

**Related:** `.ai/specs/2026-07-16-multi-project-switcher.md` (appendix drafted this text); split out per explicit decision so the doctrine is reviewed as repo-wide law, not a spec checkbox.

## Goal

Add a top-level `## Zero config` section to `AGENTS.md` capturing cezar's zero-config principle: nothing the user must configure before it works; new state may be written but never required; exposure/cost is opt-in behind `CEZ_*` flags; degrade rather than fail.

## Scope

- Edit exactly one file: `AGENTS.md` — insert the section between the intro paragraph and `## Task routing`.

## Non-goals

- Any code change; any other doc.

## Risks

- None to runtime. Doctrine binds future work by intent — that is the point, and why it is a standalone PR.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Add the section

- [ ] 1.1 Insert `## Zero config` into AGENTS.md before `## Task routing`
