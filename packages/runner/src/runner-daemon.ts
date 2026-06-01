import { RunnerClient, type ClaimedJob } from './runner-client.js';
import { executeJobLocally } from './execute-job-locally.js';
import { maintainBareClones } from './repo-clone.js';

const MAINTENANCE_TICKS = 60;
// How long the long-poll request blocks server-side. Must match the route's
// MAX_WAIT_SEC cap (see /api/runner/jobs/route.ts). The HTTP client adds
// 5s of slack on top.
const LONG_POLL_WAIT_SEC = 25;
// Brief sleep when at concurrency cap so we don't busy-loop. The heartbeat
// timer runs independently, so leases keep getting renewed during this nap.
const AT_CAPACITY_SLEEP_MS = 250;

export interface RunnerDaemonConfig {
  url: string;
  token: string;
  /** Backends this runner advertises (and the `claim` filter). */
  backends: string[];
  kind: 'cloud' | 'self-hosted';
  /** Max concurrent jobs. Default 1. */
  concurrency?: number;
  /** Seconds between claim attempts (and the heartbeat is sent every other tick). Default 1. */
  pollIntervalSec?: number;
}

interface InFlight {
  jobId: string;
  workflowRunId: string;
  pause: boolean;
  cancel: boolean;
  /** Phase 3: set when the SaaS heartbeat reports our lease was NOT renewed
   *  for this job — the watchdog has reclaimed it. Treated like a cancel:
   *  the engine's between-step probe stops the run promptly. */
  leaseLost: boolean;
  done: Promise<void>;
}

/**
 * The runner loop: long-polls the SaaS for jobs it can serve, runs them locally
 * (streaming events back), heartbeats so the watchdog knows it's alive, and on
 * SIGINT/SIGTERM stops claiming, lets in-flight jobs finish (grace timeout),
 * sends a final `offline` heartbeat.
 *
 * Pause/cancel reach a running job via the heartbeat reply (`cancelJobIds` /
 * `pauseRunIds`) — no separate poll. The daemon flips a per-job flag the job's
 * pause/cancel probes read between steps.
 */
export class RunnerDaemon {
  private readonly client: RunnerClient;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private idleTicks = 0;

  constructor(private readonly cfg: RunnerDaemonConfig) {
    this.client = new RunnerClient(cfg.url, cfg.token);
    this.concurrency = Math.max(1, cfg.concurrency ?? 1);
    this.pollMs = Math.max(1000, (cfg.pollIntervalSec ?? 1) * 1000);
  }

  async start(): Promise<void> {
    process.on('SIGINT', () => { void this.shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void this.shutdown('SIGTERM'); });

    console.log(`[runner] starting — kind=${this.cfg.kind} backends=${this.cfg.backends.join(',')} concurrency=${this.concurrency}`);
    await this.heartbeat('online');

    // Heartbeat cadence stays at 2x pollMs (default 2s). With a 60s lease the
    // SaaS sees ~30 renewals per window — plenty of slack for a hiccup. Lease
    // renewal lives in the heartbeat (carries `inflightJobIds`), so the
    // cadence is now lease-critical and MUST NOT be loosened.
    this.heartbeatTimer = setInterval(() => { void this.heartbeat('online'); }, this.pollMs * 2);

    // Pump loop: replaces the 1s setInterval short-poll with a long-poll
    // (LISTEN/NOTIFY on the SaaS side, migration 0025). After every response
    // (claim or 25s timeout) we immediately loop again — no extra setTimeout
    // wake-up needed. When at concurrency cap we nap briefly so the heartbeat
    // still gets airtime and we don't burn CPU.
    const pump = async (): Promise<void> => {
      while (!this.stopping) {
        try {
          if (this.inFlight.size >= this.concurrency) {
            await sleep(AT_CAPACITY_SLEEP_MS);
            continue;
          }
          const claimedAny = await this.claimAndRun();
          if (!claimedAny && this.inFlight.size === 0) {
            this.idleTicks++;
            if (this.idleTicks >= MAINTENANCE_TICKS) {
              this.idleTicks = 0;
              void maintainBareClones().catch((err) => {
                console.error('[runner] bare-clone maintenance failed:', err instanceof Error ? err.message : err);
              });
            }
          } else {
            this.idleTicks = 0;
          }
        } catch (err) {
          console.error('[runner] claim tick failed:', err instanceof Error ? err.message : err);
          if (err instanceof Error && err.message.includes('(401)')) { await this.shutdown('auth-error'); return; }
          // Back off briefly on unexpected errors so we don't hot-spin if the
          // SaaS is returning 5xx.
          await sleep(this.pollMs);
        }
      }
    };
    void pump();

    // Keep the process alive until shutdown resolves.
    await new Promise<void>((resolve) => { this.resolveExit = resolve; });
  }

  private resolveExit: (() => void) | null = null;

  private async claimAndRun(): Promise<boolean> {
    let claimedAny = false;
    while (this.inFlight.size < this.concurrency && !this.stopping) {
      // Long-poll for the first attempt too: the route does a single
      // claim_next_job_for_runner immediately, so an already-queued job comes
      // back fast; only the no-work case blocks on LISTEN/NOTIFY. After a
      // successful claim we loop right back in case a backlog exists — the
      // next call may again be immediate (short-circuit) or blocking.
      const claimed = await this.client.claimJob(this.cfg.backends, { wait: LONG_POLL_WAIT_SEC });
      if (!claimed) return claimedAny;
      this.runJob(claimed);
      claimedAny = true;
    }
    return claimedAny;
  }

  private runJob(claimed: ClaimedJob): void {
    const entry: InFlight = {
      jobId: claimed.job.id,
      workflowRunId: claimed.workflowRunId,
      pause: false,
      cancel: false,
      leaseLost: false,
      done: Promise.resolve(),
    };
    this.inFlight.set(claimed.job.id, entry);
    console.log(`[runner] running job ${claimed.job.id} (${claimed.job.kind} #${claimed.job.issueNumber ?? '?'})`);
    entry.done = executeJobLocally(this.client, claimed, {
      shouldPause: () => entry.pause, // shutdown does NOT pause — in-flight jobs run to completion
      // A lost lease is treated like a cancel: the SaaS has already re-queued
      // the job (or it's about to), so we abort to avoid double-execution
      // when another runner picks it up.
      shouldCancel: () => entry.cancel || entry.leaseLost,
    }).catch((err) => {
      console.error(`[runner] job ${claimed.job.id} crashed:`, err instanceof Error ? err.message : err);
    }).finally(() => {
      this.inFlight.delete(claimed.job.id);
      console.log(`[runner] job ${claimed.job.id} finished (${this.inFlight.size} in flight)`);
    });
  }

  private async heartbeat(status: 'online' | 'draining' | 'offline'): Promise<void> {
    const inflight = [...this.inFlight.keys()];
    try {
      const reply = await this.client.heartbeat({
        status,
        inflightJobIds: inflight,
        // Keep `currentJobIds` populated for SaaS deployments that haven't
        // taken the 0025 heartbeat update yet.
        currentJobIds: inflight,
      });
      for (const jobId of reply.cancelJobIds ?? []) {
        const e = this.inFlight.get(jobId);
        if (e && !e.cancel) { e.cancel = true; console.log(`[runner] cancel requested for job ${jobId}`); }
      }
      for (const runId of reply.pauseRunIds ?? []) {
        for (const e of this.inFlight.values()) {
          if (e.workflowRunId === runId && !e.pause) { e.pause = true; console.log(`[runner] pause requested for run ${runId}`); }
        }
      }
      // Phase 3 lease accounting. An older SaaS omits `renewedJobIds` entirely
      // (undefined) — treat that as "all renewed" so we stay compatible. A
      // newer SaaS returns the subset it actually renewed; everything missing
      // means the watchdog has reclaimed the job and we must abort.
      if (inflight.length > 0 && reply.renewedJobIds !== undefined) {
        const renewed = new Set(reply.renewedJobIds);
        for (const jobId of inflight) {
          if (renewed.has(jobId)) continue;
          const e = this.inFlight.get(jobId);
          if (e && !e.leaseLost) {
            e.leaseLost = true;
            console.warn(`[runner] lost lease for job ${jobId} — aborting (likely watchdog reclaim)`);
          }
        }
      }
    } catch (err) {
      console.error('[runner] heartbeat failed:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.message.includes('(401)')) await this.shutdown('auth-error');
    }
  }

  private async shutdown(why: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    console.log(`[runner] shutting down (${why}) — ${this.inFlight.size} job(s) in flight`);
    // The pump loop drains via its `while (!this.stopping)` guard — no
    // dedicated timer to cancel anymore.
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeat('draining').catch(() => {});

    // Grace period for in-flight jobs.
    const GRACE_MS = 5 * 60_000;
    const pending = [...this.inFlight.values()].map((e) => e.done);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, GRACE_MS)),
    ]);
    if (this.inFlight.size > 0) {
      console.warn(`[runner] ${this.inFlight.size} job(s) still running at grace timeout — leaving them for the watchdog`);
    }
    await this.heartbeat('offline').catch(() => {});
    this.resolveExit?.();
    // Give the final heartbeat a beat to flush, then exit.
    setTimeout(() => process.exit(0), 250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
