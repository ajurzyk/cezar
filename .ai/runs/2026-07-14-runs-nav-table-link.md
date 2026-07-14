# Runs nav as table link + table-header Active/Archived tabs

Date: 2026-07-14
Owner: pkarw
Branch: `feat/runs-nav-table-link`
Source doc: `.ai/specs/` has no spec for #348; behavior extends PR #376 (runs table view).

## Goal

Make the sidebar **Runs** nav tab the entry point to the full-width runs table
view, make selecting a specific run open its detail pane (with Runs still
active), and give the table header its own Active/Archived filter tabs.

## Scope

- `web/app.js` — nav click behavior, removal of the `#list-tabs` grid-icon
  toggle, table-header tabs render + click handling.
- `web/index.html` — no structural change expected (tabs render into the
  existing `#runs-table` container).
- `web/style.css` — styles for the table-header tabs.

## Non-goals

- No changes to the server, API, SSE, telemetry, or run store.
- No changes to the sidebar run list itself (it keeps its own Active/Archived
  tabs — they filter the sidebar list and stay in sync via shared
  `state.listView`).
- No framework/build-tool introduction (per AGENTS.md).

## Behavior contract

1. Clicking the **Runs** nav button (`#tabs button[data-view="runs"]`) always
   lands on the table view — including when Runs is already the active view
   (it acts as "back to overview").
2. Clicking a run — sidebar `.run-item` or table row — opens the detail pane
   (`#detail`), Runs nav stays selected. (Existing `selectRun` already flips
   `runsView` to `'list'`; unchanged.)
3. Deep links to a run keep opening the detail pane.
4. Programmatic `showRunsView()` callers (inbox goto/start, github checkout,
   deep link) that immediately `selectRun(...)` still end on the detail pane —
   the nav handler's `setRunsView('table')` runs synchronously before
   `selectRun` flips back to `'list'`.
5. The grid-icon `toggle-view` button in `#list-tabs` is removed (nav link
   fully covers it).
6. The table header (`.rt-head`) gets Active/Archived tabs bound to
   `state.listView`, with counts, mirroring the sidebar tabs; changing the
   filter in either place re-renders both.
7. `runsView` persistence in ui-state stays as-is.

## Risks

- The repo has no GUI test framework (vanilla JS, no bundler — AGENTS.md);
  verification is `npm run typecheck`, `npm run build`,
  `node --check web/app.js`, plus a manual `CEZ_DRY_RUN=1` smoke pass.
- `showRunsView()` triggers the nav handler via `.click()` only when the tab
  is inactive; flows relying on it must still end on the right pane (covered
  by contract item 4).

## Implementation Plan

### Phase 1: Runs nav opens the table

- 1.1 `#tabs` click handler: on `data-view="runs"`, call `setRunsView('table')`
  (and keep firing even when the tab is already active — currently the handler
  runs on every click, keep that).
- 1.2 Remove the `toggle-view` button from `renderRunList()` and its branch in
  the `#list-tabs` click handler; drop the now-dead `.view-toggle` CSS.
- 1.3 Verify programmatic flows (`showRunsView()` + `selectRun`) and the
  deep-link path still land on the detail pane; adjust `showRunsView()` if
  needed.

### Phase 2: Table-header Active/Archived tabs

- 2.1 Render Active/Archived tab buttons (with counts) in `renderRunsTable()`'s
  `.rt-head`, selection driven by `state.listView`.
- 2.2 Handle tab clicks in the `#runs-table` listener (before row selection):
  set `state.listView`, re-render sidebar list and table.
- 2.3 Style the tabs in `web/style.css` consistent with `#list-tabs`.

### Phase 3: Validation

- 3.1 Run `npm run typecheck`, `npm run build`, `node --check web/app.js`.
- 3.2 Manual smoke pass with `CEZ_DRY_RUN=1` (nav click → table, row click →
  detail, tab filter, back to table via Runs).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Runs nav opens the table

- [ ] 1.1 Runs nav click always shows the table view
- [ ] 1.2 Remove the #list-tabs grid-icon toggle
- [ ] 1.3 Verify programmatic showRunsView/selectRun flows land on detail

### Phase 2: Table-header Active/Archived tabs

- [ ] 2.1 Render Active/Archived tabs in the table header
- [ ] 2.2 Handle table-header tab clicks and sync with sidebar
- [ ] 2.3 Style the table-header tabs

### Phase 3: Validation

- [ ] 3.1 Full validation gate (typecheck, build, node --check)
- [ ] 3.2 Manual CEZ_DRY_RUN smoke pass
