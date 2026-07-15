# Run: Cockpit UI redesign — Phase R6 (Views + Settings)

- Date: 2026-07-15
- Branch: `feat/cockpit-ui-r1-platform-shell` (single consolidated PR #396)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"GitHub tab (forge tab)", §"Skills, Workflows, Inbox", §"Settings", §"Cross-cutting" (notifications), Implementation Plan steps 19–20
- Mode: Spec-implementation run

## Tasks

> Executors flip `Status` → `done` in their Step's commit, leave `Commit` = `pending`; dispatcher backfills SHAs.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | GitHub tab: issues/PRs + detail, cmdk workflow/skill dropdowns (#385), forge gating | done | f06ecbb |
| 1 | 1.2 | Inbox restyle: cards, status dots, Run/Dismiss, CenteredState empty (badge logic unchanged) | done | 67ce236 |
| 1 | 1.3 | Settings shell (registry-driven) + Appearance section (theme/accent/density, ui-state.json additive) | done | b6c854f |
| 1 | 1.4 | Skills under Settings: catalog + detail + refresh + bookmarklets, project-first (#377), stable scroll (#384) | done | 32b3484 |
| 1 | 1.5 | Agents section: default runner, model presets, system prompt (single edit place), base branch | done | 9c20080 |
| 1 | 1.6 | Workflows builder on dnd-kit + shadcn: canvas, palette drag, YAML import/export/preview, 8-step limit | done | 33b46d0 |
| 1 | 1.7 | Notifications: browser Notification via deriveAttention (off by default) + Settings toggle | done | 4123e01 |
| 1 | 1.8 | Fix e2e expectation drift from 1.1/1.7 (forge-gated nav settle, 4 settings sections) | done | ad323d1 |

## Goal

The remaining primary views rebuilt in React (GitHub tab, Inbox, Workflows builder) and the Settings surface (registry-driven shell; Skills/Appearance/Agents now, placeholders later), plus the R6 notifications toggle. Functional parity, new visual language — no behavior change where the spec says so.

## Non-goals

Legacy retirement / packaging flip / README screenshots (R7). New workflow-builder capabilities (visual language only). MCP/keyboard Settings sections (registry placeholders, hidden).

## Implementation Plan

### Step 1.1 — GitHub tab
- `/github` route rebuilt in React: issues/PRs lists, detail pane (markdown body via the existing Streamdown/markdown path, label chips, checks badge), and the existing hand-to-agent / drag-to-composer flows — investigate the legacy `web/app.js` GitHub tab for exact behaviors and the `/api/github` payload (protected shape).
- **Searchable cmdk dropdowns** for workflow and skills pickers replacing chip walls (#385) — reuse/extend the composer's existing cmdk primitives if present; project-first skill ordering (#377).
- Whole tab + nav item hidden when health `forge` is null; the env chips popover explains why (pattern exists from R1).
- Unit tests (lists, detail, gating, dropdown filter) + e2e against dry-run (forge availability depends on env — cover what's reachable honestly, gate assertions on the health payload).

### Step 1.2 — Inbox restyle
- `/inbox` route: card list restyled — status dots (deriveAttention), Run / Dismiss buttons, CenteredState empty state. Badge logic (global-events reducer) unchanged.
- Investigate legacy inbox behaviors (`todos.json`-driven) + existing API. Unit tests + e2e (the smoke SSE test already writes todos.json — reuse that pattern to render real cards; screenshot).

### Step 1.3 — Settings shell + Appearance
- `/settings/*` routes: registry-driven sections (`skills`, `appearance`, `agents` now; `mcp`, `notifications`, `keyboard` listed but hidden until implemented — notifications unhides in 1.7). Left section nav (desktop) / stacked (mobile).
- **Appearance**: theme light/dark/system (existing theme system), accent choice (lime default), UI density — persisted in `ui-state.json` via the existing ui-state API (ADDITIVE keys only; investigate current shape and how legacy persists it).
- Unit tests (registry rendering, appearance persistence round-trip) + e2e (flip theme from settings, screenshot).

### Step 1.4 — Skills under Settings
- Move the skills catalog to `/settings/skills`: catalog + detail + refresh + the bookmarklet panel; project skills first and bold (#377); stable scroll/selection across refreshes (#384).
- A read-only skills browser stays reachable from pickers ("View skill" preview from the cmdk dropdown, 1.1).
- Investigate legacy skills tab + `/api/skills*` endpoints. Unit tests + e2e (catalog renders real dry-run skills, detail opens; screenshot).

### Step 1.5 — Agents section
- `/settings/agents`: default runner, per-runner model presets, **the system prompt** (this is its single edit surface — the /new composer intentionally has none, user decision in R4), base branch — consolidating today's `PUT /api/config` knobs (investigate current config shape; additive only).
- Coding-agent-agnostic copy: capabilities (`runner`, `model`, `system prompt`), never vendor config formats.
- Unit tests (form round-trip, validation, 409 surfacing) + e2e (edit + readback against dry-run config).

### Step 1.6 — Workflows builder on dnd-kit
- `/workflows` rebuilt: canvas, drag from palette, YAML import/export/preview, 8-step limit — capability parity with legacy (investigate `web/app.js` workflows tab + `/api/workflows*`), visual language rebuilt on dnd-kit + shadcn.
- dnd-kit as devDependency (bundled). Keyboard-accessible drag per dnd-kit defaults.
- Unit tests (palette→canvas add, reorder, limit, YAML round-trip) + e2e (build a small workflow against dry-run, export YAML; screenshots).

### Step 1.7 — Notifications
- Browser `Notification` on runs entering `waiting`/`review`/failed states, driven by the same `deriveAttention` — fires only when the tab is hidden; **off by default**, toggle in Settings (registry section unhides), permission requested on enable only.
- Unit tests (attention→notify mapping, toggle gating, permission-denied degradation). e2e only if honestly reachable (Notification in headless Chrome — otherwise unit-pinned, stated).

## External References

None beyond the source spec. New devDependencies allowed: `@dnd-kit/*` (1.6), nothing else anticipated.
