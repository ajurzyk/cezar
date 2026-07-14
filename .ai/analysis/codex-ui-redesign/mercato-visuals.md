# Mercato Sandboxes — Visual Language Research (for cezar redesign)

**Source:** `open-mercato/mercato-sandboxes` (private repo, accessed via authenticated `gh`; shallow clone at
`/tmp/claude-1000/-home-pkarw-Projects-cezar/4866af8d-803f-4946-a3fe-9a1201e47948/scratchpad/research/mercato-sandboxes`).
The web UI lives in `apps/portal-web` — Next.js 15 + **Tailwind v4** (CSS-first `@theme inline`, no tailwind.config)
+ **shadcn/ui "new-york" style** (neutral base, CSS variables) + Radix primitives + lucide-react icons.
Tokens are documented in-source as a 1:1 mapping of the Figma file **"Mercato Sandboxes — UI/UX"** (Open Mercato design system).

Key files (all under `apps/portal-web/`):
- `app/globals.css` — the complete token sheet (light `:root` + dark `.dark`)
- `design-guardian.test.ts` — static-scan test enforcing the house style rules (worth copying wholesale)
- `components/grain-background.tsx`, `components/twinkle-field.tsx`, `components/auth/hex-sandbox.tsx`,
  `components/sandboxes/gradient-box.tsx`, `components/sandboxes/sandbox-card.tsx` — the signature visual elements
- `public/brand/sandboxes-mark.svg` — the brand mark (gradient tile + dark glyph)

---

## 1. Design tokens (extract verbatim)

### 1.1 Color palette — Light theme (`:root`)

| Token | Hex | Figma name / role |
|---|---|---|
| `--background` | `#ffffff` | page canvas |
| `--foreground` | `#171717` | text/strong-950 |
| `--card` | `#ffffff` | bg/white-0 — card surface |
| `--muted` | `#f7f7f7` | bg/weak-50 — chips, hover, wells |
| `--muted-foreground` | `#5c5c5c` | text/sub-600 — secondary text |
| `--soft-foreground` | `#a3a3a3` | text/soft-400 — placeholders, hints |
| `--border` / `--input` | `#ebebeb` | stroke/soft-200 |
| `--contrast` | `#262626` | bg/surface-800 — inverse/primary-action surface |
| `--contrast-foreground` | `#ffffff` | text on contrast |
| `--primary` | `#a8f372` | **brand lime accent** |
| `--primary-foreground` | `#0d0d0d` | ink on lime |
| `--violet` | `#8f86e8` | secondary brand accent (Enterprise violet) — selection dots, premium CTAs, charts |
| `--ring` | `#171717` | focus ring = foreground ink in light (lime is near-invisible on white) |
| `--danger` | `#ef4444` | destructive |
| `--danger-foreground` | `#ffffff` | |

### 1.2 Color palette — Dark theme (`.dark`)

| Token | Hex | Notes |
|---|---|---|
| `--background` | `#0d0d0d` | near-black canvas (also the auth brand-panel color) |
| `--foreground` | `#ffffff` | |
| `--card` | `#171717` | cards one step up from canvas |
| `--muted` | `#262626` | chips/hover two steps up |
| `--muted-foreground` | `#a3a3a3` | |
| `--soft-foreground` | `#7b7b7b` | |
| `--border` / `--input` | `#262626` | borders = muted → borders visually disappear on dark; elevation reads via surface steps |
| `--contrast` | `#ebebeb` | inverse flips to light |
| `--contrast-foreground` | `#171717` | |
| `--primary` | `#a8f372` | same lime both themes |
| `--violet` | `#8f86e8` | same both themes |
| `--ring` | `#a8f372` | **lime focus ring in dark** (brand moment) |
| `--danger` | `#ef4444` | same both themes |

The neutral ramp is essentially Tailwind `neutral`: `#0d0d0d / #171717 / #262626 / #5c5c5c / #7b7b7b / #a3a3a3 / #ebebeb / #f7f7f7 / #ffffff`.

shadcn aliases are mapped, not duplicated: `--popover=var(--card)`, `--accent=var(--muted)`, `--destructive=var(--danger)`, plus a full `--sidebar-*` set (sidebar = card surface; item hover/active = muted).

### 1.3 Brand gradient (the signature)

Used in the logo tile, GradientBox top edge/wash, hex-cube animation, plan-card glyphs:

```
lime → yellow → violet
#B4F372  →  #EEFB63  →  #BC9AFF
(SVG stops: 0.12 / 0.58 / 1.0, ~135° diagonal; CSS: bg-gradient-to-r from-[#b4f372] via-[#eefb63] to-[#bc9aff])
```

Twinkle/particle palettes (canvas art):
- Dark mode (pastels glow on dark): `#BC9AFF` (violet, 60% weight), `#EEFB63` (yellow, 20%), `#B4F372` (lime, 20%)
- Light mode (deeper siblings, pastels wash out on white): `#8B5CF6`, `#AEC90F`, `#6BA82A`

Other hardcoded accents:
- Enterprise violet CTA: `bg-[#8f86e8] hover:bg-[#7d73e0] text-white`; featured plan border `#8f86e8/50`; usage chart stroke/fill `#8f86e8`
- Crash screen (`global-error.tsx`): bg `#0a0a0a`, text `#fafafa`, sub `#a3a3a3`, CTA `#a8f372` on `#0d0d0d`

### 1.4 Status colors (Tailwind stock, not tokens)

- Running / success / progress bars: `emerald-500` (pill: `bg-emerald-500/12 text-emerald-700 dark:text-emerald-400`)
- Pending/transitional: `amber-400` — **dot or spinner tint only, never text** (guardian-enforced)
- Error: `--danger` `#ef4444` (pill: `bg-danger/12 text-danger`)
- Paused/neutral: `muted-foreground` dot on `bg-muted` pill

### 1.5 Radius scale

```
--radius-sm: 8px
--radius:    10px   ← default control radius (inputs, buttons, cards)
--radius-lg: 12px   (menus, popovers, elevated panels)
--radius-xl: 16px   (dialogs, large surfaces / feature cards)
```
Also seen: `rounded-2xl` (16px) for GradientBox section frames, `rounded-[18px]` for 72px state-icon tiles, `rounded-full` pills and corner-action buttons, `rounded-md` for tiny chips.

### 1.6 Shadow scale (very restrained — borders carry most separation)

```
--shadow-xs:    0 1px 2px 0 rgba(10, 13, 20, 0.03)    ← resting card
--shadow-sm:    0 2px 4px 0 rgba(27, 28, 29, 0.04)
--shadow-md:    0 16px 32px -12px rgba(14, 18, 27, 0.10)  ← card hover-lift
--shadow-modal: 0 16px 48px 0 rgba(0, 0, 0, 0.12)     (dark theme: rgba(0,0,0,0.45))
```

### 1.7 Typography

- **Font: Inter** (next/font/google, `--font-inter`), stack `var(--font-inter), system-ui, sans-serif`; `antialiased` on `<html>`. This is the ONLY font — mono falls back to Tailwind's default `font-mono` stack (used for terminal chrome, dense step lists, 11.5–13px).
- Sizes in use (precise, often arbitrary values): page title `text-2xl font-bold`; section title `text-base font-semibold`; card title `text-[15px] font-semibold`; body `text-sm`; secondary `text-[12.5px]`/`text-[12px]`; chips `text-xs font-medium`/`font-semibold`; micro-labels `text-[11px] font-medium`; sidebar brand `text-[17px] font-semibold`.
- Buttons are `font-semibold`; default button text `text-[15px]`.
- Numeric UI uses `tabular-nums`; headings `text-balance`, paragraphs `text-pretty`.

### 1.8 Control sizing / spacing

- Inputs & default buttons: **h-11 (44px)**, radius `var(--radius)` (10px), input `px-3.5 text-sm`, button `px-5 text-[15px]`
- Button sizes: sm `h-9 px-3 text-sm`, lg `h-12 px-6 text-base`, icon `size-9 rounded-lg`, iconSm `size-8 rounded-lg`
- Card padding: `p-4`–`p-5`; dialog `p-6`; page shell `max-w-6xl px-6 py-8`; auth form column `max-w-[380px]` with `gap-8`
- Status pills: `px-2.5 py-1 text-xs` with 7px (`size-[7px]`) leading dot, `gap-1.5`
- Progress tracks: `h-1.5 rounded-full bg-border` (explicitly **bg-border, not bg-muted** — must stay visible on grain; guardian-enforced) with `bg-emerald-500` fill

### 1.9 Dark-mode mechanics

- Class-based: `@custom-variant dark (&:where(.dark, .dark *))`; server defaults to `.dark`, inline `<head>` script re-resolves `localStorage("portal-theme")` / system preference **before first paint** (no flash), ThemeProvider reconciles after mount. Theme toggle + language toggle sit together top-right.

---

## 2. Motion language

Deliberately quiet; almost everything is stock Tailwind/`tw-animate` utilities. **No custom @keyframes anywhere** — no shimmer; skeletons and pending-dots use `animate-pulse`.

| Pattern | Recipe |
|---|---|
| Card hover lift | wrapper `transition-transform duration-150 ease-out hover:-translate-y-0.5 focus-within:-translate-y-0.5`; card `transition-shadow duration-150`, shadow-xs → shadow-md. **No surface tint on hover.** |
| Skeleton | `animate-pulse rounded-md bg-muted` (plain shadcn) |
| Pending status | 7px dot `bg-amber-400 animate-pulse`; spinner tinted `text-amber-400` |
| Spinner | custom SVG: full circle stroke at `opacity-25` + solid quarter arc, `animate-spin`, strokeWidth 3, `currentColor` |
| Progress | width transition `transition-[width] duration-500` (500ms), emerald fill; indeterminate = `w-2/5 animate-pulse` |
| Dialogs | Radix enter/exit: `fade-in-0 zoom-in-95` / out, `duration-200`; overlay `bg-black/50` fade |
| Sheets | slide-in-from-side, open 500ms / close 300ms |
| Tooltips | `bg-contrast text-contrast-foreground`, fade+zoom-95, side-aware `slide-in-from-*-2` |
| Everything else | `transition-colors` (20 uses — the workhorse) |
| Canvas art | twinkle = sine-phase alpha oscillation, `TWINKLE = 0.005` rad/ms (~0.8Hz); **always guarded by `prefers-reduced-motion`** (renders a static frame) |

---

## 3. Signature visual elements (reuse these in cezar)

1. **Brand gradient tile logo** (`public/brand/sandboxes-mark.svg`): 30×30 rounded-rect (r≈4/30) filled with the lime→yellow→violet diagonal gradient, dark `#1B1B1B` geometric glyph on top. Self-contained colors → works on both themes. Cezar should adopt the same construction (gradient tile + dark glyph) with its own glyph.

2. **Grain texture** (`grain-background.tsx`): canvas-rendered static noise behind "home" surfaces (dashboard, list pages) — dark mode: white specks max-alpha 0.13 modulated by a 3-node Gaussian mesh so it glows toward the top; light mode: even fine neutral grain rgb(120,120,128) alpha ≤0.15 at device resolution. Rendered once (no animation loop), `-z-10`, `aria-hidden`. Dense screens stay flat. This texture is *the* Mercato surface feel.

3. **Twinkle field** (`twinkle-field.tsx`): 2–3px brand-colored squares (violet-weighted 60/20/20), sine-twinkling, brightness fading top→bottom (`1 - (y/h)^1.3 * 0.95`), density 0.00045/px², cap 1600, reduced-motion-safe. Used behind full-screen lifecycle/empty states.

4. **GradientBox section frame** (`gradient-box.tsx`): `rounded-2xl border bg-muted` well containing content cards, with (a) a 4px (`h-1`) brand-gradient line across the top edge and (b) the same gradient as a 12rem wash at 25% opacity fading down via `mask-image: linear-gradient(to bottom, rgba(0,0,0,.95), transparent)`. "White cards on a soft well" composition.

5. **Notched card corner** (`sandbox-card.tsx`): the card's top-right corner is carved out with a CSS mask (SVG corner tile, convex r=12 shoulders into a concave R=28 sweep) and a circular `size-9 rounded-full` action button nests in the notch as a sibling. Light mode adds an SVG stroke along the scoop so the border runs unbroken; dark mode hides it. The corner action's state changes with entity status (black arrow-up-right when running, play when paused, etc.). Most distinctive component in the system.

6. **Status pill grammar**: neutral pill (`bg-muted`, `rounded-full` or `rounded-md`, `text-xs`) + 7px colored leading dot carrying ALL status color; dot pulses while transitioning. Colored pill fills only at 12% tint (`bg-emerald-500/12`, `bg-danger/12`). Amber never appears as text.

7. **Startup checklist** (`startup-steps.tsx`): live step list — emerald check (done), amber-tinted spinner (running), faint circle (pending), danger X (failed) — above a thin emerald progress bar with `done + 0.5·running` percentage. Dense variant switches to `font-mono text-[13px]`. Directly applicable to cezar's workflow-step live view.

8. **CenteredState empty/lifecycle template** (`centered-state.tsx`): grain + twinkle backdrop, 72px `rounded-[18px]` icon tile (tinted border+fill by tone: `border-primary/25 bg-primary/15 text-primary`, neutral = card+shadow-xs, danger = danger/15), `text-2xl font-semibold` title, `text-sm text-muted-foreground` subtitle, actions row. One template for every loading/paused/error/empty state.

9. **Dark auth split-screen** (`auth-shell.tsx` + `hex-sandbox.tsx`): left half always `#0d0d0d` with a corner-to-corner mesh gradient (lime 20% top-left → violet 18% bottom-right), radial vignette, and a canvas hexagon-cube outline (brand-gradient stroke at alpha 0.06) filled with 550 twinkling grains whose "sand" runs along the path edges and sheds off downhill (gravity particles). Right half: plain themed form column, `max-w-[380px]`.

10. **Contrast-inverse CTA**: primary actions are either lime (`bg-primary` + near-black text) or the inverse surface (`bg-contrast` — black in light / off-white in dark). The pure-black pill (`bg-neutral-900`, dark: `+ border-white/10`) is the "open/go" affordance.

11. **SandboxIcon glyph style** (`sandbox-icon.tsx`): stroke-2 rounded rect + `</>` code marks + two rows of 0.7r speckle dots, all `currentColor` — the speckle/grain motif carried into iconography. Cezar's custom glyphs should echo the dot-speckle motif. Everything else is lucide-react.

12. **Design-guardian test** (`design-guardian.test.ts`): vitest static scan banning raw hex outside an allowlist of brand/illustration files, amber text, raw `bg-white/bg-black/text-black` outside primitives, native `confirm()`, and `bg-muted` progress tracks. Copy this into cezar to keep the redesign from regressing.

---

## 4. Composition rules worth adopting

- **Layout**: fixed shadcn sidebar (white/card surface, icon-collapsible rail, brand lockup top, status-dotted entity quick-list, user block bottom) + top bar + `max-w-6xl px-6 py-8` main. Full-bleed workspace routes opt out and collapse the sidebar to the icon rail.
- **Elevation via surface steps, not shadows**: light = white cards + `#ebebeb` borders + shadow-xs; dark = `#171717` cards on `#0d0d0d` with invisible borders.
- **Color discipline**: chrome is strictly neutral; color appears only as (a) status dots/tints, (b) the brand gradient in decorative moments, (c) lime for the primary CTA/focus, (d) violet for premium/analytics. Never colored text on tinted chips.
- **Texture as brand**: grain + twinkle appear only on hero/idle/lifecycle surfaces; data-dense screens stay flat for legibility.
- **Accessibility built-in**: skip-link, `aria-hidden` on all decorative canvases, reduced-motion static fallbacks, `focus-visible:ring-2` everywhere (ink ring light / lime ring dark), stretched-link cards.
