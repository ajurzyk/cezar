# Checkpoint 2 — Steps 2.1..2.4 (Phase 2: Shell)

- Commits covered: `d4ebaeb`..`807805e`
- Touched areas: `web/app/src` (routes, theme, shell, drawer), `src/server/{server,static-ui}.ts` (SPA catch-all)

## Validation

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run typecheck:web` | **PASS** |
| `npm test` | **PASS** — 246/246 (13+ files) |
| `npm run build` (tsc + vite) | **PASS** |
| `npm run build:web` | **PASS** |

## UI verification — agent-browser provider

`npm run test:e2e` → **PASS, 14/14** against a freshly booted env (`CEZ_DRY_RUN=1`).

| Scenario | Result |
|---|---|
| Shell renders: brand, nav, ⌘N, footer toggle; exactly one active nav item across 3 routes | PASS |
| `shellHeight === innerHeight`, `body overflow hidden`, sidebar width 264 | PASS |
| iPhone 390×844 skeleton; menu target ≥44px; no horizontal overflow | PASS |
| Drawer: opens, screenshots, tap nav → navigates AND closes | PASS |
| `/?legacy=1` still serves the legacy cockpit | PASS |
| Deep links (`/tasks/x/changes`, `/settings/skills`, 404) cold-load the shell; `/api/*` still JSON | PASS (live-server curl, Step 2.1) |

Artifacts: `checkpoint-2-artifacts/screenshot-{shell-dark,shell-light,shell-iphone,drawer-iphone}.png` — inspected; the shell matches the mockup's sidebar (spacing, 34px nav rhythm, weights).

## Real defects caught this window (all fixed in-window)

1. **`NavLink` computed the wrong active state in both directions** — it lit Settings on `/settings/skills` and failed to light Tasks on `/tasks/:id` (which the spec requires). Replaced with a pure, segment-aware longest-prefix `activeNavPath` resolver (so `/git` cannot claim `/github`), table-tested.
2. **Drawer focus restore was broken** — Radix restores focus to its `DialogTrigger`; the menu button only flipped state, so focus fell to `<body>` on every close. Fixed by making it a real `SheetTrigger`.
3. **`aria-modal` does not exist on Radix dialogs** — it marks outside content `aria-hidden` (`hideOthers`) instead, which is stronger. The test now asserts real modality rather than a phantom attribute.
4. **Grid row collapse** — `md:hidden` on the mobile bar removed its box and promoted the scroller into the `auto` row; fixed with explicit `row-start-*` placement.
5. **jsdom ships no `window.matchMedia`** — `vi.spyOn` fails on it; must use `vi.stubGlobal`. (Recorded for future steps.)

## Decisions

- Theme `system` is stored verbatim under the shared legacy key `cez-theme`. Verified legacy's behavior first: `web/index.html` does `|| 'dark'`, so an unknown value paints legacy dark — its own default. Storing a *resolved* value instead would silently destroy the user's `system` choice on the first `?legacy=1` visit. Cosmetic-only wart: legacy's toggle label reads "DARK ☾" while already dark until clicked once.
- `/new` moved to the React shell; the bookmarklet query contract (`?skill=&ref=&auto=1&key=` — a protected surface in `BACKWARD_COMPATIBILITY.md`) is parsed by `parseNewTaskParams()`, mirroring legacy's `initFromQuery()` verbatim incl. the undocumented `task` → `ref` alias. **`auto=1` does not auto-start between now and R4** — R4 owns that behavior. The launch key is parsed but never rendered (asserted by test). `/new?legacy=1` keeps the legacy path.
- Two new tokens added at the sanctioned hex site (`styles/index.css`): `--sidebar` (light `#fafafa`, per the mockup — plain `bg-card` would be white-on-white) and `--violet-foreground` (Inbox badge, avoids an off-token `text-white`).
- `GithubIcon` vendored — lucide-react 1.24 removed brand icons.

## Residual / follow-ups (not blockers)

- `typecheck:web` is still **not** in the validation gate (`vite build` does not typecheck). Recommend folding it in.
- The drawer is **not mockup-verified** — the mockups have no drawer (they only hide the sidebar below 767px and show the card list + FAB). It is faithful to the desktop sidebar's framing per the spec's "same components, only the framing changes" rule.
- `DESKTOP_MEDIA_QUERY` in `app-shell.tsx` duplicates Tailwind's `md` breakpoint — both need updating together if it moves.
- Light-theme active nav row is very low contrast (`--muted #f7f7f7` on `--sidebar #fafafa`) — this is what the mockup specifies; flagged rather than silently "fixed".
- Mockup's dark `.seg` active segment (`#333`) still has no token; Tabs uses `bg-card`.
