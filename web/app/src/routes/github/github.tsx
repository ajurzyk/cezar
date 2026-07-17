import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'

import { getGithub, putUiState } from '@/api/client'
import { queryKeys, useGithub, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { GithubItem, UiState } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import type { EnginePick } from '@/components/engine-pills'
import { GithubIcon } from '@/components/icons'
import { TabLink } from '@/components/tab-link'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { githubTaskPrompt } from '@/lib/github-task'
import { cn } from '@/lib/utils'

import { Markdown } from '../task-thread/markdown'
import { allLabels, filterGithubItems, labelChipStyle } from './github-filter'
import { GithubLoading } from './github-loading'
import { HandToAgent } from './hand-to-agent'

/**
 * `/github` — the forge tab rebuilt in React (R6 Step 1.1, spec §"GitHub tab (forge tab)"):
 * functionally the legacy tab — issues/PRs lists, a detail pane with markdown body + label
 * chips + checks badge, drag-to-composer, hand-to-agent — with the chip walls replaced by
 * searchable cmdk dropdowns (#385) and every surface a URL: `/github` (issues),
 * `/github/prs`, `/github/issues/:n`, `/github/prs/:n`. PR rows also carry a compact checks
 * glyph (#400) — the same tones as the detail pane's `ChecksBadge`, just the symbol.
 *
 * Data keeps the legacy two-shot load (feedback 2026-07-11: the 30-item `gh` default hid the
 * rest): the fast default batch paints the tab, then a background everything-open fetch
 * (limit 1000) replaces it and fixes the counts — until it lands, a count at the fast-batch
 * cap renders as `30+`, because "30 of who knows" must not read as exactly 30.
 *
 * Gating: the nav item is hidden by the shell when health reports no forge — but the URL
 * stays reachable (pasted links), so an unavailable payload renders the honest explainer
 * with the server's own reason, never an error.
 */

/** The server's default batch (`/api/github` limit). A count AT this cap is "cap of who
 *  knows" until the full fetch lands — the tabs say `30+`. */
const FAST_BATCH = 30

/** The background "everything open" fetch — same number the legacy tab used. */
const FULL_LIMIT = 1000

export type GithubView = 'issues' | 'prs'

/**
 * `/github`'s index (#417): restores the last-selected sub-tab instead of always defaulting
 * to Issues. Only the bare path redirects — `/github/prs` and the `:n` deep links always
 * render exactly what their URL says, memory or not, so a pasted link never surprises.
 *
 * A one-way check, not a live sync: it reads `ui-state.json` once per mount and either renders
 * Issues or hands off to `/github/prs`. It never redirects back to Issues from `/github/prs` —
 * that URL is authoritative on its own.
 */
export function GithubIndexRoute() {
  const uiState = useUiState()
  if (uiState.data?.githubView === 'prs') {
    return <Navigate to="/github/prs" replace />
  }
  return <GithubRoute view="issues" />
}

export function GithubRoute({ view }: { view: GithubView }) {
  const { n } = useParams()
  const fast = useGithub()
  // Two-shot: the full fetch waits for the fast one to prove the forge reachable.
  const full = useGithub({ limit: FULL_LIMIT }, fast.data?.available === true)
  // The full batch replaces the fast one only when it is a real answer (legacy rule — a
  // failed background fetch leaves the fast batch standing, counts just keep their "+").
  const gh = full.data?.available ? full.data : fast.data
  const isFull = full.data?.available === true

  const queryClient = useQueryClient()

  // Persist the tab choice (#417), mirroring the appearance provider's read-then-write
  // pattern. The cache is patched BEFORE the PUT resolves — not just for optimism, but so
  // `GithubIndexRoute`'s check (which reads the same cache) sees the new choice immediately
  // if the click just navigated `/github/prs` → `/github`: without the eager patch it would
  // still read the stale "prs" and bounce the Issues tab straight back.
  const saveGithubView = (next: GithubView) => {
    queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, githubView: next }))
    putUiState({ githubView: next })
      .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // The write failed — fall back to the server's truth rather than keep the tab
        // claiming a persistence it never got.
        void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
      })
  }

  const refresh = useMutation({
    mutationFn: () => getGithub({ refresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.github({}), data)
      // The refresh busted the server cache; the full batch must re-run against it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.github({ limit: FULL_LIMIT }) })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  // Pickers + queued-run bookkeeping live at the route so they survive switching items
  // (legacy parity) — see HandToAgent's doc block.
  const workflows = useWorkflows()
  const skills = useSkills()
  const [workflow, setWorkflow] = useState<string | null>(null)
  const [selectedSkills, setSelectedSkills] = useState<readonly string[]>([])
  // The backend choice (#401) is a way of working too, so it lives here beside the pickers —
  // and it must, because HandToAgent is keyed by item and would otherwise reset on every hop.
  const [engine, setEngine] = useState<EnginePick>({ runner: null, model: null })
  const [queued, setQueued] = useState<ReadonlyMap<string, string>>(new Map())
  // List filtering (#gh-filter): free-text search (by #id or any text) + a label narrow.
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState<readonly string[]>([])

  if (!gh) {
    if (fast.isError) {
      return (
        <div data-route="github" className="flex min-h-full flex-col">
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="danger"
            title="Could not load GitHub"
            subtitle={fast.error.message}
          />
        </div>
      )
    }
    return <GithubLoading />
  }

  if (!gh.available) {
    return (
      <div data-route="github" className="flex min-h-full flex-col">
        <CenteredState
          icon={<GithubIcon />}
          tone="neutral"
          title="GitHub is unavailable here"
          subtitle={gh.reason ?? 'unknown reason'}
          actions={
            <Button
              variant="outline"
              data-action="gh-retry"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Try again
            </Button>
          }
        >
          <p className="text-xs leading-relaxed text-soft-foreground">
            The tab needs the <span className="font-mono">gh</span> CLI, logged in (
            <span className="font-mono">gh auth login</span>), and a repo with a GitHub remote.
            Everything else in cezar works without it.
          </p>
        </CenteredState>
      </div>
    )
  }

  const allItems = view === 'issues' ? gh.issues : gh.prs
  const labelColors = gh.labelColors ?? {}
  const labelOptions = allLabels(allItems)
  const items = filterGithubItems(allItems, { query, labels: labelFilter })
  const filtering = query.trim() !== '' || labelFilter.length > 0
  const number = n === undefined ? null : Number.parseInt(n, 10)
  // No URL selection → the first item, like the legacy tab (rendered, not navigated-to). The
  // selection may point at an item outside the current filter — keep resolving it from the full
  // list so a deep link to #N still opens even while a filter is active.
  const selected =
    number === null ? (items[0] ?? null) : (allItems.find((item) => item.number === number) ?? null)
  const listPath = view === 'issues' ? '/github' : '/github/prs'

  return (
    // Bounded to the viewport (`h-full min-h-0`) so the PAGE never scrolls — each pane owns its
    // own scroll (`overflow-y-auto`), so scrolling starts inside the issues/PR list (and the
    // detail), and the list header stays pinned. `overscroll-contain` keeps a pane's scroll from
    // chaining out to the shell.
    <div data-route="github" className="flex h-full min-h-0 items-stretch">
      {/* List pane. Below md it IS the page when no item is in the URL, and yields entirely
          to the detail when one is — the same two-surfaces-one-URL rule the git tabs use. */}
      <section
        data-slot="gh-list"
        className={cn(
          'w-full min-h-0 flex-col overflow-y-auto overscroll-contain border-border md:flex md:w-[360px] md:shrink-0 md:border-r',
          n === undefined ? 'flex' : 'hidden',
        )}
      >
        <header data-slot="gh-header" className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="text-lg font-semibold">GitHub</h1>
            {gh.repo ? (
              <span data-slot="gh-repo" className="min-w-0 truncate font-mono text-[11px] text-soft-foreground">
                {gh.repo}
              </span>
            ) : null}
            <button
              type="button"
              data-slot="gh-refresh"
              title="Refresh from GitHub"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55"
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn('size-[9px]', refresh.isPending && 'motion-safe:animate-spin')}
              />
              {gh.syncedAt ? `synced ${shortAge(gh.syncedAt)} ago` : 'refresh'}
            </button>
          </div>
          <div data-slot="gh-tabs" className="mt-2.5 flex items-end gap-1">
            <TabLink to="/github" active={view === 'issues'} onClick={() => saveGithubView('issues')}>
              Issues · {countLabel(gh.issues.length, isFull)}
            </TabLink>
            <TabLink to="/github/prs" active={view === 'prs'} onClick={() => saveGithubView('prs')}>
              Pull requests · {countLabel(gh.prs.length, isFull)}
            </TabLink>
          </div>
          <div className="mt-2.5 flex items-center gap-2 pb-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground"
              />
              <input
                type="search"
                data-slot="gh-search"
                aria-label={`Search ${view}`}
                placeholder="Search #id, title, author…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-md border border-input bg-card py-1 pr-2 pl-7 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <LabelFilter
              options={labelOptions}
              colors={labelColors}
              selected={labelFilter}
              onChange={setLabelFilter}
            />
          </div>
        </header>

        {items.length === 0 ? (
          <p className="px-4 py-4 text-sm text-soft-foreground">
            {filtering
              ? `No ${view === 'issues' ? 'issues' : 'pull requests'} match your filter.`
              : `No open ${view === 'issues' ? 'issues' : 'pull requests'}.`}
          </p>
        ) : (
          <ul data-slot="gh-rows" className="flex flex-col gap-0.5 px-2 py-2">
            {items.map((item) => (
              <GithubRow
                key={item.url}
                item={item}
                view={view}
                colors={labelColors}
                active={selected?.url === item.url}
                queued={queued.has(item.url)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Detail pane. Hidden below md until an item is in the URL. */}
      <section
        data-slot="gh-detail"
        className={cn(
          'min-w-0 min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain',
          n === undefined ? 'hidden md:flex' : 'flex',
        )}
      >
        {selected ? (
          <GithubDetail item={selected} listPath={listPath} colors={labelColors}>
            <HandToAgent
              key={selected.url}
              item={selected}
              workflows={workflows.data?.workflows ?? []}
              skills={skills.data ?? []}
              workflow={workflow}
              onWorkflowChange={setWorkflow}
              selectedSkills={selectedSkills}
              onSkillsChange={setSelectedSkills}
              engine={engine}
              onEngineChange={setEngine}
              queuedRunId={queued.get(selected.url) ?? null}
              onQueued={(url, runId) => setQueued((current) => new Map(current).set(url, runId))}
            />
          </GithubDetail>
        ) : (
          <CenteredState
            icon={view === 'issues' ? <CircleDotIcon /> : <GitPullRequestIcon />}
            tone="neutral"
            heading="h2"
            title={number === null ? 'Nothing selected' : 'Not in the open list'}
            subtitle={
              number === null
                ? `No open ${view === 'issues' ? 'issues' : 'pull requests'} to show.`
                : `#${number} is not among the open ${view === 'issues' ? 'issues' : 'pull requests'} — it may be closed, or still outside the fetched batch.`
            }
          />
        )}
      </section>
    </div>
  )
}

/** `30+` while the fast batch might be truncated; the plain number once the full fetch landed. */
function countLabel(count: number, isFull: boolean): string {
  return `${count}${!isFull && count >= FAST_BATCH ? '+' : ''}`
}

function GithubRow({
  item,
  view,
  colors,
  active,
  queued,
}: {
  item: GithubItem
  view: GithubView
  colors: Record<string, string>
  active: boolean
  queued: boolean
}) {
  const Icon = item.kind === 'issue' ? CircleDotIcon : GitPullRequestIcon

  // Drag an issue/PR row into the composer — it prefills the same prompt "Run agent on this
  // issue" uses (legacy parity); a textarea accepts the text/plain payload natively.
  const onDragStart = (event: DragEvent) => {
    try {
      event.dataTransfer.setData('text/plain', githubTaskPrompt(item))
      event.dataTransfer.effectAllowed = 'copy'
    } catch {
      // older engines — the drag just won't carry the prompt
    }
  }

  return (
    <li>
      <Link
        to={`${view === 'issues' ? '/github/issues' : '/github/prs'}/${item.number}`}
        draggable
        onDragStart={onDragStart}
        data-slot="gh-row"
        data-number={item.number}
        aria-current={active ? 'page' : undefined}
        title="Drag into the composer to prefill a task"
        className={cn(
          'flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors hover:bg-muted',
          active && 'bg-muted',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            aria-hidden="true"
            className={cn('size-3.5 shrink-0', item.kind === 'issue' ? 'text-success' : 'text-violet')}
          />
          <span className={cn('min-w-0 truncate text-[13px] font-medium', active && 'font-semibold')}>
            {item.title}
          </span>
        </span>
        <span className="flex items-center gap-2 pl-[22px] font-mono text-[10.5px] text-muted-foreground">
          <span>#{item.number}</span>
          <span className="min-w-0 truncate">{item.author}</span>
          <span>{shortAge(item.createdAt)}</span>
          {item.checks ? <ChecksGlyph checks={item.checks} /> : null}
          {queued ? (
            <span data-slot="gh-queued-flag" className="font-sans font-medium text-violet">
              ↗ run queued
            </span>
          ) : null}
        </span>
        {item.labels.length > 0 ? (
          <span className="flex flex-wrap gap-1 pl-[22px]">
            {item.labels.map((label) => (
              <LabelChip key={label} label={label} color={colors[label]} />
            ))}
          </span>
        ) : null}
      </Link>
    </li>
  )
}

/** The label narrow: a searchable multi-select of the labels present in the current list. Selected
 *  labels AND together (GitHub semantics), handled by `filterGithubItems`. */
function LabelFilter({
  options,
  colors,
  selected,
  onChange,
}: {
  options: readonly string[]
  colors: Record<string, string>
  selected: readonly string[]
  onChange: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (label: string) =>
    onChange(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="gh-label-filter"
          disabled={options.length === 0}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50',
            selected.length > 0 && 'border-primary/60 text-foreground',
          )}
        >
          <TagIcon aria-hidden="true" className="size-3.5" />
          {selected.length > 0 ? `Labels · ${selected.length}` : 'Labels'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Filter labels…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No labels.</CommandEmpty>
            {selected.length > 0 ? (
              <CommandItem value="__clear__" onSelect={() => onChange([])} className="text-soft-foreground">
                Clear {selected.length} filter{selected.length > 1 ? 's' : ''}
              </CommandItem>
            ) : null}
            {options.map((label) => {
              const on = selected.includes(label)
              return (
                <CommandItem key={label} value={label} onSelect={() => toggle(label)}>
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full border"
                    style={labelChipStyle(colors[label])}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {on ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A single label pill, tinted with its GitHub color (or neutral when unknown). */
function LabelChip({ label, color }: { label: string; color: string | undefined }) {
  return (
    <span
      data-slot="gh-label"
      data-label={label}
      style={labelChipStyle(color)}
      className="rounded-full border px-1.5 py-px text-[10px] font-medium"
    >
      {label}
    </span>
  )
}

function GithubDetail({
  item,
  listPath,
  colors,
  children,
}: {
  item: GithubItem
  listPath: string
  colors: Record<string, string>
  children: ReactNode
}) {
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue'
  const hasDiffStat = item.kind === 'pr' && Boolean(item.additions || item.deletions)
  return (
    <article data-slot="gh-detail-inner" className="min-w-0 px-4 py-4 md:px-7 md:py-5">
      <Link
        to={listPath}
        data-slot="gh-back"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        Back to the list
      </Link>

      <p data-slot="gh-meta" className="flex flex-wrap items-center gap-x-1.5 font-mono text-[10.5px] text-soft-foreground">
        <span>#{item.number}</span>·<span>{kindWord}</span>·<span>opened by {item.author}</span>·
        <span>{shortAge(item.createdAt)} ago</span>
        {item.comments ? (
          <>
            ·<span>{item.comments} comments</span>
          </>
        ) : null}
        {hasDiffStat ? (
          <>
            ·
            <span data-slot="gh-diffstat">
              <span className="text-success">+{item.additions ?? 0}</span>{' '}
              <span className="text-danger">−{item.deletions ?? 0}</span>
            </span>
          </>
        ) : null}
        ·
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="gh-open-link"
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
        >
          open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </p>

      <h2 className="mt-2 text-xl leading-snug font-semibold">{item.title}</h2>

      {item.labels.length > 0 || item.checks ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {item.labels.map((label) => (
            <LabelChip key={label} label={label} color={colors[label]} />
          ))}
          {item.checks ? <ChecksBadge checks={item.checks} url={item.url} /> : null}
        </div>
      ) : null}

      <div data-slot="gh-body" className="mt-5 text-sm">
        {item.body ? (
          <Markdown>{item.body}</Markdown>
        ) : (
          <p className="text-soft-foreground">(no description)</p>
        )}
      </div>

      {children}
    </article>
  )
}

/** Glyph + tone shared by the list row's compact indicator and the detail pane's full badge
 *  (#400) — one source of truth so the two surfaces can't drift out of sync. */
type Checks = NonNullable<GithubItem['checks']>
const CHECKS_GLYPH: Record<Checks, string> = { passing: '✓', failing: '✗', pending: '○' }
const CHECKS_TONE: Record<Checks, string> = {
  passing: 'text-success',
  failing: 'text-danger',
  pending: 'text-muted-foreground',
}

/** The checks badge — the legacy tab's three phrases, tinted by outcome. Links out
 *  to the PR's checks tab on GitHub (issue #415) when a URL is available. */
function ChecksBadge({ checks, url }: { checks: Checks; url?: string }) {
  const className = cn('text-[11px] font-medium', CHECKS_TONE[checks], url && 'hover:underline')
  const label = `${CHECKS_GLYPH[checks]} checks ${checks}`

  if (!url) {
    return (
      <span data-slot="gh-checks" data-checks={checks} className={className}>
        {label}
      </span>
    )
  }

  return (
    <a
      href={`${url}/checks`}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="gh-checks"
      data-checks={checks}
      className={className}
    >
      {label}
    </a>
  )
}

/** The PR row's compact checks indicator (#400) — same tones as `ChecksBadge`, just the glyph
 *  (the row is too narrow for the full phrase). Issues never have `checks`, so this only ever
 *  shows up on PR rows. */
function ChecksGlyph({ checks }: { checks: Checks }) {
  return (
    <span
      data-slot="gh-row-checks"
      data-checks={checks}
      title={`checks ${checks}`}
      aria-label={`checks ${checks}`}
      className={cn('shrink-0 font-sans text-[11px] font-semibold', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}
