# CI PR and release validation

## Overview

Goal: establish a GitHub Actions gate that validates every pull request update and every push to `main` with unit tests, a production build, end-to-end package checks, and release-package verification.

Source docs: `.ai/specs/001-packaging-npx.md`, `.ai/specs/009-diff-review-gate.md`

## Scope

- Add dependency-free unit tests for stable workflow primitives.
- Add an end-to-end test that packs and installs the built npm package, then exercises the published CLI contract in `CEZ_DRY_RUN=1` mode.
- Add package scripts and keep the repository validation configuration and contributor guidance aligned with the new test gates.
- Add GitHub Actions CI for pull requests targeting `main`, pushes to `main`, and manual runs.
- Validate the same commands locally, then confirm the workflow on the PR created by this run.

## Non-goals

- Publishing a release or changing the package version.
- Changing application, CLI, API, workflow, or UI behavior.
- Reusing or modifying any branch or worktree owned by another active coding agent.

## Implementation Plan

### Phase 1: Test foundations

1.1 Add unit and packaged CLI end-to-end tests with npm scripts.

1.2 Align the autonomous validation gate and contributor documentation with the new tests.

### Phase 2: GitHub CI

2.1 Add a least-privilege GitHub Actions workflow for pull requests and `main` pushes.

2.2 Execute the complete CI sequence locally and verify release-package contents.

## Risks

- The packaged CLI E2E test creates temporary git repositories and installs the generated tarball; it must clean up reliably and avoid relying on developer-global git identity.
- Pull-request workflows run untrusted branch code, so the workflow must stay read-only and must not expose release credentials.
- GitHub-hosted execution can only be confirmed after the PR exists; a failing run will be diagnosed and fixed before this run is reported complete.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Test foundations

- [x] 1.1 Add unit and packaged CLI end-to-end tests with npm scripts. — 8000f1f
- [x] 1.2 Align the autonomous validation gate and contributor documentation with the new tests. — 7e5cd72

### Phase 2: GitHub CI

- [x] 2.1 Add a least-privilege GitHub Actions workflow for pull requests and `main` pushes. — de0c458
- [x] 2.2 Execute the complete CI sequence locally and verify release-package contents. — de0c458
