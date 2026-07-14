# OpenCode Web/Desktop UI — Research Findings

**Repo:** `github.com/sst/opencode` now redirects to **`github.com/anomalyco/opencode`**, default branch **`dev`** (v1.17.x at time of research, 2026-07). All paths below are relative to that repo.

## 1. Package topology (what renders what)

| Package | Role |
|---|---|
| `packages/app` | The full client app (routes, layout, session page, composer, timeline). Vite + SolidJS. Shared by desktop and served web app. |
| `packages/desktop` | Electron shell (electron-vite, electron-builder, `@lydell/node-pty` for terminals, electron-updater). Renders `@opencode-ai/app`. |
| `packages/ui` | Design system: ~40 primitives (button, dialog, collapsible, tabs, toast, tooltip…), theme engine, icon spritesheets, fonts, markdown/marked context. Published npm package. |
| `packages/session-ui` | Session-thread components: message parts, tool cards, markdown streaming pipeline, diff/file viewers (Pierre integration), session review. |
| `packages/web` | Astro site (docs via Starlight + landing + **share pages** `/s/[id]`), deployed to Cloudflare. Solid islands. |
| `packages/tui` | Terminal UI (Go) — shares theme *names* with the web themes but not code. |
| `packages/storybook` | Storybook for `ui`/`session-ui`; components carry co-located `*.stories.tsx`. |

## 2. Tech stack (web/desktop app)

- **Framework: SolidJS** (not React) + `@solidjs/router`, `@solidjs/meta`. Fine-grained reactivity is load-bearing for their streaming rendering, but every pattern below has a React translation.
- **Headless components: Kobalte** (`@kobalte/core`) — the Solid equivalent of Radix. Same role shadcn's Radix layer plays.
- **Styling: Tailwind CSS v4** (`@tailwindcss/vite`, CSS-first `@theme` config in `packages/ui/src/styles/tailwind/index.css` — resets all defaults with `--*: initial` and maps Tailwind tokens onto their own CSS variables) **plus one co-located `.css` file per component** (`button.tsx` + `button.css`), imported through CSS `@layer theme, base, components, utilities` in `packages/ui/src/styles/index.css`.
- **Component conventions:** every component stamps `data-component="…"` and `data-slot="…"` attributes; the CSS targets those attributes rather than classes. State is expressed as data attributes (`data-collapsed`, `data-state`, `data-hide-details`). This is exactly shadcn-v4-compatible styling discipline.
- **Motion:** `motion` (Motion One / framer-motion successor, DOM API — framework agnostic) for spring height animations; bespoke micro-interaction components: `text-shimmer` (active tool title), `text-reveal`, `text-strikethrough` (todo completion), `animated-number` (odometer counters), `typewriter`, `motion-spring` hook.
- **Data/state:** `@tanstack/solid-query`, WebSocket-driven sync contexts (`app/src/context/global-sync/*` with event reducer + session cache + eviction), `solid-primitives` utilities everywhere.
- **Virtual list:** `@tanstack/solid-virtual`.
- **DnD:** `@dnd-kit` (tabs, sortable sessions).
- **Terminal:** `ghostty-web` (WASM Ghostty) in the app, node-pty in Electron main.
- **Fonts:** Inter (sans) + JetBrains Mono Nerd Font (mono) — `packages/ui/src/assets/fonts/`.
- **i18n:** `@solid-primitives/i18n`, all strings through `useI18n()/language.t()`.
- **Testing:** bun test + happy-dom for units, Playwright e2e incl. dedicated *timeline visual-stability* perf suites (`packages/app/e2e/performance/`).

## 3. Message thread

Files: `packages/app/src/pages/session/timeline/*`, `packages/session-ui/src/components/session-turn.tsx`, `message-part.tsx`.

- **Turn model:** the thread is a list of "turns" (user message + assistant response group) — `session-turn.tsx`. Turn headers use `StickyAccordionHeader`; each turn shows aggregated `DiffChanges` (+N/-N) and retry affordance (`session-retry.tsx`).
- **Virtualization:** `timeline/message-timeline.tsx` (~76 KB) wraps `createVirtualizer` from `@tanstack/solid-virtual` with heavy customization:
  - per-session **measurement cache** (`timelineCache: Map<sessionKey, {measurements, toolOpen}>`) so revisiting a session restores scroll instantly, including which tool cards were open;
  - custom `scrollToFn` that pre-sets the spacer height before scrolling;
  - `shouldAdjustScrollPositionOnItemSizeChange` override for bottom-anchored streaming (content grows without viewport jumping);
  - `scrollEndThreshold: 80` + auto-scroll-to-end hook (`ui/src/hooks/create-auto-scroll.tsx`).
- **Part grouping** (`message-part.tsx` `groupParts()`): consecutive `read`/`glob`/`grep`/`list` tool calls are collapsed into one **"context group"** row (`ContextToolGroup` + `tool-count-summary.tsx`) — e.g. "Read 4 files, 2 searches" — expandable to individual entries. `todowrite` parts are **hidden entirely from the thread** (`HIDDEN_TOOLS`); todos render in a dock instead (see §6).
- **Paced text streaming** (`PacedMarkdown`, message-part.tsx:249-340): streamed text is revealed at a 24 ms cadence in adaptive chunks (2→256 chars based on backlog), snapping chunk boundaries to whitespace/punctuation (`TEXT_RENDER_SNAP`), and flushing immediately when backlog ≤ 512 chars or when streaming ends. Gives a smooth typewriter feel without falling behind.

## 4. Tool-call parts (collapsed summary → expandable detail)

File: `packages/session-ui/src/components/basic-tool.tsx` (+ `basic-tool.css`, v2 variant in `src/v2/components/basic-tool-v2.tsx`).

- **`BasicTool`** is the universal chrome: `Collapsible` (Kobalte) with a structured trigger `{ icon, title, subtitle, args[], action }`. Examples from `getToolInfo()` (message-part.tsx:468-566): bash → icon `console`, title "Shell", subtitle = command; edit/write → filename; task → agent name + description; websearch → provider-labeled title + query; unknown/MCP tools → generic fallback with heuristic label extraction (first of `description|query|url|filePath|path|pattern|name`) and up to 3 `key=value` args.
- **Running state:** `TextShimmer` animates the title while `status ∈ {pending, running}`; expansion is disabled until done; `Collapsible.Arrow` only shows when there's detail.
- **Deferred mounting** (`defer` prop): heavy collapsed bodies are mounted through a global `requestAnimationFrame` queue that **pops from the end** — bodies nearest the viewport bottom (latest turn) become interactive first (basic-tool.tsx:47-78). Big win for long sessions.
- **Animated expansion:** spring height animation via `motion`'s `animate(el, {height})` with `{visualDuration: 0.35, bounce: 0}`.
- **Default-open policy:** `partDefaultOpen()` — edit/write/apply_patch and bash respect user settings ("expand edits", "expand shell"); everything else defaults closed.
- **Errors:** dedicated `tool-error-card.tsx` with error unwrapping (parses JSON out of error strings — session-turn.tsx `unwrap()`).
- Per-file tool output wrapped in `ToolFileAccordion` (path header + actions).

## 5. Diffs — the diff renderer is **`@pierre/diffs`**

Files: `packages/session-ui/src/pierre/*`, `packages/session-ui/src/components/file.tsx`, `session-diff.ts`.

- **`@pierre/diffs`** (npm, from Pierre / pierre.co — framework-agnostic, ships React bindings too) renders both diffs (`FileDiff`, `VirtualizedFileDiff`) and plain file views (`File`, `VirtualizedFile`) inside **shadow DOM** hosts.
- Default options (`pierre/index.ts:153-171`): `diffStyle: "unified"` (split available), `lineDiffType: "word-alt"` for split view, `expansionLineCount: 20` (click-to-expand context), `hunkSeparators: "line-info-basic"`, `diffIndicators: "bars"`, `overflow: "wrap"`, custom `unsafeCSS` injected into the shadow root that re-maps all `--diffs-*` variables to their theme tokens (`color-mix` of theme diff colors with background).
- **Syntax highlighting inside diffs uses the same Shiki "OpenCode" CSS-variable theme** (`theme: "OpenCode"`), run in a **worker pool** (`pierre/worker.ts`, `ui/src/context/worker-pool.tsx`).
- **Virtualization for big files:** files > 500 KB switch to `VirtualizedFileDiff` (`file.tsx: VIRTUALIZE_BYTES = 500_000`), shared `Virtualizer` instances acquired per scroll container (`pierre/virtualizer.ts`).
- **SSR preload** supported (`@pierre/diffs/ssr` `PreloadFileDiffResult`).
- **Line comments/review:** line-number selection bridge across shadow DOM (`pierre/selection-bridge.ts`, `diff-selection.ts`), commented-line highlighting, `line-comment.tsx` annotation cards, find-in-file with CSS Custom Highlight API (`::highlight(opencode-find)`).
- **Review tab** ("Session Review"): `session-ui/src/components/session-review.tsx` + v2 `session-review-v2.tsx` — accordion of changed files with sticky headers, per-file `DiffChanges`, empty states (`session-review-empty-*`).
- **`DiffChanges` stat component** (`ui/src/components/diff-changes.tsx`): `+N/-N` text variant and a GitHub-style **5-block "bars" variant** with careful proportional allocation (caps small changes at 1-2 bars).
- The **share page** uses a totally separate lightweight diff: `web/src/components/share/content-diff.tsx` parses unified patches with **jsdiff `parsePatch`** and builds a hand-rolled split view (pairing removals/additions into modified rows), highlighting each side with Shiki.

## 6. Todo / plan lists

File: `packages/app/src/pages/session/composer/session-todo-dock.tsx`.

- Todos live in a **dock pinned above the composer** (`DockTray` from `ui/dock-surface`), *not* in the message thread (`todowrite` is a hidden tool).
- Collapsed state: "N/M" progress with **`AnimatedNumber`** odometer + `TextReveal` of the currently active todo (in_progress → first pending → last completed fallback).
- Expanded: scrollable checklist (max-height 10.5rem) of `Checkbox` rows — `indeterminate` + pulsing dot for `in_progress`, `TextStrikethrough` animation on completion, muted color for done/cancelled, top scroll-fade gradient.
- Companion docks in the same composer region: `session-permission-dock.tsx` (approval prompts), `session-question-dock.tsx`, `session-revert-dock.tsx`, `session-followup-dock.tsx` — the composer is a stack of contextual trays.

## 7. Session list / sidebar

Files: `packages/app/src/pages/layout.tsx` (~2400 lines), `layout/sidebar-*.tsx`, `layout/sidebar-items.tsx`.

- Left sidebar: **projects → workspaces → sessions** hierarchy, resizable (min 244 px, max 30 vw + 64 px), collapsible to a 4 rem icon rail with hover fly-out panels.
- `SessionRow` (sidebar-items.tsx:92): truncated title + one status glyph: `Spinner` while working, **warning dot** when permission is pending, **red dot** on error, **blue dot** for unseen activity. Skeleton rows while loading (`SessionSkeleton`).
- Sessions are DnD-sortable; tabs across the titlebar (`titlebar-tab-strip.tsx`, `@dnd-kit`) with closed-tab memory (`context/closed-tabs.ts`).
- Home (`pages/home.tsx`) has session archive/open logic; command palette (`dialog-command-palette-v2.tsx`) with `fuzzysort`.

## 8. Mobile layout / responsiveness

- Standard Tailwind v4 breakpoints (sm 40rem … 5xl 144rem) + **container queries** (`@container` on the sidebar nav).
- Below `xl` the sidebar becomes an **overlay drawer**: fixed, `max-w-[400px]`, slide-in via `translate-x` + backdrop click-to-dismiss, controlled by `layout.mobileSidebar` store (layout.tsx:2309-2333). Same `sidebarContent(mobile)` render function used for both variants — the `mobile` prop switches panel behavior (full-width, no hover fly-outs).
- Right-side panels use **`@corvu/drawer`** (touch-draggable drawer with `openPercentage`-driven backdrop blur, styled after solid-ui's drawer) — `app/src/components/ui/drawer.tsx`.
- `createMediaQuery` from `@solid-primitives/media` for JS-level responsive switches (e.g. `file.tsx` diff options).
- Panel widths persisted per session (`session-panel-width.ts`); resize handles via `ui/resize-handle`.

## 9. Theming system (terminal themes → web)

Files: `packages/ui/src/theme/*` — the crown jewel.

- **37 theme JSONs** (`theme/themes/*.json`: tokyonight, gruvbox, catppuccin ×3, dracula, nord, rosepine, one-dark, vesper, flexoki, matrix, synthwave84, vercel, cursor, …) matching the TUI theme names. Each theme is tiny: per light/dark variant either **9 seed colors** (`seeds`) or a palette (`palette`: neutral, ink, primary, accent, success, warning, error, info, diffAdd, diffDelete) plus optional token `overrides` (see `themes/opencode.json` — overrides ~25 syntax/markdown tokens).
- **`resolve.ts` generates everything else algorithmically**: OKLCH scale generation (`generateScale`, `generateNeutralScale`), hue-shifted derived ramps (amber, blue, diff colors), WCAG-luminance-based on-color picking, alpha surface blending → hundreds of semantic tokens (`background-*`, `surface-*`, `text-*`, `border-*`, `icon-*`, `syntax-*`, `markdown-*`, `diff-*`, avatar tones). A v2 token layer (`theme/v2/`) maps onto the newer design system.
- **Delivery:** `theme/context.tsx` — tokens are serialized to CSS custom properties and injected as a single `<style id="oc-theme">` `:root {}` block. `data-theme` + `data-color-scheme` stamped on `<html>`; `color-scheme` set; generated CSS **cached in localStorage** so a preload script can apply the theme before hydration (no flash); theme JSONs lazy-loaded via `import.meta.glob`; live **preview/commit/cancel** API for the theme picker; cross-tab sync via the `storage` event; system scheme tracking via `matchMedia`.
- Fun detail: `--text-mix-blend-mode: plus-lighter|multiply` flips per mode for layered text effects.

## 10. Syntax highlighting — Shiki, one CSS-variable theme

- **The single most copyable pattern:** `packages/ui/src/context/marked.tsx` defines `OpenCodeTheme` — a TextMate theme whose *every color is a CSS variable* (`foreground: "var(--syntax-keyword)"` etc.), registered as Shiki custom theme `"OpenCode"`. Highlight once → recolors instantly across all 37 themes and light/dark with **zero re-highlighting**. The same theme drives markdown code blocks, Pierre diffs, and file views.
- Markdown pipeline: `marked` + custom KaTeX extension (inline `\(...\)`, block `$$`) + `marked-shiki` + a code-span boundary fix (`marked-code-span.ts`); `dompurify` sanitization; optional **native (Rust/host) markdown parser** injection with post-pass math + highlight.
- Share pages (Astro) use plain `shiki codeToHtml` with dual themes `github-light`/`github-dark`.

### Streaming markdown (worth copying wholesale)
Files: `session-ui/src/components/markdown-stream.ts`, `markdown.tsx`, `markdown-shiki.worker.ts`, `markdown-worker-*.ts`.

1. **Block projection** (`markdown-stream.ts`): streamed text is lexed with `marked.lexer`; all tokens before the tail are emitted as stable `full` blocks (rendered once, cached by hash — `markdown-cache.tsx`); the tail is a `live` block healed with **`remend`** (auto-closes unfinished bold/links/fences) or a `code` block fed incrementally.
2. **Worker highlighting** (`markdown-shiki.worker.ts`): `ShikiStreamTokenizer` from **`@shikijs/stream`** tokenizes incrementally off-main-thread, returning `stable`/`unstable` token runs; a latest-wins queue supersedes stale requests; languages lazy-loaded.
3. **DOM patching:** `morphdom` diff-patches rendered HTML in place; code blocks are updated token-by-token (only re-append spans after the longest stable prefix — `markdown.tsx:600-670`), each token a `<span style="color: var(--syntax-…)">`.

## 11. Share / session-replay pages

Files: `packages/web/src/pages/s/[id].astro`, `packages/web/src/components/Share.tsx`, `share/part.tsx`, `share/content-*.tsx`.

- Astro + Solid island, deployed on Cloudflare. Session data loaded server-side for OG/meta, then hydrated.
- **Live replay:** WebSocket to `wss://api…/share_poll?id=…` streams message/part upserts into a Solid store (`reconcile`), with auto-reconnect and status pill (connecting/connected/reconnecting/error). Shared sessions update **live** while the agent runs.
- Rendering is a *separate, lighter* component set (CSS modules, not the ui package): `share/part.tsx` switches on part type; per-part anchor links (`#msg-idx`), copy buttons, footer with cost/tokens/model + provider icon, sticky "scroll to bottom" FAB with IntersectionObserver sentinel.
- Content renderers: `content-markdown` (marked), `content-code` (Shiki dual github themes), `content-diff` (jsdiff parsePatch → custom split view), `content-bash` (terminal-styled), `content-error`. Tool cards are `<details>`-style expandables with min-duration display (only show durations ≥ 2 s).

## 12. Patterns worth copying into a React+shadcn cockpit

1. **CSS-variable Shiki theme** — define one TextMate theme pointing at `--syntax-*` vars; theme switching never re-highlights. Trivial in React (shiki is framework-agnostic).
2. **Seed-based theme engine** — themes as ~9 seed colors + OKLCH scale generation → semantic tokens as CSS vars; localStorage-cached generated CSS for flash-free load; `data-theme`/`data-color-scheme` on root. Maps cleanly onto shadcn's CSS-variable convention.
3. **`@pierre/diffs`** as the diff renderer — production-grade unified/split, word-level diffs, context expansion, virtualization, shadow-DOM theming via CSS vars, worker highlighting, SSR preload. Works with React.
4. **Structured tool-card trigger** — `{icon, title, subtitle, args[], action}` contract + shimmer-while-running + locked-until-complete + generic MCP fallback (label from `description|query|url|filePath|path|pattern|name`). shadcn `Collapsible` equivalent is direct.
5. **Context grouping** — collapse consecutive read/grep/glob/list calls into one "investigated N files" row; hide `todowrite` from the thread.
6. **Todo dock above the composer** (not in-thread): N/M odometer + active-item preview when collapsed; animated strikethrough checklist when expanded. Composer as a stack of contextual docks (todos, permissions, questions, revert).
7. **Streaming text pacing** — 24 ms adaptive chunk reveal with punctuation snapping and ≤512-char immediate flush.
8. **Streaming markdown**: stable-block caching + `remend` healing of the live tail + `@shikijs/stream` in a worker + morphdom patching. (React alternative: keep their block-projection/worker design, render stable blocks memoized.)
9. **Virtualized timeline** with per-session measurement cache, bottom-anchored growth (`shouldAdjustScrollPositionOnItemSizeChange`), and open-state persistence (`@tanstack/react-virtual` supports all the same hooks).
10. **Deferred mount queue** popping from the *bottom* so newest content becomes interactive first.
11. **`data-component`/`data-slot` attribute styling** and per-component CSS files layered with Tailwind v4 `@layer` — matches shadcn v4 idiom.
12. **Session rows with a single status glyph** (spinner / permission dot / error dot / unseen dot) instead of badges.
13. **Share page as a separate lightweight surface** with WebSocket live replay, per-part anchors, and its own minimal renderers — don't ship the whole cockpit bundle to viewers.
14. **DiffChanges 5-bar magnitude glyph** for compact change stats.

## Key file index

- Tool cards: `packages/session-ui/src/components/basic-tool.tsx`, `tool-count-summary.tsx`, `tool-error-card.tsx`
- Part routing/grouping: `packages/session-ui/src/components/message-part.tsx` (PART_MAPPING, getToolInfo, groupParts, PacedMarkdown)
- Turns: `packages/session-ui/src/components/session-turn.tsx`
- Timeline: `packages/app/src/pages/session/timeline/message-timeline.tsx`
- Streaming markdown: `packages/session-ui/src/components/markdown-stream.ts`, `markdown.tsx`, `markdown-shiki.worker.ts`
- Marked + CSS-var Shiki theme: `packages/ui/src/context/marked.tsx`
- Diffs: `packages/session-ui/src/pierre/index.ts`, `packages/session-ui/src/components/file.tsx`, `packages/ui/src/components/diff-changes.tsx`
- Theme engine: `packages/ui/src/theme/{types,resolve,context,loader}.ts(x)`, `theme/themes/*.json`
- Todo dock: `packages/app/src/pages/session/composer/session-todo-dock.tsx`
- Layout/sidebar/mobile: `packages/app/src/pages/layout.tsx`, `layout/sidebar-items.tsx`, `components/ui/drawer.tsx`
- Share: `packages/web/src/pages/s/[id].astro`, `packages/web/src/components/Share.tsx`, `share/part.tsx`, `share/content-diff.tsx`
