# Spec: Full Mobile Support for the Cezar GUI

**Status:** Implemented on branch `feat/mobile-support` (Phases 0–6). Built mobile-first; desktop (`lg+`) preserved by breakpoint, no runtime `mobileShell` flag (see note below). `yarn typecheck` + `yarn build` green. Remaining: real-device/screen-reader QA, the deferred items in §10, and the design sign-off in §10.

> **Implementation deviations from this spec:** (1) No runtime `mobileShell` feature flag — desktop is preserved by construction via `lg:` breakpoints, which is lower-risk than dual code paths. (2) Swipe-to-dismiss on sheets deferred (backdrop/Esc/close only). (3) Runners latency `title=` tooltip left hover-only (low value). (4) Sub-11px uppercase micro-labels left as a design idiom pending design review. (5) Four low-traffic fallback/error page wrappers keep `px-6` rather than `PageContainer` to avoid a desktop padding delta. (6) Skills row "kebab" (previously a dead no-op) became a functional 2-item menu.
**Scope:** `packages/gui` (Next.js 15 + Tailwind cockpit)
**Target:** Phones (≥360px) and tablets (≥768px) in portrait and landscape, in addition to existing desktop.
**Author:** _spec mode_
**Date:** 2026-06-06

---

## 1. Goals & Non‑Goals

### Goals
- Every authenticated screen is usable, legible, and operable down to a **360px‑wide** phone (support floor; 320px best‑effort) and scales up cleanly to tablet and desktop.
- No horizontal page scroll on any screen (intentional `overflow-x-auto` on *individual* wide tables is allowed and indicated). Overflow bugs are fixed at the source, not hidden with `overflow-x-hidden`.
- All primary actions reachable without hover (touch‑first), with ≥44×44px touch targets for interactive controls.
- One responsive app shell with a mobile navigation pattern replacing the always‑on 260px sidebar.
- Overlays (drawer, modal, sheets, nav, action sheet) lock background scroll, trap and restore focus, and stack on a documented z‑index scale (§3.6).
- The cockpit stays useful on the move: Realtime survives backgrounding/network changes and degrades gracefully on cellular (§3.7).
- Reuse a small set of new responsive primitives instead of bespoke per‑screen hacks.

### Non‑Goals
- No native app / PWA install flow (can be a later phase; we will add the viewport/theme meta that a PWA would need anyway).
- No redesign of the visual language (colors, typography scale stay as in `tailwind.config.ts`).
- No offline support or service worker.
- Not changing data models, server actions, crons, or the runner protocol.

---

## 2. Current State (diagnosis summary)

The app is desktop‑only. Key structural facts driving this spec (file references are current as of this spec):

1. **No viewport meta tag** anywhere (`src/app/layout.tsx` `metadata` has no `viewport`). Mobile browsers will render at a ~980px virtual viewport and downscale → everything tiny. **This is the single highest‑impact fix.**
2. **App shell is a fixed two‑column flex** (`src/app/layout.tsx:72`): a `w-sidebar` (260px) `shrink-0` sidebar that is `sticky h-screen`, plus `main`. The sidebar **never hides or collapses** and there is **no mobile nav** (no hamburger/drawer). On 375px this leaves ~115px of content width.
3. **Tailwind has no custom breakpoints** — defaults apply (`sm 640 / md 768 / lg 1024 / xl 1280`). Responsive prefixes are used sparsely and inconsistently (20× `lg`, 23× `sm`, 9× `md`, 1× `xl` across the whole app).
4. **Wide data tables** on Issues (8 col), PRs (9 col), Cockpit runs (8 col), Runners (7 col), Team, with hardcoded cell widths and `px-6` padding — unreadable on phones, no card fallback.
5. **Fixed‑width overlays:** `run-drawer.tsx` is `w-[420px]` (wider than the viewport); `run-status-dots` tooltip is `min-w-[260px]`; `row-menu-portal` is a 224px portal positioned against `window.innerWidth`.
6. **Hover‑only affordances:** Inbox row action buttons (`group-hover:opacity-100`), status‑dot tooltips (`onMouseEnter`), `title=` tooltips on runners/latency — invisible/unreachable on touch.
7. **Hardcoded content widths** that overflow narrow viewports: search inputs `min-w-[220px]`, filter selects `min-w-[7.5rem]`, settings preset `min-w-[18rem]`, wizard/settings `max-w-md`, page `max-w-[1080px] px-8`, workflow step grid `grid-cols-[auto_minmax(220px,1fr)_minmax(220px,2fr)_auto_auto]`, analytics `w-24` labels, activity `w-16` timestamp, acceptance `grid-cols-[200px_1fr_60px]`.
8. **Modals are already responsive** (`fixed inset-0 ... p-4` + `w-full max-w-md/lg`) — they need only minor touch‑target + internal‑scroll polish.

**The good news:** stat‑card grids already use `sm:grid-cols-2 lg:grid-cols-4`, detail views already use `lg:grid-cols-[...]` two‑pane patterns, and modals already use `w-full max-w-*`. The responsive idiom exists; it is just not applied at the shell level or to tables/overlays.

---

## 3. Foundations (build these first — they unblock every screen)

These are app‑wide and must land before per‑screen work.

### 3.1 Viewport & theme meta
Add a Next.js `viewport` export to `src/app/layout.tsx`:
```ts
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',        // for iOS safe-area (notch)
  themeColor: '#10131a',       // matches surface DEFAULT
};
```
- Add `min-h-dvh` (dynamic viewport height) usage where `h-screen`/`min-h-screen` currently breaks under mobile browser chrome (sidebar/drawer, run detail shell, login).
- Add iOS safe‑area padding utilities (`env(safe-area-inset-*)`) to the app shell, bottom nav, and any `fixed bottom-*` bars (Inbox bulk bar, jump‑to‑bottom).

### 3.2 Breakpoint conventions (resolved — see §10.1)
Adopt a documented breakpoint contract using Tailwind defaults:
- `< sm (640)` = **phone** (support floor 360px): single column, bottom tab bar + hamburger, tables → cards, full‑screen overlays.
- `sm–lg` = **tablet**: condensed multi‑column, mobile nav via hamburger drawer (no sidebar, no bottom bar).
- `≥ lg (1024)` = **desktop**: current 260px sidebar layout unchanged.

All new responsive classes are **mobile‑first**: base = phone, then `sm:`/`md:`/`lg:` add desktop affordances. Existing desktop‑first hardcodes get a mobile base + `lg:` restore.

**The 768–1024 seam (explicit):** nav switches to mobile at `lg` (1024) but tables switch to cards at `md` (768). So tablets in the `md–lg` band get **mobile nav (hamburger drawer) + desktop‑style tables**. This is intentional: a tablet has the width for a real table but not for a 260px sidebar. Each table screen in §6 must therefore look correct in all three states — cards (`< md`), table + mobile nav (`md–lg`), table + sidebar (`lg+`) — not just the phone and desktop extremes.

### 3.3 Responsive app shell + mobile navigation — **new components**
Replace the static shell in `layout.tsx` with a responsive shell. New components:

| Component | File (proposed) | Responsibility |
|---|---|---|
| `AppShell` (client) | `src/components/shell/app-shell.tsx` | Holds the open/close state for mobile nav; renders Sidebar (desktop) + MobileNav + MobileTopBar; provides safe‑area + `dvh` layout. |
| `MobileTopBar` | `src/components/shell/mobile-topbar.tsx` | `< lg` only. Hamburger button (≥44px) on the left, brand/workspace name centered or left, sync indicator + avatar on right. Sticky, `h-topbar`. |
| `MobileNavDrawer` | `src/components/shell/mobile-nav-drawer.tsx` | Off‑canvas slide‑in drawer (left) containing the existing `NAV` items, workspace switcher, user block, sign‑out. Backdrop, focus trap, Esc/back‑button close, close on route change. |
| `BottomTabBar` | `src/components/shell/bottom-tab-bar.tsx` | `< sm` only (in scope per §10.2). 5 primary destinations: Inbox, Issues, PRs, Runs, More. Thumb‑reachable; works alongside the hamburger drawer. |

Shell behavior by breakpoint:
- **Desktop (`lg+`):** current `Sidebar` shown (`hidden lg:flex`), no MobileTopBar, no drawer. Unchanged.
- **Tablet/phone (`< lg`):** `Sidebar` hidden; `MobileTopBar` shown; nav reached via `MobileNavDrawer` (and/or `BottomTabBar` on phone).

Refactor notes:
- `Sidebar` becomes `hidden lg:flex` (no markup change beyond the wrapper class) and its nav list is extracted into a shared `NavItems` component reused by `MobileNavDrawer` so the nav definition (`NAV` array) lives in one place.
- `TopBar` becomes the desktop‑only top bar (`hidden lg:flex`); its contents (SyncIndicator, notifications, avatar) are shared with `MobileTopBar`.
- The existing `<main className="flex-1">` keeps content; add responsive padding (see §3.5) and bottom padding equal to bottom‑nav height + safe area when `BottomTabBar` is used.

### 3.4 Touch‑target + hover‑to‑tap primitives — **new/updated components**
- **Touch sizing:** icon buttons must be ≥44px on touch. Audit `h-7 w-7` (row‑menu triggers, team delete), `h-8 w-8` (topbar avatar), `p-1` close buttons, and nav icon hit areas. Introduce a shared button size token (e.g., a `iconButton` class in `ui/`) giving `min-h-11 min-w-11` (44px) on touch, condensable on desktop with `lg:h-8 lg:w-8`.
- **Tooltip → tap:** create `ResponsiveTooltip` (`src/components/ui/responsive-tooltip.tsx`) that is hover‑on‑pointer‑fine and tap‑to‑toggle on touch (`@media (pointer: coarse)`), replacing `title=` attributes and the hover‑only `RunStatusDots` tooltip and latency tooltips.
- **Hover‑reveal actions → always visible / overflow menu:** the Inbox `group-hover:opacity-100` action buttons must be either always visible on touch or collapsed into a kebab/overflow menu reachable by tap.

### 3.5 Responsive layout primitives — **new shared utilities/components**
Create a small set so screens stop hardcoding:
- `PageContainer` (`src/components/ui/page-container.tsx`): standard responsive page padding + max‑width. Replaces ad‑hoc `px-8 py-6` / `px-6 py-6` / `max-w-[1080px] px-8`. Phone `px-4 py-4`, `sm:px-6`, `lg:px-8`; optional `max-w` prop.
- `ResponsiveTable` / `DataList` pattern (`src/components/ui/data-table.tsx` + `data-card-list.tsx`): a single source for "table on `md+`, stacked cards on `< md`." See §6.1 for the card pattern. Tables that must stay tabular get an `overflow-x-auto` wrapper with an edge‑fade/scroll hint.
- `FilterBar` (`src/components/ui/filter-bar.tsx`): wraps search + selects. Phone: search full‑width on its own row; filter selects collapse into a single "Filters" sheet/disclosure with a count badge. `sm+`: inline `flex-wrap`. Removes `min-w-[220px]` / `min-w-[7.5rem]` overflow.
- `Sheet` / `Drawer` (`src/components/ui/sheet.tsx`): a responsive overlay primitive — **full‑screen (or bottom‑sheet) on phone, side‑drawer on desktop**. `RunDrawer` and the run‑detail step pane and the filter sheet all use it. Replaces the fixed `w-[420px]`.
- `Modal` (`src/components/ui/modal.tsx`): consolidate the 4 near‑identical modals (`run-now-modal`, `run-action-for-issue-modal`, `run-flow-for-issue-modal`, `run-action-for-pr-modal`) into one primitive with body `overflow-y-auto max-h-[85dvh]`, full‑width buttons on phone, safe‑area aware.

> These primitives are the bulk of the net‑new component work. Per‑screen tasks below mostly mean "adopt the primitive + add mobile‑first classes."

### 3.6 Interaction & runtime behavior (overlays, focus, keyboard, gestures)
Layout is only half the job; these runtime concerns currently have **no implementation in the codebase** and must be built into the shared primitives so every screen inherits them.

- **Body scroll‑lock.** When any overlay opens (`MobileNavDrawer`, `Sheet`, `Modal`, `ActionSheet`), background scroll must lock and the scroll position restore on close. Build a single `useScrollLock` hook (`src/lib/use-scroll-lock.ts`) used by all overlay primitives. (iOS needs the `position: fixed` body technique, not just `overflow: hidden`, to actually stop rubber‑band scroll.)
- **Focus management.** Each overlay traps focus while open, closes on Esc and Android back, and **restores focus to the trigger** on close. Share a `useFocusTrap` hook. Drawer/sheet get `role="dialog"` + `aria-modal` + labelled headings.
- **Z‑index scale (documented).** Z‑index today is ad‑hoc (`z-50` used 7×, plus `z-10/20/30/40`) and `RunDrawer` and modals are both `z-50`. Define a named scale and use it everywhere new layers are added:

  | Layer | Token | z |
  |---|---|---|
  | Sticky topbar / cockpit tabs | `z-sticky` | 30 |
  | Bottom tab bar | `z-nav` | 40 |
  | Overlay backdrop | `z-backdrop` | 50 |
  | Drawer / Sheet / Modal | `z-overlay` | 60 |
  | Action sheet / popover menu | `z-popover` | 70 |
  | Toast | `z-toast` | 80 |
  | Tooltip | `z-tooltip` | 90 |

  (Exact values TBD; the point is a single ordered scale, added to `tailwind.config.ts`, replacing scattered literals.)
- **Soft‑keyboard handling.** `dvh` (§3.1) fixes the shell height but not input occlusion. Rules: focused inputs `scrollIntoView` above the keyboard; autocomplete dropdowns (`ArgsTemplateInput`, skill‑ref picker, `FilterSheet`) flip/clamp to stay visible; the `BottomTabBar` and any `fixed bottom-*` action bar hide while a text input is focused (detect via focus events / `visualViewport` resize) so they don't sit on top of the keyboard.
- **Reduced motion.** All new slide/scale animations (drawer, sheets, backdrop) and existing `animate-pulse` honor `prefers-reduced-motion: reduce` (instant/opacity‑only fallback).
- **Touch ergonomics.** Set `-webkit-tap-highlight-color: transparent` globally; apply `touch-action: manipulation` to remove the 300ms tap delay; use `touch-action: pan-y` on horizontally‑scrollable table wrappers so vertical page scroll still works.
- **Gestures (scope decision).** In scope: swipe‑down‑to‑dismiss on bottom sheets/action sheets. Out of scope for v1 (revisit): pull‑to‑refresh on lists, swipe actions on cards (accept/dismiss). Stated here so it's a decision, not an accident.

### 3.7 Realtime & performance on mobile
Supabase Realtime drives Inbox, cockpit list, run detail, runners, the run drawer, and the sync indicator. None of it is currently mobile‑hardened.

- **Reconnect on resume.** Mobile drops the socket on tab backgrounding, lock‑screen, and Wi‑Fi↔cellular handoff. On `visibilitychange → visible` and `online`, re‑subscribe and refetch the current view. Centralize in a shared `useRealtimeChannel` wrapper rather than per‑component logic.
- **Staleness indicator.** When the socket is disconnected/reconnecting, surface a small "reconnecting… / data may be stale" state (reuse the existing `SyncIndicator` vocabulary) so a phone user isn't fooled by a frozen run view.
- **Cellular cost.** Document that keeping N Realtime channels open on cellular costs battery/data. v1 mitigation: only subscribe for the currently‑visible screen and tear down channels on unmount/background (don't hold cockpit subscriptions alive while the user is on Settings).
- **Long‑list strategy.** No virtualization exists; table→card (P1) makes lists taller. Decision for v1: **cap list length via existing pagination / a "Load more" affordance** rather than introduce virtualization now; flag virtualization as the follow‑up if real lists exceed ~100 cards. (Mobile users expect load‑more over numeric pagination — see P3/§6.2.)
- **Font loading.** `globals.css` loads three Google font families via render‑blocking `@import` — a visible FOIT/perf hit on cellular. Migrate to `next/font` (self‑hosted, `display: swap`, preconnect handled) as part of Foundations, or record as an explicit deferred item.
- **Perf budget.** Target interactive < 3s on a mid‑tier Android over throttled 4G; keep route‑level JS reasonable (the new primitives are shared, not per‑screen copies).

---

## 4. Cross‑cutting patterns (apply everywhere)

### P1 — Wide tables → cards on phone
Default rule: tables with > 4 meaningful columns render as a **stacked card list** below `md`. Each row becomes a card with a title line (primary identifier), a status badge, 2–4 key/value meta lines, and an actions row/kebab. Applies to: Issues, PRs, Cockpit runs, Runners, Team, Actions, Skills.

### P2 — Tables that stay tabular
Where a card view is overkill (e.g., dense numeric tables), keep `<table>` inside `overflow-x-auto` with a visible scroll affordance and sticky first column where it aids comprehension. Must be an explicit, contained scroll — never the whole page.

### P3 — Filters
Search input goes full‑width first row on phone; secondary filters collapse into a `Sheet`/disclosure ("Filters · N") to avoid the `min-w` overflow stacking. Active‑filter chips shown below.

### P4 — Overlays
Drawers → full‑screen/bottom‑sheet on phone via `Sheet`. Modals → `max-h-[85dvh]` scrollable body, full‑width stacked buttons on phone. Portaled row menus → on phone, render as a bottom action sheet instead of a 224px popover anchored to a tiny trigger.

### P5 — Two‑pane detail → stacked/tabbed
List+detail splits (run detail `grid-cols-[minmax(320px,420px)_1fr]`, action/skill detail `lg:grid-cols-[400px_1fr]`) stack vertically on phone. Where both panes are essential and long (run detail: steps + event log), use an in‑page segmented control / tabs ("Steps" / "Log") on phone instead of stacking two scroll regions.

### P6 — Forms
Multi‑column form grids already use `sm:grid-cols-2`; ensure base is 1 column and remove `max-w-md` hard caps in favor of `w-full sm:max-w-md`. Fixed‑height textareas (`min-h-[420px]`) become `min-h-[240px] lg:min-h-[420px]`. Inputs `text-base` on phone (prevents iOS zoom‑on‑focus) → `lg:text-sm`.

### P7 — Hardcoded fixed widths
Replace fixed `w-N` / `min-w-[...]` / `grid-cols-[...px...]` used for layout with responsive equivalents (mobile base + `lg:` restore). Catalogued per screen in §6.

### P8 — Typography
Oversized headers (`text-[28px]`, `text-2xl`) get a mobile base (`text-xl sm:text-2xl lg:text-[28px]`). Tiny text (`text-[9px]`, `text-[10px]`) raised to ≥11px on phone where it carries meaning.

### P9 — Mobile keyboards & input affordances
`inputMode` is currently used once (`run-now-modal.tsx:177`). Every text/number field gets the right soft keyboard: numeric IDs → `inputMode="numeric"`, email → `type="email"`, search → `type="search"` + `enterKeyHint="search"`, free text → appropriate `enterKeyHint` ("done"/"send"). Applies notably to `EnqueueRunButton` issue number, team invite email, and all `FilterBar` search inputs. Pairs with the iOS zoom fix in P6 (`text-base` on phone).

### P10 — Toasts & transient notifications
There is no toast library; Inbox (`inbox-view.tsx:555`) and `SyncIndicator` each hand‑roll a toast with desktop‑oriented fixed positioning. Standardize a single toast container that anchors **above the `BottomTabBar` + safe‑area inset** on phone (so it isn't hidden by the nav) and bottom‑right on desktop, on the `z-toast` layer (§3.6). Consolidate the two existing ad‑hoc toasts onto it.

---

## 5. New components inventory

| Component | Purpose | Notes |
|---|---|---|
| `AppShell` | Responsive shell + mobile nav state | Wraps everything; client |
| `MobileTopBar` | `< lg` top bar w/ hamburger | Shares SyncIndicator/avatar |
| `MobileNavDrawer` | Off‑canvas nav | Reuses `NavItems`, workspace switcher |
| `BottomTabBar` | Phone primary nav (in scope) | Inbox/Issues/PRs/Runs/More |
| `NavItems` | Extracted nav list | Shared sidebar/drawer source of truth |
| `PageContainer` | Standard responsive page padding/width | Replaces ad‑hoc paddings |
| `DataTable` + `DataCardList` | Table↔card responsive list | P1/P2 |
| `FilterBar` + `FilterSheet` | Responsive filters | P3 |
| `Sheet` (responsive drawer/bottom‑sheet) | Overlays | Replaces `RunDrawer` width hack |
| `Modal` | Unified modal primitive | Consolidates 4 modals |
| `ResponsiveTooltip` | Hover‑or‑tap tooltip | Replaces `title=` + hover tooltips |
| `ActionSheet` | Phone replacement for portal row menus | P4; swipe‑to‑dismiss (§3.6) |
| `IconButton` (size tokens) | ≥44px touch targets | Shared |
| `Toaster` / `useToast` | Unified toast, safe‑area aware | P10; replaces 2 ad‑hoc toasts |
| `useScrollLock` (hook) | Lock/restore body scroll for overlays | §3.6 |
| `useFocusTrap` (hook) | Trap + restore focus, Esc/back close | §3.6 |
| `useRealtimeChannel` (hook) | Reconnect on resume/online, teardown on unmount | §3.7 |
| z‑index scale tokens | Documented layer ordering | `tailwind.config.ts`, §3.6 |

---

## 6. Screen‑by‑screen spec

For each screen: **what's added/changed**, the **specific offenders**, and the **components used**.

### 6.0 Global shell — `src/app/layout.tsx`, `sidebar.tsx`, `topbar.tsx`, `nav-link.tsx`
- Add `viewport` export (§3.1).
- Introduce `AppShell` + `MobileTopBar` + `MobileNavDrawer` (§3.3).
- `Sidebar` → `hidden lg:flex`; extract `NavItems`.
- `TopBar` → `hidden lg:flex`; share contents with `MobileTopBar`.
- `nav-link` icon hit area → ≥44px on touch.
- `main` → responsive padding via `PageContainer`; add bottom padding for `BottomTabBar` + safe area.
- **`BottomTabBar` contents (5):** Inbox · Issues · PRs · Runs · **More**. Active state derived from `pathname` (the "More" tab is active for any destination it contains). "More" opens a `Sheet`/`ActionSheet` listing the remaining `NAV` items (Skills, Actions, Workflows, Activity, Settings) plus workspace switcher and sign‑out — the same `NavItems` source as the drawer.
- **SyncIndicator:** needs a compact mobile variant — the full 413‑line desktop indicator (webhook health, progress bar, "what changed") cannot render in the phone topbar. Show a single status dot that opens the full detail in a `Sheet` on tap.
- **Notification bell** (`topbar.tsx:52`) is currently a no‑op (no `onClick`). Decision: either wire it to a real notifications surface or omit it from `MobileTopBar` — do not spend scarce phone topbar width on a dead control.
- **Detail‑page back affordance:** every detail route (run, issue, action, skill) shows a back/up control on `< lg` (there's no sidebar to orient from). Pair with scroll‑position restoration when returning to the originating list.

### 6.1 Inbox — `inbox/inbox-view.tsx`
- **Offenders:** `max-w-[1080px] px-8` (fixed); header stat cards inline (no responsive grid); filter dropdowns `min-w-[180px]`; **row action buttons hover‑reveal** (`group-hover:opacity-100`); fixed bottom bulk‑action bar `fixed inset-x-0 bottom-6` with non‑wrapping buttons; finding rows pack 8+ flex items.
- **Add/Change:**
  - `PageContainer` for padding; stat row → `grid grid-cols-2 sm:flex` or responsive grid.
  - Decision card finding rows: on phone restructure to two lines (skill tag + truncated body on line 1; confidence + actions on line 2); actions **always visible** (not hover) or in a kebab `ActionSheet`.
  - Bulk‑action bar: `flex-wrap`, full‑width buttons on phone, respect safe‑area bottom; keep it above `BottomTabBar`.
  - Filters via `FilterBar`/`FilterSheet`.
  - Checkbox + tap targets ≥44px.

### 6.2 Issues — `issues/issues-view.tsx`, `issue-row-menu.tsx`
- **Offenders:** 8‑col table (`min-w-full`, `px-6` cells, `max-w-[440px]` title, `max-w-[220px]` labels) → ~1200px min width; search `min-w-[220px]`; 5× filter selects `min-w-[7.5rem]`; row‑menu trigger `h-7 w-7` (28px) + 224px portal; pagination `min-w-[2rem]` buttons overflow.
- **Add/Change:**
  - `DataCardList` below `md`: card = run‑status dot + `#num` + title (truncate) + state badge; meta line: priority · labels (chips, wrap) · comments · updated; kebab → `ActionSheet`.
  - Keep `DataTable` (current table) at `md+`.
  - `FilterBar` (search full‑width, selects in sheet).
  - Pagination → compact (Prev / "p N of M" / Next) on phone; full numeric on desktop.
  - Stat cards already responsive — keep.

### 6.3 PRs — `prs/prs-view.tsx`, `pr-row-menu.tsx`
- **Offenders:** 9‑col table (~1400px min), branch cell nested `max-w-[150px]` + `max-w-[90px]`, same filter/menu/pagination issues as Issues.
- **Add/Change:** mirror §6.2. Card meta: author · branch (head→base, truncate) · state checks · labels · updated. `DataCardList` + `FilterBar` + `ActionSheet` + compact pagination.

### 6.4 Cockpit runs list — `cockpit/cockpit-list.tsx`, `cockpit-tabs.tsx`, `cockpit-ui.tsx`, `enqueue-run-button.tsx`
- **Offenders:** `px-8 py-6` fixed; 8‑col table (checkbox, issue/PR, workflow, current step, status, tokens, age, actions); status‑pill filter row + 2 selects; bulk actions `ml-auto` small buttons; `EnqueueRunButton` flex row with `w-20` input + select that truncates.
- **Add/Change:**
  - `DataCardList` below `md`: card = issue/PR title + workflow + status dots + current step + age; checkbox for bulk select; tokens as meta.
  - `cockpit-tabs` horizontal bar → ensure `overflow-x-auto` with no page overflow; tabs scrollable on phone.
  - Bulk actions → wrap, full‑width on phone.
  - `EnqueueRunButton` → stack (select full‑width, then input + button row); or move into a `Modal`/`Sheet` on phone.

### 6.5 Run detail — `cockpit/[runId]/run-detail-shell.tsx`
- **Offenders (CRITICAL):** body is `grid grid-cols-[minmax(320px,420px)_1fr]` — left pane alone exceeds a 375px viewport; `h-screen` shell; jump‑to‑bottom `absolute bottom-4 right-4`; runner chips `text-[10px]`; collapsible step toggles small.
- **Add/Change:**
  - Phone: replace two‑pane grid with a **segmented control / tabs**: "Steps" | "Event log" (P5). Each is a single full‑width scroll region. `lg:grid` restores the split.
  - Use `min-h-dvh`; ensure header wraps (already `flex-wrap`); action buttons wrap, ≥44px.
  - Jump‑to‑bottom button respect safe‑area; ≥44px.
  - Step cards / runner chips: raise `text-[10px]`→`text-xs` on phone; `ResponsiveTooltip` for runner chip detail.

### 6.6 Runners (cockpit) — `cockpit/runners/page.tsx`, `runners-workers-table.tsx`
- **Offenders:** `px-8` fixed; 7‑col table (already `overflow-x-auto`); `text-[10px]` "managed" badge; `title=` latency tooltips (hover‑only); multi‑line utilization cell.
- **Add/Change:** `DataCardList` below `md` (name + status badge; backends chips; heartbeat; utilization; identity; p50/p95). `ResponsiveTooltip` for latency. Raise tiny fonts. Keep `overflow-x-auto` table at `md+`.

### 6.7 Actions list — `actions/actions-view.tsx`, `action-row-menu.tsx`
- **Offenders:** `px-6` fixed; 8‑col table (`overflow-x-auto`, `whitespace-nowrap`); search `min-w-[220px]`; filter selects `min-w-[7.5rem]`; callouts `md:grid-cols-2` (ok).
- **Add/Change:** `DataCardList` below `md` (name + kind + target + status; triggers/effects chips; updated; kebab). `FilterBar`. `action-row-menu` trigger already `h-7 w-7` → raise to ≥44px on touch; on phone use `ActionSheet`.

### 6.8 Action detail — `actions/[name]/action-detail-view.tsx`, `acceptance-section.tsx`
- **Offenders:** two‑pane `lg:grid-cols-[400px_1fr]` (ok — stacks); system‑prompt textarea `min-h-[420px]`; **acceptance `BucketRow` `grid-cols-[200px_1fr_60px]`** (200px label col crushes phone); sliders `grid-cols-3`; dry‑run `md:grid-cols-2` (ok).
- **Add/Change:** textarea `min-h-[240px] lg:min-h-[420px]`. `BucketRow` → stack label above the bar on phone (`grid-cols-1 sm:grid-cols-[200px_1fr_60px]`). Slider label grids → 1‑col base. Ensure left/right panes stack (already `lg:`). Inputs `text-base` on phone.

### 6.9 New action form — `actions/new/new-action-form.tsx`
- **Offenders:** minimal — `max-w-xl`, `w-full` inputs (already good).
- **Add/Change:** `text-base` inputs on phone; button row `flex-wrap`/full‑width on phone; confirm `max-w-xl` reads as `w-full` on phone. Low effort.

### 6.10 Skills list — `skills/skills-view.tsx`
- **Offenders:** mirror of Actions list — 7‑col table, search `min-w-[220px]`, filter selects, good footer hiding (`hidden lg:inline`, `hidden xl:inline`).
- **Add/Change:** `DataCardList` below `md`; `FilterBar`; keep footer hiding pattern. `ActionSheet` for row menu on phone.

### 6.11 Skill detail — `skills/[name]/skill-detail-view.tsx`
- **Offenders:** two‑pane `lg:grid-cols-[360px_1fr]` (ok); instruction textarea `min-h-[420px]`; capabilities `grid-cols-2` tight (~165px cols); dry‑run `md:grid-cols-2` (ok).
- **Add/Change:** textarea `min-h-[240px] lg:min-h-[420px]`; capabilities `grid-cols-1 sm:grid-cols-2`; footer buttons `flex-wrap`. Inputs `text-base`.

### 6.12 Workflows — `workflows/workflows-client.tsx`, `flow-card.tsx`
- **Offenders (CRITICAL — most broken):** step grid `grid-cols-[auto_minmax(220px,1fr)_minmax(220px,2fr)_auto_auto]` (both header `:158` and `StepRow :355`) far exceeds phone width; trigger label input `w-32`; preview inputs `w-20`/`w-12`; `px-8` page.
- **Add/Change:**
  - Step editor: on phone, **stack each step as a vertical card** (label → skill picker (full‑width) → args template (full‑width) → action buttons row), restoring the 5‑col grid at `lg:`. This is the largest single‑screen refactor.
  - `ArgsTemplateInput` autocomplete dropdown `w-full` (ok) — ensure it doesn't overflow; reposition near input.
  - Trigger label input `w-32` → `w-full sm:w-32`. Preview number inputs keep small fixed widths (ok for numbers) but ensure rows `flex-wrap`.
  - `RunOnIssue` row → wrap; button full‑width on phone.

### 6.13 Settings (tabs + sections) — `settings/page.tsx`, `settings-tabs.tsx`, `settings-form.tsx`, `automation-section.tsx`, `labels-section.tsx`, `team-section.tsx`
- **Offenders:** page `max-w-[1080px] px-8`; tab bar `flex-wrap` 5 tabs (will wrap to multiple lines, no scroll); `SettingsCard px-6` padding; settings‑form preset `min-w-[18rem]`, select `max-w-md`; **Team:** invite email `min-w-[220px]`, table `min-w-full` + `px-4` cells, role select `h-8`, delete `h-7 w-7`; labels status `grid-cols-2 gap-x-6`.
- **Add/Change:**
  - `PageContainer` (drop the desktop‑only `max-w-[1080px] px-8` on phone).
  - Tab bar → horizontally scrollable (`overflow-x-auto` segmented control) instead of wrapping; or a select on phone (decision §10 Q3).
  - `SettingsCard` responsive padding (`p-4 lg:px-6`).
  - settings‑form: preset `min-w-[18rem]`→`w-full sm:min-w-[18rem]`; select `max-w-md`→`w-full sm:max-w-md`. Grids already `sm:grid-cols-2` — keep.
  - Team: invite form → stacked full‑width on phone (`w-full`); member table → `DataCardList` below `md` (avatar + name + role select + remove); delete/role targets ≥44px.
  - Labels status grid → `grid-cols-1 sm:grid-cols-2`.

### 6.14 Settings → Runners — `settings/runners/page.tsx`, `runners-section.tsx`
- **Offenders:** `max-w-[1080px] px-8`; `h1 text-[28px]`; register name `max-w-md`; runner row right‑aligned `text-right` heartbeat overlaps on phone; `CopyBox` row wraps; `pre overflow-x-auto` (ok).
- **Add/Change:** `PageContainer`; header `text-xl sm:text-[28px]`; name `w-full sm:max-w-md`; runner row → stack metadata under name on phone (no float‑right); CopyBox full‑width, copy button ≥44px.

### 6.15 Login — `login/page.tsx`
- **Offenders:** none significant — `max-w-sm`, `w-full`, full‑width button.
- **Add/Change:** verify with viewport meta added; `min-h-dvh`; safe‑area. Otherwise no change.

### 6.16 Create workspace wizard — `workspaces/new/wizard.tsx`
- **Offenders:** page `max-w-[920px] px-8`; `h1 text-[28px]`; step forms `max-w-md` / `max-w-2xl`; `StepIndicator` horizontal `flex` (wraps); embeds `LabelListEditor`.
- **Add/Change:** `PageContainer`; header responsive size; forms `w-full sm:max-w-md`; `StepIndicator` horizontally scrollable on phone (or compact "Step 2 of 4"); buttons full‑width on phone.

### 6.17 Activity — `activity/page.tsx`
- **Offenders:** `px-8`; timeline item timestamp `w-16` (64px) eats the row on phone; `h1 text-2xl`.
- **Add/Change:** `PageContainer`; timeline → on phone put timestamp on its own muted line above/below the message (drop the fixed `w-16` left rail) or `w-12 sm:w-16`; header responsive size.

### 6.18 Analytics — `analytics/page.tsx`
- **Offenders:** `px-8`; charts already `lg:grid-cols-2`; `HBar` label `w-24` (96px) overflows; `VelocityChart` labels `text-[9px]`; cost list `justify-between`.
- **Add/Change:** `PageContainer`; `HBar` label `w-20 sm:w-24` or stack label above bar on phone; bar labels `text-[10px] sm:text-[9px]` (raise min legibility); ensure chart containers don't force min width. Keep `lg:grid-cols-2`.

### 6.19 Redirects — `page.tsx`, `dashboard/page.tsx`
- No layout; no change.

---

## 7. Overlay & menu specifics

- **`run-drawer.tsx`:** replace `w-[420px]` with the `Sheet` primitive → full‑screen (or bottom‑sheet) on phone, `lg:w-[420px]` side‑drawer on desktop. Log timestamp `w-10` ok. Close button ≥44px.
- **`row-menu-portal.tsx`:** keep the 224px popover on `pointer:fine`/desktop; on phone (`pointer:coarse`) render an `ActionSheet` (bottom sheet) instead, since a 224px popover anchored to a 28px trigger is fiddly and the portal clamps against `window.innerWidth` (375) not the content column.
- **`run-status-dots.tsx`:** tooltip `min-w-[260px]` → `max-w-[min(320px,calc(100vw-16px))]`; convert hover to `ResponsiveTooltip` (tap‑to‑open on touch). Dots themselves ≥ adequate tap size or grouped into a tappable summary.
- **Modals (4 files):** consolidate into `Modal`; body `overflow-y-auto max-h-[85dvh]`; footer buttons full‑width stacked on phone (`flex-col sm:flex-row sm:justify-end`); already `p-4 w-full max-w-md/lg` — keep.

---

## 8. Testing & acceptance criteria

### Viewport matrix
- Phones: **360 (support floor)**, 375, 390, 414 px portrait; 667–844 landscape. 320px is best‑effort (must not be broken/unusable, but minor compromise allowed).
- Tablets: 768, 820, 1024 px — and **explicitly the 768–1024 seam** (mobile nav + desktop table, §3.2).
- Desktop: ≥1280 (regression — must be visually unchanged).

### Browser / OS floor
- iOS Safari **16.4+** (required for `dvh`; `env(safe-area-inset)` ≥ 11.2). Chrome Android current − 2.
- State any older‑Safari fallback for `dvh` (e.g. `min-h-screen` fallback before `min-h-dvh`).

### Acceptance (per screen)
1. No horizontal **page** scroll at any width ≥360px (contained `overflow-x-auto` on a specific table/code block is allowed and visually indicated). **Verified with `overflow-x-hidden` temporarily disabled** so the shell isn't masking a real overflow bug.
2. Primary actions reachable by tap without hover; all interactive targets ≥44×44px on touch.
3. Nav reachable on phone via bottom tab bar + hamburger drawer — every `NAV` destination present (incl. via "More").
4. No text smaller than 11px conveying meaning; headers legible. Layout holds at browser font‑scaling 200% / OS large‑text.
5. Inputs do not trigger iOS zoom on focus (≥16px / `text-base`); correct soft keyboard per field (P9); focused input not hidden by the keyboard (§3.6).
6. Overlays (drawer, modals, sheets, action sheets, tooltips) fully on‑screen, scrollable, dismissible (backdrop tap + Esc/Android‑back), **lock background scroll, trap focus, and restore focus on close** (§3.6).
7. Safe‑area insets respected on notched devices (no content under the notch/home indicator); toasts sit above the bottom bar (P10).
8. Realtime views recover after backgrounding / network change and show a stale/reconnecting state while down (§3.7).
9. `prefers-reduced-motion` honored by all overlay animations.
10. Desktop (`lg+`) layout pixel‑equivalent to today (visual regression).

### Conditions to test under (not just narrow viewport)
- **Real touch input** (not only DevTools narrow emulation) — confirms 44px targets, tap delay, hover‑only regressions.
- **Throttled network** (4G/3G) and **CPU throttling** (mid‑tier Android) for the perf budget (§3.7).
- **Screen readers:** VoiceOver (iOS) + TalkBack (Android) over the nav drawer, bottom sheet, action sheet, and a card list — roles, focus order, dialog semantics.

### Tooling & test‑suite impact
- Manual: Chrome/Safari device emulation + at least one real iOS + one real Android device.
- Automated: Playwright viewport snapshots for the matrix on each screen; axe checks for touch‑target/contrast.
- **Existing tests:** table→card DOM changes will break selector‑based tests. Audit and repair the current GUI test suite as part of each screen's migration (don't only add new tests).

---

## 9. Phased rollout

| Phase | Deliverable | Unblocks |
|---|---|---|
| **0. Foundations** | Viewport/theme meta + `dvh` fallback, z‑index scale tokens, breakpoint doc, `useScrollLock`/`useFocusTrap` hooks, `AppShell`+`MobileTopBar`+`MobileNavDrawer`+`BottomTabBar` (incl. "More"), `PageContainer`, touch‑target tokens, `next/font` migration. **Behind a `mobileShell` feature flag.** | Everything; makes the app navigable on phone immediately |
| **1. Primitives** | `Sheet`, `Modal`, `FilterBar`/`FilterSheet`, `DataTable`/`DataCardList`, `ResponsiveTooltip`, `ActionSheet`, `Toaster`/`useToast`, `useRealtimeChannel` (reconnect/teardown) | Phases 2–4 |
| **2. List screens** | Inbox, Issues, PRs, Cockpit runs, Runners, Actions, Skills (cards + filters + menus); repair affected tests | Highest‑traffic screens |
| **3. Detail/overlays** | Run detail (tabs), `RunDrawer`, status‑dots tooltip, Action/Skill detail, modals; detail back‑nav | |
| **4. Forms/config** | Workflows step editor (big), Settings + tabs, Team, Runners section, Wizard, New‑action form; keyboard/inputmode pass (P9) | |
| **5. Dashboards** | Activity, Analytics | |
| **6. Polish/QA** | Viewport+seam matrix, real‑device + screen‑reader QA, throttled‑network perf, visual regression, safe‑area, landscape, reduced‑motion; remove flag | Ship |

Each phase is independently shippable; Phase 0 alone makes the app navigable on mobile even before screens are polished. The whole effort ships **behind a `mobileShell` flag** so the shell rewrite (which touches `layout.tsx` and therefore every screen) can be dog‑fooded and rolled back without affecting desktop users; the flag is removed in Phase 6.

---

## 10. Resolved decisions

1. **Sidebar → mobile‑nav switch: `lg` (1024px).** Desktop (`lg+`) keeps the 260px sidebar; tablets and phones (`< lg`) get the mobile nav (`MobileTopBar` hamburger + `MobileNavDrawer`). This is the breakpoint used throughout §3.3 and §6.
2. **Phone primary nav: bottom tab bar + hamburger.** `BottomTabBar` (§3.3) is **in scope** (not optional): 5 thumb‑reachable destinations — **Inbox, Issues, PRs, Runs, More** — with "More" and the hamburger drawer holding the full nav list, workspace switcher, user block, and sign‑out. The bottom bar shows `< sm`; on `sm–lg` (tablet) the hamburger drawer alone is sufficient. Content panes add bottom padding = bottom‑bar height + safe area when the bar is present.
3. **Tables on phone: convert to stacked cards.** All 6 entity tables (Issues, PRs, Cockpit runs, Runners, Team, Actions/Skills) use `DataCardList` below `md` (pattern P1). Dense numeric tables that aren't entity lists may still use contained horizontal scroll (P2).
4. **Minimum supported width: 360px.** Layouts must be clean and scroll‑free at ≥360px; 320px is best‑effort, not a hard requirement.
5. **Gestures v1:** swipe‑to‑dismiss on bottom/action sheets only. Pull‑to‑refresh and card swipe‑actions are deferred (§3.6).
6. **Long lists v1:** pagination / "Load more", not virtualization (revisit if lists exceed ~100 cards) (§3.7).
7. **Ship behind a `mobileShell` feature flag**, removed in Phase 6 (§9).

### Still to confirm (lower stakes, can decide during build)
- **Settings tabs on phone:** horizontally scrollable segmented control (spec default, §6.13) vs `<select>` vs accordion.
- **PWA / installability** later? If yes, add manifest + icons now while touching meta tags (§3.1).
- **Notification bell:** wire to a real surface, or drop it (§6.0) — depends on whether a notifications feature is planned.
- **`next/font` migration:** in Foundations (recommended) vs deferred non‑goal (§3.7).

### Cross‑functional / process (owners needed)
- **Design sign‑off:** this is an engineering spec with no mockups. The card layouts (per entity), bottom sheet, nav drawer, and bottom tab bar need visual design + sign‑off before Phase 2.
- **Post‑launch telemetry:** add basic analytics on mobile usage (viewport class, which screens get mobile traffic, nav pattern used) to validate the investment and prioritize follow‑ups.

---

## 11. Effort signal (rough, relative)

- **Foundations + primitives (Phases 0–1):** largest net‑new component work; unblocks all.
- **High‑effort screens:** Workflows step editor (§6.12), Run detail tabs (§6.5), the 6 table→card conversions.
- **Medium:** Settings/Team/Runners, Inbox card restructure, filters.
- **Low:** Login, New‑action form, redirects, Activity/Analytics tweaks, detail‑view textareas.
