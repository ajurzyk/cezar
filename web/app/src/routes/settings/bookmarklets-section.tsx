import { TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useLaunchKey, useSkills } from '@/api/queries'
import type { Skill } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { bookmarkletUrl } from '@/lib/bookmarklet'
import { orderSkills } from '@/lib/skills'

/** Settings → Bookmarklets (spec 011): the legacy generic and per-skill launchers promoted
 *  to a first-class, discoverable Settings subpage. */
export function BookmarkletsSection() {
  const skillsQuery = useSkills()

  // Without this the in-flight catalog renders as the panel's empty state, which tells the
  // user "(no skills yet)" — a claim that is simply false while the fetch is still running.
  if (skillsQuery.isPending) {
    return (
      <p data-slot="bookmarklets-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading bookmarklets…
      </p>
    )
  }
  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load bookmarklets"
        subtitle={skillsQuery.error.message}
      />
    )
  }

  return (
    <div className="flex min-h-full flex-1 overflow-y-auto px-4 py-5 md:px-7">
      <BookmarkletPanel skills={orderSkills(skillsQuery.data ?? [])} />
    </div>
  )
}

/**
 * The bookmarklet generator panel (spec 011, ported from the legacy cockpit): draggable
 * `javascript:` links against the protected `/new?skill=&key=` contract (`lib/bookmarklet`).
 * A failed key fetch degrades exactly like legacy — the links still generate, auto-start
 * just will not arm.
 *
 * Exported so the former Settings → Skills deep link remains compatible while the same
 * generator also has its own Settings subpage.
 */
export function BookmarkletPanel({ skills }: { skills: readonly Skill[] }) {
  const launchKey = useLaunchKey()
  const [auto, setAuto] = useState(false)
  const [filter, setFilter] = useState('')
  const key = launchKey.data?.key ?? ''
  // Bake THIS cockpit's origin into the bookmarklets so a click opens the very instance that
  // generated them — no localhost port-scan (GitHub's CSP blocks that fetch). See bookmarklet.ts.
  const origin = window.location.origin
  const needle = filter.trim().toLowerCase()
  const shown = skills.filter((skill) => skill.name.toLowerCase().includes(needle))

  return (
    <div data-slot="bookmarklet-panel" className="mx-auto w-full max-w-2xl">
      <h2 className="text-base font-semibold">Run from GitHub</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
        Drag a button below to your browser&apos;s bookmarks bar. On any GitHub PR or issue, click it —
        it finds your running cockpit on localhost (ports 4321–4330) and picks the one serving that
        repo. The cockpit must be running: <span className="font-mono">npx cezar</span>.
      </p>

      <label className="mt-4 flex items-center gap-2 text-[13px] font-medium">
        <input
          type="checkbox"
          data-slot="bm-auto"
          checked={auto}
          onChange={(event) => setAuto(event.target.checked)}
          className="size-3.5"
        />
        One-click launch (auto-submit){' '}
        <span className="font-normal text-soft-foreground">— re-drag the buttons after changing this</span>
      </label>

      <div data-slot="bm-generic" className="mt-4">
        {/* Generic launcher: no skill, auto forced off — it only prefills the form. */}
        <BookmarkletRow
          label="cezar: this PR/issue"
          url={bookmarkletUrl('', false, key, origin)}
          hint="prefills the form — nothing starts by itself"
        />
      </div>

      <Input
        data-slot="bm-filter"
        placeholder="Filter skills…"
        aria-label="Filter bookmarklet skills"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="mt-5 h-8 text-[13px]"
      />
      <div data-slot="bm-list" className="mt-3 flex flex-col gap-2">
        {shown.length > 0 ? (
          shown.map((skill) => (
            <BookmarkletRow
              key={skill.path}
              label={`/${skill.name}`}
              url={bookmarkletUrl(skill.name, auto, key, origin)}
              hint={skill.source}
            />
          ))
        ) : (
          <p className="text-xs text-soft-foreground">
            {skills.length > 0
              ? '(no skills match)'
              : '(no skills yet — the generic launcher above still works)'}
          </p>
        )}
      </div>
    </div>
  )
}

function BookmarkletRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  // React (rightly) refuses `javascript:` hrefs at render time — but a bookmarklet IS one by
  // definition, and dragging to the bookmarks bar needs the real href on the DOM node. The
  // link is a drag source only (the click handler below never lets it execute), so setting
  // the attribute imperatively is the honest escape hatch.
  const anchor = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    anchor.current?.setAttribute('href', url)
  }, [url])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Bookmarklet URL copied.')
    } catch {
      toast('Copy failed — drag the button instead.', { tone: 'danger' })
    }
  }
  return (
    <div data-slot="bm-row" className="flex min-w-0 items-center gap-2.5">
      {/* A drag SOURCE only — the cockpit page never executes the javascript: URL itself
          (spec 011 §5), so a plain click just explains the gesture. */}
      <a
        ref={anchor}
        draggable
        data-slot="bm-link"
        title="Drag me to your bookmarks bar"
        onClick={(event) => {
          event.preventDefault()
          toast('Drag me to your bookmarks bar')
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-muted"
      >
        <ZapIcon aria-hidden="true" className="size-3 text-primary" />
        {label}
      </a>
      <button
        type="button"
        data-slot="bm-copy"
        title="Copy the bookmarklet URL"
        onClick={() => void copy()}
        className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Copy
      </button>
      {hint ? <span className="min-w-0 truncate text-[11px] text-soft-foreground">{hint}</span> : null}
    </div>
  )
}
