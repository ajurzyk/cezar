import { ChevronRightIcon } from 'lucide-react'
import { Link, NavLink } from 'react-router'

import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsSection } from './registry'

/**
 * The registry-driven Settings shell (R6 Step 1.3, spec §"Settings").
 *
 * Layout, both driven by the same `visibleSettingsSections()` so they can never disagree:
 *  - desktop (`md:`): a left section nav beside the section's content;
 *  - mobile: a segmented pill row above the content (`/settings` itself renders the stacked
 *    section list instead — the drill-in page small screens expect).
 *
 * Every section is its own URL (`/settings/<id>`), so the h1 is the SECTION title — that is
 * what the page is about; "Settings" is the area. Hidden registry entries are not routed, so
 * their URLs are honest 404s until the section ships.
 */

function SectionNav({ activeId }: { activeId: SettingsSection['id'] | null }) {
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      className="hidden w-52 shrink-0 flex-col gap-1 border-r border-border p-3 md:flex"
    >
      {visibleSettingsSections().map((section) => (
        <NavLink
          key={section.id}
          to={`/settings/${section.id}`}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
            section.id === activeId
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/** The mobile stand-in for the left nav: one segmented, scrollable pill row. */
function SectionPills({ activeId }: { activeId: SettingsSection['id'] }) {
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav-mobile"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5 md:hidden"
    >
      {visibleSettingsSections().map((section) => (
        <NavLink
          key={section.id}
          to={`/settings/${section.id}`}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
            section.id === activeId
              ? 'border-transparent bg-contrast text-contrast-foreground'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/** `/settings/<id>` — one registered section inside the shell. */
export function SettingsSectionRoute({ section }: { section: SettingsSection }) {
  const Body = section.component
  return (
    <div data-route={`settings-${section.id}`} className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Settings". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{section.title}</h1>
        <p className="text-[13px] text-soft-foreground">{section.description}</p>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav activeId={section.id} />
        <SectionPills activeId={section.id} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Body />
        </div>
      </div>
    </div>
  )
}

/** `/settings` — the area's index: the same registry rendered as a stacked list of cards
 *  (the mobile drill-in page; on desktop it sits beside the nav as a plain directory). */
export function SettingsIndexRoute() {
  return (
    <div data-route="settings" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="text-[13px] text-soft-foreground">Configure the cockpit and its agents.</p>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav activeId={null} />
        {/* No second h1 for small screens: the app shell's mobile top bar already titles the
            page "Settings" from the nav registry. */}
        <div className="flex min-w-0 flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
          <ul data-slot="settings-index" className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
            {visibleSettingsSections().map((section) => (
              <li key={section.id}>
                <Link
                  to={`/settings/${section.id}`}
                  data-section={section.id}
                  className="flex items-center gap-3.5 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:bg-card-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                    <section.icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{section.title}</span>
                    <span className="block text-xs text-soft-foreground">{section.description}</span>
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
