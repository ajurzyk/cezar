# Run: spec for issue #482 — npm preview publishing CI

Date: 2026-07-18 · Branch: `feat/issue-482-npm-publish-ci-spec` · Issue: #482

## Overview

**Goal:** Write the specification for extending cezar's GitHub CI so every green PR,
develop push, and main push publishes an npm snapshot of the CLI (`cezar-cli@<snapshot>`)
under the open-mercato npm org, with dist-tags `pr-<N>` / `develop` / `main`, a
copy-pasteable PR comment with exact version numbers, README/installer updates, and an
admin configuration runbook for npm + GitHub.

**Deliverable:** a spec document at `.ai/specs/2026-07-18-npm-preview-publish.md`
(docs-only run — no code changes). Implementation happens later via `om-auto-create-pr`
with the spec as `Source doc:`.

**Scope:**
- The spec itself: package naming/ownership decision (`@open-mercato/cezar` + `cezar-cli`
  alias), snapshot versioning scheme, dist-tag channels, workflow design (triggers, guards,
  secrets, provenance, PR comment, tag cleanup), docs/installer touchpoints, admin runbook,
  test plan, implementation phases.

**Non-goals:**
- Implementing the workflow, renaming the package, or touching any code in this run.
- Publishing anything to npm from this run.

### External References

- `open-mercato/open-mercato` workflow `npm-snapshot-preview.yml` (precedent cited in
  issue #482): adopted the same-repo guard, explicit dist-tag channels, provenance via
  `id-token: write`, and the PR-comment pattern. Rejected nothing; cezar's variant
  triggers automatically after CI instead of `workflow_dispatch`-only.

## Risks

- Package rename (`@pat-lewczuk/cezar` → `@open-mercato/cezar`) touches a surface
  protected by `BACKWARD_COMPATIBILITY.md` §6 — the spec must define the migration and
  deprecation path explicitly.
- `latest` semantics from the brief are ambiguous ("for main as current latest main
  alias"); the spec resolves this as: `main` dist-tag on every main push, `latest` only
  from tagged releases — recorded as a resolved default the owner can flip.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Draft the spec

- [ ] 1.1 Write `.ai/specs/2026-07-18-npm-preview-publish.md`
- [ ] 1.2 Self-review the spec against BACKWARD_COMPATIBILITY.md and issue #482

### Phase 2: PR

- [ ] 2.1 Open the PR, apply pipeline labels
- [ ] 2.2 Run om-auto-review-pr autofix loop, post summary comment
