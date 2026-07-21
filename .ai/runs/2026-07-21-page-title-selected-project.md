# Execution plan: project-aware browser page titles

Source doc: .ai/specs/2026-07-21-page-title-selected-project.md

## Goal

Make the hydrated cockpit browser title identify the selected project and current page or loaded task, using one live writer and truthful fallbacks.

## Scope

- Add a pure document-title formatter and thin React effect.
- Add project-relative route metadata and a pure route-context resolver beside `AppRoutes`.
- Resolve the selected project's registry name and task title in `AppShellContainer` using existing project/query primitives.
- Add unit and shell-integration regression coverage.
- Preserve the static pre-hydration title and every server/API/state contract.

## Non-goals

- Favicon or unread-count changes.
- Changes to `src/server/static-ui.ts` or `web/app/index.html`.
- New router modes, head-management dependencies, project renaming, or server endpoints.
- Per-task sub-tab suffixes or raw route identifiers in titles.

## Risks

- A health fallback must never label a non-boot project with the boot repository's basename.
- The shell sits outside `ProjectScopeProvider`; active project identity must use the existing URL-aware helper.
- Dynamic task titles must reuse the explicit project run-list cache without creating a competing data source.
- Route metadata can drift unless every route family is covered by the pure resolver tests.

## Implementation Plan

### Phase 1: Pure title and route contracts

1. Add the pure title formatter and thin effect with table-driven unit coverage.
2. Add route-label metadata and the pure route-context resolver with route-family coverage.

### Phase 2: Live shell integration

1. Wire active project, safe boot fallback, route context, and task title into the shell's sole title writer.
2. Add shell integration coverage for scoped, boot, global, no-repo, live-name, task-title, and navigation behavior.
3. Run the complete configured validation gate, self-review, automated review, and browser-title verification.

## Progress

PR: #592

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Pure title and route contracts

- [ ] 1.1 Add the pure title formatter and thin effect with table-driven unit coverage
- [ ] 1.2 Add route-label metadata and the pure route-context resolver with route-family coverage

### Phase 2: Live shell integration

- [ ] 2.1 Wire active project, safe boot fallback, route context, and task title into the shell's sole title writer
- [ ] 2.2 Add shell integration coverage for scoped, boot, global, no-repo, live-name, task-title, and navigation behavior
- [ ] 2.3 Run the complete configured validation gate, self-review, automated review, and browser-title verification
