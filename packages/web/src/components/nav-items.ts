import {
  GitBranchIcon,
  InboxIcon,
  ListChecksIcon,
  SettingsIcon,
  SparklesIcon,
  WorkflowIcon,
  ZapIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { GithubIcon } from '@/components/icons'
import { forgeIcon, forgeLabel, type ForgeKind } from '@/lib/forge-label'

export type NavItem = {
  /** Where the item navigates. Also its identity — `activeNavPath` returns this. */
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Path prefixes that light this item up. See `activeNavPath` for the longest-prefix rule. */
  match: string[]
  /** Optional trailing status affordance. Rendering/data stay with the shell. */
  badge?: 'inbox-count' | 'skills-update' | 'tasks-unread'
  /** Forge-gated (R6 Step 1.1): the item exists only while `/api/health` reports the forge
   *  driver available — see `visibleNavItems`. */
  forge?: boolean
  /** Inbox-gated (#471): the item exists only while `/api/health` reports
   *  `capabilities.followups` — the global inbox is opt-in via `CEZ_FOLLOWUPS=1`.
   *  See `visibleNavItems`. */
  inbox?: boolean
  /** Automations-gated (#801): the item exists only while `/api/health` reports
   *  `capabilities.automations` — GitHub automations are opt-in via `CEZ_AUTOMATIONS=1`.
   *  Independent of `forge`: the Automations item carries BOTH, because the feature needs a
   *  forge to poll AND the operator's opt-in to exist at all. See `visibleNavItems`.
   *
   *  GitHub-only in fact, not just in name: the poller (`src/automations/github-poller.ts`)
   *  shells out to the `gh` CLI directly and never goes through `resolveForge`, so it has
   *  nothing to say about a Forgejo remote. `visibleNavItems` gates on the forge KIND for
   *  this reason — see its `forgeKind` handling. */
  automations?: boolean
}

/** The sidebar nav from the spec's "App shell & navigation" section, in mockup order.
 *
 *  `match` exists because a nav item is active for a whole *area*, not just its own URL:
 *  the spec requires Tasks to stay active while a task thread (`/tasks/:id`) or a variant
 *  compare (`/compare/:groupId`) is open.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tasks', icon: ListChecksIcon, match: ['/', '/tasks', '/compare'], badge: 'tasks-unread' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, match: ['/inbox'], badge: 'inbox-count', inbox: true },
  { to: '/git', label: 'Git', icon: GitBranchIcon, match: ['/git'] },
  { to: '/github', label: 'GitHub', icon: GithubIcon, match: ['/github'], forge: true },
  { to: '/automations', label: 'Automations', icon: ZapIcon, match: ['/automations'], forge: true, automations: true },
  { to: '/skills', label: 'Skills', icon: SparklesIcon, match: ['/skills'], badge: 'skills-update' },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, match: ['/workflows'] },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings'] },
]

/** What `/api/health` says exists. All default to `false` — see `visibleNavItems`. */
export type NavAvailability = {
  /** `forge.available` (spec §"GitHub tab (forge tab)"). */
  forge?: boolean
  /** WHICH forge answered — `health.forge.kind` for the flat nav, the registry entry's own
   *  `forge` for a project group. Names the forge item and withholds Automations from a forge
   *  the poller cannot reach. Absent means "not said yet", which reads as GitHub throughout
   *  (`forgeLabel`), so a surface that never passes it behaves exactly as it did before. */
  forgeKind?: ForgeKind
  /** Has the AUTHORITY for this surface answered with that kind (`useForgeKindStatus().settled`)?
   *  Absent means yes — a caller passing a registry entry's own `forge` has nothing left to wait
   *  for. The hook-driven surfaces (the flat nav, the ⌘K palette, the forge tab's own cross-link)
   *  pass the real flag, because for them `forgeKind` starts out undefined for a reason that is not
   *  "GitHub". Only the automations offer reads it — see `automationsPollable`. */
  forgeSettled?: boolean
  /** `capabilities.followups` — the opt-in global inbox (#471). */
  inbox?: boolean
  /** `capabilities.automations` — the opt-in GitHub automations (#801). */
  automations?: boolean
}

/** The forge item, wearing the name and mark of the forge that actually answered.
 *
 *  Returns the ORIGINAL item unless something has to change: the nav's items are compared by
 *  identity in places (and every surface re-renders on every health tick), so minting a fresh
 *  object per render for the overwhelmingly common GitHub case would be pure churn. */
function forgeItem(item: NavItem, kind: ForgeKind | undefined): NavItem {
  const label = forgeLabel(kind)
  if (label === item.label) return item
  // Name and mark both come from `forge-label.ts`, so this item and the forge tab's own
  // unavailable state can never wear different marks for the same forge.
  return { ...item, label, icon: forgeIcon(kind) }
}

/**
 * Can the automations poller talk to this forge at all? Automations carry a condition the other
 * gates do not: the poller (`src/automations/github-poller.ts`) shells out to the `gh` CLI and
 * never goes through `resolveForge`, so it has nothing to say about a Forgejo remote.
 *
 * An unknown kind reads as pollable, the pre-Stage-4 default — the same "absent means GitHub" rule
 * `forgeLabel` follows — but ONLY once that unknown is an answer. Naming an unnamed tab "GitHub" is
 * reversible on the next render; an offer taken in that window is not. While the registry is in
 * flight `forgeKind` is undefined on every surface, including a Forgejo project's, and reading that
 * as GitHub renders the nav item and the tab's cross-link long enough to click through and build an
 * automation nothing will ever poll. So this gate fails CLOSED on silence and opens on the answer,
 * which is the opposite of what the label does — deliberately, because they are not the same
 * decision. `forgeSettled` defaults to true: a caller passing a registry entry's own `forge` has
 * already got its answer.
 *
 * Exported because the offer is made in more than one place: the nav (here) AND the forge tab's
 * own cross-link into `/automations/new` (`routes/github/github.tsx`). Two spellings of this
 * condition would eventually disagree, and the disagreement would hand a Forgejo user an
 * automation that can never fire.
 */
export function automationsPollable(forgeKind?: ForgeKind, forgeSettled = true): boolean {
  return forgeSettled && (forgeKind === undefined || forgeKind === 'github')
}

/**
 * The nav items a surface should actually render: a gated item drops out — nav item AND tab —
 * unless the health payload says its feature is there. The forge-gated GitHub item needs the
 * forge driver (spec §"GitHub tab (forge tab)"); the Inbox item needs `capabilities.followups`,
 * which is off unless `CEZ_FOLLOWUPS=1` (#471); the Automations item needs a forge AND
 * `capabilities.automations`, which is off unless `CEZ_AUTOMATIONS=1` (#801).
 *
 * Gates are ANDed per item, never ORed, which is what lets one item carry two of them: an
 * automations opt-in on a repo with no GitHub remote still has nothing to poll.
 *
 * Everything defaults to absent while health is still unknown, on the shell's honesty rule: the
 * nav must not claim a tab exists before the server has said so (the Tools menu's forge note
 * explains the GitHub absence). Both the sidebar and the ⌘K palette's Views group render through
 * this, so the two can never disagree.
 */
export function visibleNavItems({
  forge = false,
  forgeKind,
  forgeSettled = true,
  inbox = false,
  automations = false,
}: NavAvailability = {}): NavItem[] {
  // Offering a tab that cannot work is worse than withholding one that could — see
  // `automationsPollable`.
  const pollable = automationsPollable(forgeKind, forgeSettled)
  return NAV_ITEMS
    .filter((item) =>
      (item.forge ? forge : true)
      && (item.inbox ? inbox : true)
      && (item.automations ? automations && pollable : true))
    .map((item) => (item.forge && !item.automations ? forgeItem(item, forgeKind) : item))
}

/** Does `pathname` sit inside the area rooted at `prefix`?
 *
 *  Segment-aware on purpose: a plain `startsWith` would make `/git` match `/github`, and
 *  would make the `/` root match literally every route.
 */
function inArea(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * The `to` of the nav item that owns `pathname`, or null when no item does (e.g. `/new`,
 * which is a full-screen surface with no nav home).
 *
 * Longest matching prefix wins, which is what disambiguates nested areas: the `/` root only
 * matches the exact path (see `inArea`), so every deeper route falls to its own item —
 * `/settings/agents` lights Settings, `/git/commits` lights Git.
 */
export function activeNavPath(pathname: string): string | null {
  let best: { to: string; length: number } | null = null
  for (const item of NAV_ITEMS) {
    for (const prefix of item.match) {
      if (inArea(pathname, prefix) && (best === null || prefix.length > best.length)) {
        best = { to: item.to, length: prefix.length }
      }
    }
  }
  return best?.to ?? null
}

/**
 * The nav item that owns `pathname` — the mobile top bar titles itself from this.
 *
 * `forgeKind` names the forge item exactly as `visibleNavItems` does, because the bar shares its
 * screen with the sidebar item and the view's own `<h1>`: a title reading "GitHub" beside a
 * heading reading "Forgejo" is the mismatch Stage 4 removes
 * (spec 2026-08-14-forgejo-forge-support §"Stage 4").
 *
 * Gating is deliberately NOT applied here. A route reached while its tab is hidden still needs a
 * title, so this answers from the whole table — the availability question belongs to
 * `visibleNavItems`, which decides what is offered, not to what a URL is called.
 */
export function activeNavItem(pathname: string, forgeKind?: ForgeKind): NavItem | null {
  const to = activeNavPath(pathname)
  const item = NAV_ITEMS.find((candidate) => candidate.to === to) ?? null
  if (item === null || !item.forge || item.automations) return item
  return forgeItem(item, forgeKind)
}
