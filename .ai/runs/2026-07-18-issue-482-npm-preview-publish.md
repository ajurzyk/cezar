# Run: implement npm preview publishing (issue #482)

Date: 2026-07-18 · Branch: `feat/issue-482-npm-preview-publish` · Issue: #482
Source doc: .ai/specs/2026-07-18-npm-preview-publish.md (merged in PR #503)

## Overview

**Goal:** CI publishes an installable npm snapshot of the CLI after every green
`verify` run — PR snapshots under dist-tag `pr-<N>` with a sticky copy-pasteable
comment, `develop` pushes under `@develop`, `main` pushes under `@main` — with a
dry-run fallback that keeps CI green while `NPM_TOKEN` is not yet configured.

**Scope (spec Phases 2–4):**
- Pure snapshot decision logic `src/release/snapshot.ts` + colocated vitest suite.
- Orchestrator `scripts/release-snapshot.mjs` (stamp versions, pin alias, publish
  both packages with explicit `--tag` + provenance, emit JSON, `--dry-run` mode).
- `ci.yml`: `develop` in triggers, `publish-snapshot` job (`needs: verify`,
  same-repo guard, provenance permissions, non-cancellable concurrency, sticky PR
  comment, step summary) + `npm-preview-cleanup.yml` (dist-tag rm on PR close).
- Docs: `docs/publishing.md` runbook, README **Preview builds** section,
  server-install pinned-preview note.

**Non-goals / deferred:**
- **Spec Phase 1 (the `@pat-lewczuk/cezar` → `@open-mercato/cezar` rename) is NOT
  in this PR** — open PR #501 already implements it (package.json, lockfile,
  alias, `readOwnName`, README, BACKWARD_COMPATIBILITY §1/§6). To stay
  merge-order-independent, everything here is **name-agnostic**: package names are
  read from the checked-out manifests at runtime, never hardcoded.
- Moving `latest` from CI, tag-driven release workflow, fork-PR previews (spec Out of scope).

## Risks

- Overlap with PR #501: none at the file level except docs (README/server-install
  docs get additive sections; #501 edits different lines). Name-agnostic code makes
  merge order irrelevant.
- `NPM_TOKEN` not configured yet: the publish job must degrade to a loud `--dry-run`
  and still pass — the implementing PR itself is the first live test.
- `secrets` context is unavailable in job-level `if`: token detection happens
  inside the script via env, not in workflow conditionals.

## Progress

PR: #506

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Snapshot decision logic

- [x] 1.1 Add `src/release/snapshot.ts` (`computeSnapshot`, `stampManifests` — pure, name-agnostic) — 8a84cca
- [x] 1.2 Add `src/release/snapshot.test.ts` (event/channel matrix, run-attempt suffix, never-`latest`, exact-pin stamping) — 8a84cca

### Phase 2: Publish orchestrator

- [x] 2.1 Add `scripts/release-snapshot.mjs` (env-driven, `--dry-run`, GITHUB_OUTPUT JSON, publish order root→alias) — 9ea6bdf
- [x] 2.2 Wire an orchestrator dry-run assertion into the test suite — 9ea6bdf (test/e2e/release-snapshot.test.ts, 3/3)

### Phase 3: CI workflows

- [x] 3.1 Extend `ci.yml`: `develop` triggers + `publish-snapshot` job + step summary — faa0281
- [x] 3.2 Sticky PR comment step + `.github/workflows/npm-preview-cleanup.yml` — faa0281

### Phase 4: Docs

- [x] 4.1 `docs/publishing.md` runbook + README Preview-builds section + server-install pinned-preview note — e8f9a81
