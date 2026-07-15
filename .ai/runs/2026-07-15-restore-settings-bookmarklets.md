# Restore Settings bookmarklets

## Overview

Goal: make the existing bookmarklet generator easy to find again as a first-class Settings subpage.

Source docs: `.ai/specs/011-bookmarklets.md`, `.ai/specs/2026-07-14-cockpit-ui-redesign.md`

## Scope

- Add `/settings/bookmarklets` to the registry-driven Settings navigation and index.
- Reuse the existing generic and per-skill bookmarklet generator without changing its protected `/new` contract.
- Preserve the existing `/settings/skills?skill=__bm` entry point for compatibility.
- Update affected specs and UI tests.

## Non-goals

- Change bookmarklet JavaScript, launch-key behavior, port discovery, or GitHub URL matching.
- Add support for other forges or hosted bookmarklet pages.
- Change server routes or API response shapes.

## Implementation Plan

### Phase 1: Promote the existing generator

1. Extract the bookmarklet panel into a reusable Settings section component.
2. Register the visible Bookmarklets Settings route while retaining the Skills deep link.

### Phase 2: Verify navigation and behavior

1. Update registry, route, and bookmarklet surface tests for the new subpage.
2. Update the redesign spec route and Settings inventory, then run the configured validation gate.

## Risks

- The generator embeds the launch key; the implementation must retain its current same-origin fetch and protected `/new?skill=&ref=&auto=&key=` format.
- The task sandbox that drafted this plan could not write Git metadata or reach GitHub. Resolved: the branch was re-authored, rebased onto the base tip, and pushed as PR #399.
- Validation was reported infrastructure-blocked in the sandbox (`npm test` 1,881/1,882, `npm run test:package` timing out). Resolved: the full gate — `typecheck`, `test` (1,908 passing), `test:unit`, `build`, `test:package` — runs green outside that sandbox.
- The `feat/cockpit-ui-r1-platform-shell` base branch carries pre-existing e2e failures unrelated to this change (`smoke` ⌘N accelerator, `settings-agents`, `github`, `repo-git`, `review-gate`, `task-changes`, `task-thread`, `workflows`). They fail identically at the base tip and are out of scope here.

## Progress

PR: #399

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Promote the existing generator

- [x] 1.1 Extract the bookmarklet panel into a reusable Settings section component — squashed into this PR's single commit
- [x] 1.2 Register the visible Bookmarklets Settings route while retaining the Skills deep link — squashed into this PR's single commit

### Phase 2: Verify navigation and behavior

- [x] 2.1 Update registry, route, and bookmarklet surface tests for the new subpage — squashed into this PR's single commit
- [x] 2.2 Update the redesign spec route and Settings inventory, then run the configured validation gate — spec updated in this PR's single commit; full gate green (typecheck, 1,908 tests, test:unit, build, test:package)
- [x] Post-review: add the `settings-bookmarklets` e2e spec and correct the settings-nav count in `settings-appearance.e2e.ts`
