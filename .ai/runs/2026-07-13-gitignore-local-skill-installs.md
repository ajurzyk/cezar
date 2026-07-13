# Execution plan: ignore locally installed skills

Date: 2026-07-13
Slug: gitignore-local-skill-installs
Branch: feat/gitignore-local-skill-installs

## Overview

### Goal

Keep locally installed agent-skill artifacts (`.agents/`, `skills-lock.json`) and other
machine-local pipeline state out of git status so they don't pollute the core repo.

### Scope

- `.gitignore` — add entries for `.agents/`, `skills-lock.json`, `.ai/tmp/`, and the QA
  artifact paths the agent pipeline generates per run (`.ai/qa/artifacts_*/`,
  `.ai/qa/test-env.json`).
- Bootstrap the agent PR pipeline (this repo had no `.ai/agentic.config.json`): config,
  GitHub tracker descriptor, pipeline directories, and the project docs (`SDLC.md`,
  `AGENTS.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`), all generated from this
  repository by `om-setup-agent-pipeline --defaults`.

### Non-goals

- No changes to application code (`src/`, `web/`, `scripts/`).
- No changes to how skills are installed or resolved at runtime.
- No removal of already-tracked files (nothing under `.agents/` or `skills-lock.json`
  is tracked today, so no `git rm` is needed).

## Risks

- Ignoring `skills-lock.json` means the pinned skill hashes are per-machine and not
  shared through the repo. That matches the brief (these are local installs), but if the
  team later wants reproducible skill versions, the entry can be removed and the file
  committed instead.
- The GitHub token available to this run cannot create labels (HTTP 403), so most of the
  pipeline label taxonomy (`review`, `skip-qa`, `needs-qa`, `priority-*`, `risk-*`, …)
  does not exist in the repo yet. Label operations degrade to logged skips per the
  tracker descriptor. Create them later with the `ensure-label-taxonomy` commands in
  `.ai/trackers/github.md` using a token with label permissions.

## Implementation plan

### Phase 1: Bootstrap agent pipeline

Generate the pipeline config and project docs that every `om-*` skill reads. Detected
defaults: npm runner, validation commands `npm run typecheck` + `npm run build`, base
branch `auto` (resolves to `main`), tracker `github`, labels enabled, QA gate on.

### Phase 2: Ignore local skill installs

Add the `.gitignore` entries for local skill installs and per-run pipeline state.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Bootstrap agent pipeline

- [ ] 1.1 Write `.ai/agentic.config.json` and install `.ai/trackers/github.md`
- [ ] 1.2 Create pipeline directories with `.gitkeep`
- [ ] 1.3 Generate `SDLC.md`, `AGENTS.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`

### Phase 2: Ignore local skill installs

- [ ] 2.1 Add `.agents/`, `skills-lock.json`, `.ai/tmp/`, and QA artifact entries to `.gitignore`
