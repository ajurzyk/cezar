import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

import {
  applyRunDeleted,
  applyRunEvent,
  createUsageStore,
  EMPTY_USAGE,
  mergeRun,
  parseGlobalEvent,
  type GlobalEvent,
  type UsageStore,
} from './events'
import { queryKeys } from './queries'
import type { ApiRun, ProcessUsage } from './types'

/**
 * The app's one connection to `GET /api/events`, and the two halves of the sync doctrine
 * (spec, "Architecture"): the stream is for immediacy, the REST endpoints are authoritative, and
 * on reconnect or a tab-visibility flip we refetch and reconcile.
 *
 * Immediacy is cache patching, not refetching: a live run emits a `run` event per step transition
 * and per token update, and invalidating the list on each would turn one agent into a request
 * flood against a server sharing this laptop's CPU with it. So events are folded into the cache
 * in place (events.ts), and the authoritative refetch happens exactly when we know we may have
 * missed something: at reconnect, and when a tab (or a phone that slept through an hour of the
 * run) comes back.
 */

const SSE_URL = '/api/events'

/** `EventSource.CLOSED`. Spelled as the literal so nothing here depends on the global's statics —
 *  the same reason the constructor is read off `globalThis` below. */
const CLOSED = 2

/** How long to wait before rebuilding a stream the browser gave up on. Long enough that a server
 *  restart isn't hammered while it boots, short enough that the cockpit is live again before the
 *  reader notices. Only reached in the permanent-failure case: an ordinary drop is EventSource's
 *  own retry, which we neither can nor should replace. */
const REOPEN_DELAY_MS = 3_000

/** Everything the stream is allowed to say. An unknown name never reaches `parseGlobalEvent`,
 *  because SSE only delivers named events to a matching listener in the first place. */
const EVENT_NAMES = ['run', 'run-deleted', 'todos', 'usage', 'ping'] as const

/**
 * Refetch the authoritative endpoints.
 *
 * These three because they are the ones the stream can leave stale:
 * - runs: the summaries the stream patches (`invalidate(['runs'])` covers the list and every
 *   single-run query under it — that is what the hierarchical keys in queries.ts are for);
 * - todos: the inbox the `todos` event replaces;
 * - health: the repo/branch chip. Health is not on the stream — nothing server-side watches for a
 *   branch switch — so this reconcile alone only catches a switch across a reconnect or a tab
 *   coming back; a checkout in a foreground, connected tab is covered by `useHealth`'s own poll
 *   instead (#369). Invalidating it here too costs nothing extra and keeps this list a complete
 *   "everything the stream can leave stale" note.
 *
 * `invalidateQueries` and not `refetchQueries`: it refetches what is actually rendered and marks
 * the rest stale for whenever it next mounts. A background tab with fifty cached runs should not
 * fetch fifty runs to come back.
 */
function reconcile(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
  void queryClient.invalidateQueries({ queryKey: queryKeys.health })
}

/** Fold one stream message into the cache. The reducers it calls are pure and table-tested in
 *  events.ts; this is only the wiring from an event to the cache it belongs in. */
function applyGlobalEvent(queryClient: QueryClient, usage: UsageStore, event: GlobalEvent): void {
  switch (event.type) {
    case 'run': {
      queryClient.setQueryData<ApiRun[]>(queryKeys.runs.list(), (list) => applyRunEvent(list, event.run))
      // Only a detail cache that exists: `setQueryData` would happily create one, leaving an entry
      // for a run nobody opened — and, worse, one built from a summary rather than from
      // `GET /api/runs/:id`, which the next reader would then be served as if it were fetched.
      const key = queryKeys.runs.detail(event.run.id)
      if (queryClient.getQueryData(key) !== undefined) {
        queryClient.setQueryData<ApiRun>(key, (previous) => mergeRun(previous, event.run))
      }
      return
    }
    case 'run-deleted': {
      queryClient.setQueryData<ApiRun[]>(queryKeys.runs.list(), (list) => applyRunDeleted(list, event.id))
      // Removed, not set to undefined: the run is gone server-side, so its detail and diff caches
      // are garbage. Anything still mounted on them refetches and gets the server's 404 — the
      // truth — instead of rendering a record that no longer exists.
      queryClient.removeQueries({ queryKey: queryKeys.runs.detail(event.id) })
      queryClient.removeQueries({ queryKey: queryKeys.runs.diff(event.id) })
      return
    }
    case 'todos':
      // A complete array every time (the server re-reads the file), so it replaces outright and
      // may seed a cache no one fetched yet — unlike `run`, this payload *is* the whole answer.
      queryClient.setQueryData(queryKeys.todos, event.items)
      return
    case 'usage':
      usage.set(event.usage)
      return
    case 'ping':
      // A keep-alive. It says the socket is open, which we already know by receiving it.
      return
  }
}

/**
 * Hold one EventSource open for as long as this is mounted.
 *
 * Called once, by `GlobalEventsProvider`. One connection per app and not per component: browsers
 * cap concurrent connections per origin (6 on HTTP/1.1, which is what a local Hono server speaks),
 * and a handful of components each opening their own stream would spend that budget on duplicate
 * copies of the same messages and then stall every other request behind them.
 */
export function useGlobalEvents(usage: UsageStore, url: string = SSE_URL): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // jsdom has no EventSource, and neither would a prerender. Read it off `globalThis` so the
    // check and the construction see the same binding (`vi.stubGlobal` is what the tests install).
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    let source: EventSource | null = null
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let everOpened = false
    let disposed = false

    const reopenLater = (): void => {
      if (disposed || reopenTimer !== undefined) return
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined
        if (!disposed) connect()
      }, REOPEN_DELAY_MS)
    }

    const connect = (): void => {
      source?.close()
      source = new Source(url)

      source.addEventListener('open', () => {
        // Not the first one: at boot the queries are fetching anyway, and invalidating them here
        // would only ask the same questions twice. Every later open is a *re*connect — we were
        // disconnected, events happened without us, and the cache is now a guess.
        if (everOpened) reconcile(queryClient)
        everOpened = true
      })

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (event) => {
          const parsed = parseGlobalEvent(name, (event as MessageEvent<string>).data)
          if (parsed) applyGlobalEvent(queryClient, usage, parsed)
        })
      }

      source.addEventListener('error', () => {
        // An ordinary drop leaves the stream CONNECTING and the browser retries it on its own —
        // touching that would just race its backoff. CLOSED means it gave up for good, which is
        // what a restarting server produces (the request is answered with a non-2xx while it
        // boots). Nothing would ever reopen it, so the cockpit would sit there looking live and
        // showing yesterday's state.
        if (source?.readyState === CLOSED) reopenLater()
      })
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      // The phone-in-a-pocket case: mobile browsers freeze background tabs, so the stream may have
      // been dead for an hour with no error handler ever running. Whatever is on screen right now
      // is what the reader is about to trust, so ask the server before they read it.
      reconcile(queryClient)
      if (!source || source.readyState === CLOSED) {
        // Don't make them wait out a backoff that started while they were away.
        clearTimeout(reopenTimer)
        reopenTimer = undefined
        connect()
      }
    }

    const onPageHide = (): void => {
      // Full navigation away. React never unmounts for those — the document goes to the
      // back/forward cache still holding this socket, and six cached documents exhaust the
      // browser's per-origin connection pool: the *next* page load then hangs waiting for a
      // free socket. Close eagerly; pageshow reopens if the document ever comes back.
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      source?.close()
    }

    const onPageShow = (event: PageTransitionEvent): void => {
      // Only a bfcache restore (`persisted`) finds this document alive with its stream closed
      // by onPageHide; on a normal load this effect just ran and the stream is fresh.
      if (!event.persisted) return
      reconcile(queryClient)
      connect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    connect()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      // Explicit: an EventSource keeps its socket (and its retry loop) alive on its own, so a
      // dropped reference leaks a connection per remount, and StrictMode remounts every effect.
      source?.close()
      source = null
    }
  }, [queryClient, usage, url])
}

const UsageContext = createContext<UsageStore | null>(null)

/**
 * Mounts the global stream and publishes the live usage map.
 *
 * Must sit inside `QueryClientProvider` (it patches that cache) and be rendered exactly once.
 */
export function GlobalEventsProvider({ children }: { children: ReactNode }) {
  // One store per provider instance, created lazily: a module-level singleton would let one test's
  // ticks bleed into the next, and StrictMode's double-invoked render still yields exactly one.
  const [usage] = useState(createUsageStore)
  useGlobalEvents(usage)
  return <UsageContext.Provider value={usage}>{children}</UsageContext.Provider>
}

/**
 * The live `{runId → usage}` map. Re-renders the caller on each ~2 s tick and nothing else.
 *
 * Empty outside a provider rather than a throw: "no samples yet" is a real, expected state (it is
 * what every idle cockpit reports), so a component rendered without the stream sees the same
 * nothing it would see before the first tick instead of crashing a tree over telemetry.
 */
export function useUsage(): Record<string, ProcessUsage> {
  const store = useContext(UsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.get : getEmptyUsage,
    getEmptyUsage,
  )
}

/**
 * One run's live sample.
 *
 * Selected inside the store subscription rather than by reading the whole map, so a row only
 * re-renders when its own sample is replaced: a tick that carries nothing about this run (it
 * finished, it never had a process) leaves the selected value `undefined` — identical, so React
 * bails out — while `useUsage()` would hand it a new map object every tick.
 */
export function useRunUsage(runId: string | undefined): ProcessUsage | undefined {
  const store = useContext(UsageContext)
  const get = store ? store.get : getEmptyUsage
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (runId ? get()[runId] : undefined),
    () => undefined,
  )
}

const noopSubscribe = (): (() => void) => () => undefined
const getEmptyUsage = (): Record<string, ProcessUsage> => EMPTY_USAGE
