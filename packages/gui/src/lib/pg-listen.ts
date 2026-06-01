// Tiny helper for the runner long-poll route (Phase 3 of the runner
// horizontal-scaling work): wait for a Postgres NOTIFY on the `jobs_queued`
// channel (fired by the 0025 migration trigger when a job becomes claimable),
// with a hard timeout and AbortSignal hookup so a runner that disconnects
// mid-wait frees the underlying connection promptly.
//
// Design choice (deliberately simple): one dedicated `pg.Client` per
// long-poll request, end()-ed in a `finally`. The alternative — one
// process-wide client multiplexing wake-ups to N in-flight requests — is more
// scalable but adds an in-memory event bus and a self-healing reconnect path.
// At the current fleet size (≤64 concurrent long-polls, capped below) the
// dedicated-client approach is fine and easy to reason about; the multiplex
// path can come later if the connection count becomes a problem.

import { Client } from 'pg';

/** Channel name the 0025 trigger NOTIFYs on. */
export const JOBS_QUEUED_CHANNEL = 'jobs_queued';

/**
 * Env var carrying the direct Postgres connection string. Supabase exposes it
 * as both `SUPABASE_DB_URL` and `POSTGRES_URL` depending on platform; we
 * accept either. `DATABASE_URL` is the seed scripts' convention — also accepted.
 *
 * Returns null when nothing is configured — callers should degrade to
 * short-poll mode (a single immediate claim attempt) rather than crash.
 */
export function getPgConnectionString(): string | null {
  return (
    process.env.SUPABASE_DB_URL
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? null
  );
}

// Cap concurrent long-poll connections to keep a flood of runners from
// exhausting the database's connection pool. Beyond this, the route falls
// back to short-poll (single claim attempt, no wait). 64 leaves plenty of
// headroom even on a small Supabase tier.
const MAX_CONCURRENT_LISTENERS = 64;
let activeListeners = 0;

/** Current count of in-flight long-poll connections (for /api/runner/jobs). */
export function getActiveListenerCount(): number {
  return activeListeners;
}

/** True if the long-poll pool has room; callers use this to decide between
 * long-poll and short-poll on each request. */
export function canAcquireListener(): boolean {
  return activeListeners < MAX_CONCURRENT_LISTENERS;
}

/**
 * Open a dedicated `pg.Client`, `LISTEN jobs_queued`, and resolve:
 *   - `true`  when a NOTIFY arrives before the timeout / abort,
 *   - `false` when the timeout elapses or the AbortSignal fires.
 *
 * Connection management: every code path (success, timeout, abort, error)
 * ends with `UNLISTEN` + `client.end()` so the underlying socket is released.
 * Cleanup errors are swallowed — they're already terminal for this request.
 */
export async function waitForJobsQueuedNotify(
  timeoutMs: number,
  abort?: AbortSignal,
): Promise<boolean> {
  const conn = getPgConnectionString();
  if (!conn || timeoutMs <= 0) return false;
  if (!canAcquireListener()) return false;

  // Supabase's pooled connection string (pgbouncer) does NOT carry LISTEN
  // sessions. Allow callers to point at the direct (5432) connection string;
  // the helper just trusts whatever it gets. The README/MIGRATION.md doc
  // notes the requirement.
  const client = new Client({ connectionString: conn });
  activeListeners += 1;

  let notified = false;
  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;

  try {
    await client.connect();
    await client.query(`LISTEN ${JOBS_QUEUED_CHANNEL}`);

    notified = await new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (abortListener && abort) abort.removeEventListener('abort', abortListener);
        resolve(value);
      };
      client.on('notification', (msg) => {
        if (msg.channel === JOBS_QUEUED_CHANNEL) done(true);
      });
      client.on('error', () => done(false));
      timer = setTimeout(() => done(false), timeoutMs);
      if (abort) {
        if (abort.aborted) { done(false); return; }
        abortListener = () => done(false);
        abort.addEventListener('abort', abortListener);
      }
    });
  } catch (err) {
    // Connection failure / LISTEN rejection — degrade gracefully to short-poll.
    console.warn('[pg-listen] connect/LISTEN failed:', err instanceof Error ? err.message : err);
    notified = false;
  } finally {
    try { await client.query(`UNLISTEN ${JOBS_QUEUED_CHANNEL}`); } catch { /* terminal */ }
    try { await client.end(); } catch { /* terminal */ }
    activeListeners -= 1;
  }

  return notified;
}
