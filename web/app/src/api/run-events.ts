import { useEffect, useState } from 'react'

import type { RunEvent } from './types'

/**
 * The per-run event stream (`GET /api/runs/:id/events`), as a raw ordered list — R2 Step 2.4's
 * proof that the protocol-v2 pipe works end to end. Deliberately NO rendering and NO
 * interpretation: R3's thread view is the consumer that turns these into items; this hook only
 * owns the subscription mechanics that every consumer would otherwise get wrong the same way.
 *
 * The endpoint speaks TWO SSE event names on one socket (src/server/server.ts):
 *  - `run-event` — the v1 lines, what the legacy transcript renders;
 *  - `ui-event`  — protocol v2 (dotted types): persisted snapshots AND the ephemeral coalesced
 *    `item.delta` flushes, which never hit the NDJSON file.
 * Both land in the one list, in arrival (= `seq`) order, because v2 is *additive*: a consumer
 * migrating one panel at a time needs both vocabularies over one clock.
 *
 * Dedup MUST be `seq > maxSeq`, never equality or gap detection: the server replays the whole
 * NDJSON file on every (re)connect — dropping everything at or below the high-water mark is
 * what makes an EventSource auto-reconnect invisible — and ephemeral deltas consume seq numbers
 * that never reappear in a replay, so gaps are normal, not loss.
 */

/** Both wire names. Exported so tests and future consumers subscribe to exactly this set. */
export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

/**
 * Parse one SSE frame into a `RunEvent`, or null for anything malformed. Null rather than a
 * throw, as everywhere on the stream boundary: one bad frame costs one frame, not the socket.
 * `seq` must be a number — it is the dedup axis, and a line without one cannot be ordered.
 */
export function parseRunEvent(data: string): RunEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { seq, type } = payload as { seq?: unknown; type?: unknown }
  if (typeof seq !== 'number' || typeof type !== 'string' || type === '') return null
  return payload as RunEvent
}

/**
 * Subscribe to one run's event stream and accumulate the raw ordered list.
 *
 * The list resets when `runId` changes (a different run's events are not "earlier state" of
 * this one) and the socket closes on unmount — an EventSource left unclosed retries forever.
 * No reducer cache, no query-client involvement: unlike the global stream, this data belongs
 * to exactly the component that asked for it.
 */
export function useRunEvents(runId: string | undefined): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])

  useEffect(() => {
    // The reset also covers the runId-changed case: whatever accumulated belongs to the old id.
    setEvents([])
    if (!runId) return

    // Off `globalThis`, like global-events.tsx: jsdom has no EventSource, and the tests stub it.
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    // The high-water mark lives with the socket's effect, not in state: a reconnect replay
    // arrives between renders, and dedup must not race React's batching.
    let maxSeq = 0
    let source: EventSource | null = null
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const CLOSED = 2 // EventSource.CLOSED, spelled literally like global-events.tsx
    const REOPEN_DELAY_MS = 1_500

    const onFrame = (event: Event) => {
      const parsed = parseRunEvent((event as MessageEvent<string>).data)
      if (!parsed || !(parsed.seq > maxSeq)) return
      maxSeq = parsed.seq
      setEvents((current) => [...current, parsed])
    }

    const reopenLater = (): void => {
      if (disposed || reopenTimer !== undefined) return
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined
        if (!disposed) open()
      }, REOPEN_DELAY_MS)
    }

    const open = (): void => {
      source?.close()
      source = new Source(`/api/runs/${encodeURIComponent(runId)}/events`)
      for (const name of RUN_EVENT_NAMES) source.addEventListener(name, onFrame)
      source.addEventListener('error', () => {
        // Ordinary drops leave the socket CONNECTING and the browser retries on its own; CLOSED
        // means it gave up for good (what a restarting server produces), so nothing would reopen
        // it — the transcript would silently freeze while the header (global stream) keeps
        // updating, looking live over stale content. Reopen; `maxSeq` swallows the replay.
        if (source?.readyState === CLOSED) reopenLater()
      })
    }

    // The phone-in-a-pocket case: a frozen background tab can leave the stream dead for an hour
    // with no error handler ever firing. On return, reopen if it's closed — whatever is on screen
    // is about to be trusted (the thread is the app's primary view, same threat model as the
    // global stream). #minor-run-sse-recovery.
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      if (!source || source.readyState === CLOSED) {
        clearTimeout(reopenTimer)
        reopenTimer = undefined
        open()
      }
    }

    // Same bfcache discipline as the global stream: a full navigation parks this document with
    // its socket open and starves the per-origin pool. Close on pagehide; a bfcache restore
    // reopens, and `maxSeq` swallows the replayed prefix.
    const onPageHide = (): void => {
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      source?.close()
    }
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) open()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    open()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      source?.close()
    }
  }, [runId])

  return events
}
