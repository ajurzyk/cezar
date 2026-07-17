import { MenuIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'

import { openCommandPalette } from '@/components/command-palette'
import { StatusDot } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { activeNavItem, activeNavPath, visibleNavItems, type NavItem } from '@/components/nav-items'
import { cn } from '@/lib/utils'
// The Open Mercato brand mark (web/open-mercato.svg), bundled by Vite so it resolves in both
// the dev server and the built cockpit. Its own gradient + rounded corners ARE the tile.
import brandLogoUrl from '../../../open-mercato.svg'

/** Tailwind's `md`. The drawer is the `<md` affordance, so this must stay in step with the
 *  `md:hidden` / `md:flex` classes below — they are the same breakpoint expressed twice, once
 *  for CSS and once for the state machine. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export type RepoChip = {
  name: string
  branch: string
}

export type AppShellProps = {
  /** The routed view. Renders into the one scrolling region. */
  children: ReactNode
  /** Repo + branch for the brand chip. Null until Step 3.1/3.2 wires `/api/health` — the chip
   *  is simply absent rather than showing an invented repo name. */
  repo?: RepoChip | null
  /** Inbox badge count. Null/0 renders no badge. Step 3.2 feeds it from the SSE stream. */
  inboxCount?: number | null
  /** cezar version for the footer chip. Null until Step 3.1 reads it from `/api/health`. */
  version?: string | null
  /** The npm registry's newer version, when the server's update check found one (#368). The
   *  chip grows a pulsing pending dot + tooltip; absent or equal to `version`, it stays plain. */
  latestVersion?: string | null
  /** Step 3.3's grouped task quick-list. */
  taskQuickList?: ReactNode
  /** Step 4.2's Tools dropdown trigger. */
  toolsMenu?: ReactNode
  /** Forge gating (R6 Step 1.1): `false` drops the GitHub nav item — see `visibleNavItems`.
   *  Defaults to shown so the presentational shell stays renderable alone; the container
   *  passes the health payload's truth. */
  forgeAvailable?: boolean
  /** Inbox gating (#471): `false` drops the Inbox nav item and its badge — the global inbox is
   *  opt-in via `CEZ_FOLLOWUPS=1`. Defaults to shown for the same reason as `forgeAvailable`. */
  inboxAvailable?: boolean
  /** Global chrome banner (#391's `SkillsBanner`), rendered in its own row above the scroller.
   *  Absent renders nothing — the slot is generic, not skills-specific. */
  banner?: ReactNode
}

/**
 * The cockpit's app shell: a fixed sidebar plus a single scrolling main region.
 *
 * Layout contract (spec, "App shell & navigation"):
 *  - `h-dvh` (never `100vh` — that ignores mobile browser chrome and clips the composer).
 *  - The main column is a `auto auto 1fr auto` grid — top bar / banner / scroller / composer
 *    dock. Rows are placed explicitly (`row-start-*`) so hiding the mobile bar at `md`, or
 *    passing no `banner`, leaves that row empty instead of promoting the scroller into the
 *    `auto` row and collapsing it.
 *  - The banner is a peer row of the scroller, never a child of it: routed views own
 *    `sticky top-0` headers (at both `z-10` and `z-20`), so a banner sticking to the same edge
 *    inside `main` would tie with them in the stacking order and be painted over. Its own row
 *    keeps it visible while the view scrolls under it, with no z-index coupling to any route.
 *  - `overflow-hidden` here and on `body` means the document never scrolls; only the main
 *    region does, with `overscroll-contain` so a thread at its end doesn't rubber-band the page.
 *  - Safe-area insets are the shell's job, not each view's: left/right on the root, top on the
 *    mobile bar, bottom on the composer row (which stays mounted, so the home indicator always
 *    has its gutter even before Step R4 puts a composer in it).
 *  - Below `md` the sidebar is gone and its content moves, unchanged, into an overlay drawer
 *    (`MobileNavDrawer`). Same components, only the framing changes.
 */
export function AppShell({
  children,
  repo = null,
  inboxCount = null,
  version = null,
  latestVersion = null,
  taskQuickList,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  banner,
}: AppShellProps) {
  const { pathname } = useLocation()
  const activeTo = activeNavPath(pathname)
  const current = activeNavItem(pathname)
  const [menuOpen, setMenuOpen] = React.useState(false)

  // Close on route change. Without this the drawer survives the navigation it triggered and sits
  // on top of the view the user just asked for — and back/forward and the ⌘K palette (Step 4.3)
  // navigate without going through the drawer's own links at all.
  React.useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // The drawer must not outlive its breakpoint: widening past `md` reveals the real sidebar, and
  // an open drawer would leave a focus-trapping modal over an already-visible nav.
  React.useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_MEDIA_QUERY)
    if (!query) return
    if (query.matches) setMenuOpen(false)
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const nav = {
    activeTo,
    items: visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable }),
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    version,
    latestVersion,
    taskQuickList,
    toolsMenu,
  }

  return (
    // The Sheet root renders no DOM of its own — it is the context that lets the top bar's menu
    // button be a real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        data-slot="app-shell"
        className="flex h-dvh overflow-hidden bg-background text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <Sidebar {...nav} />
        <MobileNavDrawer {...nav} onNavigate={() => setMenuOpen(false)} />

        <div className="grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden">
          <MobileTopBar title={current?.label ?? 'cezar'} />

          {banner ? (
            <div data-slot="banner-slot" className="row-start-2">
              {banner}
            </div>
          ) : null}

          <main data-slot="main" className="row-start-3 min-h-0 overflow-y-auto overscroll-contain">
            {children}
          </main>

          {/* Row 4: the composer dock (thread reply, Step R3). Empty today, but it still carries
              the bottom safe-area gutter so the scroller never runs under the home indicator. */}
          <div
            data-slot="composer"
            className="row-start-4 pb-[env(safe-area-inset-bottom)]"
          />
        </div>
      </div>
    </Sheet>
  )
}

type NavProps = {
  activeTo: string | null
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  version: string | null
  latestVersion: string | null
  taskQuickList?: ReactNode
  toolsMenu?: ReactNode
}

/** The desktop frame: a fixed 264px column, from `md` up. */
function Sidebar(props: NavProps) {
  return (
    <aside
      data-slot="sidebar"
      className="hidden w-[264px] shrink-0 flex-col border-r border-border bg-sidebar md:flex"
    >
      <SidebarContent {...props} />
    </aside>
  )
}

/**
 * The `<md` frame for the *same* `SidebarContent` the desktop column renders — the spec's mobile
 * rule is that the sidebar "becomes an overlay drawer", not that mobile gets its own nav.
 *
 * Radix's Dialog (via the Sheet primitive) supplies the parts that are easy to get wrong by hand:
 * `role="dialog"`, the accessible name, the focus trap, the Escape handler, the backdrop's
 * dismiss-on-tap, and `aria-hidden` on everything outside the portal — which is how it delivers
 * modality (it does not set `aria-modal`; `hideOthers` is the stronger guarantee).
 */
function MobileNavDrawer({ onNavigate, ...props }: NavProps & { onNavigate: () => void }) {
  return (
    <SheetContent
      side="left"
      data-slot="mobile-nav-drawer"
      showCloseButton={false}
      // The drawer is the sidebar: same width, same surface token, and no padding of its own —
      // SidebarContent brings its own. `sm:max-w-none` sheds the primitive's sheet width cap.
      className="w-[264px] gap-0 border-border bg-sidebar p-0 sm:max-w-none md:hidden"
      // Nav needs no prose description, and Radix warns when it cannot find the one it links to.
      aria-describedby={undefined}
    >
      {/* The dialog's accessible name. Visually redundant with the brand lockup below. */}
      <SheetTitle className="sr-only">Navigation</SheetTitle>
      <SidebarContent
        {...props}
        onNavigate={onNavigate}
        headerAction={
          <SheetClose asChild>
            {/* size-11: the ≥44px touch target the spec's mobile rules require. */}
            <Button variant="ghost" size="icon" aria-label="Close menu" className="-mr-2 size-11">
              <XIcon className="size-[17px]" aria-hidden="true" />
            </Button>
          </SheetClose>
        }
      />
    </SheetContent>
  )
}

/**
 * Everything inside the sidebar: brand lockup, New task CTA, nav, quick-list, footer. Framed by
 * `Sidebar` on desktop and by `MobileNavDrawer` below `md` — the two callers differ only in the
 * box around this, which is what keeps the mobile nav from drifting away from the desktop one.
 *
 * The safe-area insets live here rather than on the frames because both need them: the drawer is
 * a full-height overlay under the same notch and home indicator the sidebar sits under.
 */
function SidebarContent({
  activeTo,
  items,
  repo,
  inboxCount,
  version,
  latestVersion,
  taskQuickList,
  toolsMenu,
  onNavigate,
  headerAction,
}: NavProps & {
  /** Fires on any in-drawer navigation. The route-change effect already closes the drawer for
   *  every *changed* route; this also covers re-clicking the active item (per the spec, Tasks
   *  navigates home even when already active), which changes no pathname at all. */
  onNavigate?: () => void
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: ReactNode
}) {
  return (
    <div
      data-slot="sidebar-content"
      className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center gap-[9px] px-3.5 pt-3.5 pb-2.5">
        <BrandTile />
        <span className="text-[15px] font-semibold">cezar</span>
        {repo ? (
          <span
            data-slot="repo-chip"
            className="ml-auto truncate font-mono text-[11px] font-medium text-soft-foreground"
          >
            {repo.name} / {repo.branch}
          </span>
        ) : null}
        {headerAction ? <div className={cn('shrink-0', !repo && 'ml-auto')}>{headerAction}</div> : null}
      </div>

      <div className="px-2.5 pt-1 pb-2">
        <Button asChild variant="contrast" className="relative w-full justify-center">
          {/* A Router Link since R4 Step 1.1: the React /new composer is real, so deliberate
              New task affordances stay inside the SPA. Full document loads of /new (the
              bookmarklet contract) land on the shell like any route (static-ui.ts) — the
              React composer has owned auto-start parity since R4 Step 1.3. */}
          <Link to="/new" onClick={onNavigate}>
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New task
            {/* Decorative: the `c`-to-create accelerator is registered in the command palette.
                (⌘N is also bound there, but only the desktop shell receives it — the browser
                reserves ⌘N for a new window — so the chip advertises the one that always works.) */}
            <kbd
              aria-hidden="true"
              className="absolute right-2.5 rounded-[5px] border border-b-2 border-contrast-foreground/25 bg-transparent px-[5px] py-px font-mono text-[10.5px] font-medium text-contrast-foreground/60"
            >
              C
            </kbd>
          </Link>
        </Button>
      </div>

      <nav aria-label="Main" className="px-2.5 py-1.5">
        {items.map((item) => {
          const isActive = item.to === activeTo
          const Icon = item.icon
          // Link, not NavLink, on purpose. NavLink derives `aria-current` from its own prefix
          // match against `to`, and that rule is wrong here: it would *not* light Tasks on
          // /tasks/:id — which the spec requires. `aria-current` cannot be forced past NavLink's
          // own matching, so the area rule lives in `activeNavPath` and this is a plain Link.
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                // h-[34px] is the mockup's desktop row. In the drawer these are touch targets, so
                // they relax to 44px — the one place the two framings legitimately differ.
                'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[34px]',
                isActive && 'bg-muted font-semibold text-foreground'
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {item.label}
              {item.badge && inboxCount ? (
                <span
                  data-slot="nav-badge"
                  className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
                >
                  {inboxCount}
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>

      {/* Step 3.3 renders the grouped quick-list (Needs you / Working / Recent) in here. */}
      <div
        data-slot="task-quick-list"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2"
      >
        {taskQuickList}
      </div>

      <div
        data-slot="sidebar-footer"
        className="flex flex-wrap items-center gap-2 gap-y-1.5 border-t border-border px-3.5 py-2.5"
      >
        {/* SLOT — Step 4.2 mounts the Tools dropdown (aggregate status dot + tool versions) here. */}
        <div data-slot="tools-menu">{toolsMenu}</div>
        {version ? <VersionChip version={version} latestVersion={latestVersion} /> : null}
        <CommandPaletteHint />
        <ThemeToggle className="ml-auto" />
      </div>
    </div>
  )
}

/**
 * The ⌘K discoverability affordance (Step 4.3): a quiet chip-shaped button in the footer, cut
 * from the same cloth as the version chip — the palette is chrome, not a feature to shout
 * about. Clicking it opens the palette through the same programmatic seam anything else would.
 */
function CommandPaletteHint() {
  return (
    <button
      type="button"
      data-slot="command-palette-hint"
      title="Command palette (⌘K / Ctrl+K)"
      aria-label="Open the command palette"
      onClick={() => openCommandPalette()}
      className="flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <SearchIcon className="size-[9px]" aria-hidden="true" />
      ⌘K
    </button>
  )
}

/**
 * The footer's `v{version}` chip. When the server's npm-registry check found something newer
 * (`latestVersion`, #368), the chip grows a pulsing pending-tone dot and names the version in
 * its tooltip — an affordance, not an alert: updating is optional, so the chrome stays quiet.
 */
function VersionChip({ version, latestVersion }: { version: string; latestVersion: string | null }) {
  const updateAvailable = Boolean(latestVersion && latestVersion !== version)
  return (
    <span
      data-slot="version-chip"
      data-update-available={updateAvailable ? 'true' : undefined}
      title={updateAvailable ? `update available: v${latestVersion}` : undefined}
      className="flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground"
    >
      {updateAvailable ? <StatusDot tone="pending" pulse className="size-[5px]" /> : null}
      v{version}
    </span>
  )
}

/** The Open Mercato brand mark. The SVG carries its own gradient and rounded corners, so it is
 *  the tile — no wrapper background. */
function BrandTile() {
  return (
    <img
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      data-slot="brand-tile"
      className="size-[26px] shrink-0 rounded-sm"
    />
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button opens `MobileNavDrawer`. */
function MobileTopBar({ title }: { title: string }) {
  return (
    <header
      data-slot="mobile-top-bar"
      className="row-start-1 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[52px] items-center gap-2.5 px-3">
        {/* A real SheetTrigger rather than an onClick that flips our state: it is what registers
            the button as the dialog's trigger, which is what Radix restores focus to on close —
            with a bare onClick, closing the drawer drops focus on <body>. It also carries the
            aria-haspopup / aria-expanded / aria-controls wiring for free. */}
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            // 44px: the minimum touch target, overriding the 36px desktop icon-button size.
            className="-ml-1.5 size-11"
          >
            <MenuIcon className="size-[17px]" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <span className="truncate text-[14.5px] font-semibold">{title}</span>
        {/* SLOT — the run status dot / kebab land with the thread view (Step R3). */}
        <div data-slot="mobile-status" className="ml-auto flex items-center gap-2" />
      </div>
    </header>
  )
}
