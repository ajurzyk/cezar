import { NextResponse } from 'next/server';
import { authRunner } from '../_auth';
import type { Database, RunnerStatus } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HeartbeatBody {
  status?: RunnerStatus;
  /** Legacy field — kept for older runners; the daemon now also sends
   *  `inflightJobIds`. Either is acceptable. */
  currentJobIds?: string[];
  /** Phase 3: ids of jobs the runner currently has in flight. The route
   *  bulk-renews their leases via `renew_claim_leases` and returns the ids
   *  it was actually able to renew — anything missing means the runner has
   *  lost the claim and should abort that job. */
  inflightJobIds?: string[];
  /** Phase 4 (migration 0026) — runner self-describes its GitHub identity
   *  mode. The route upserts these onto the `runners` row so the next claim
   *  picks the right minter without admin-GUI setup. Precedence: when
   *  `githubInheritHost` is true, `githubInstallationId` is ignored. */
  githubInheritHost?: boolean;
  githubInstallationId?: number | null;
}

interface HeartbeatRpcRow {
  cancel_job_ids: string[] | null;
  pause_run_ids: string[] | null;
}

interface RenewRow {
  renewed_id: string;
}

/**
 * POST /api/runner/heartbeat  { status?, inflightJobIds? }
 *
 * Refreshes the runner's `last_heartbeat_at`/`status`, renews leases for the
 * in-flight job ids the runner reports, and tells it which of its jobs/runs
 * the operator has asked to cancel/pause (the runner has no other channel
 * for that). The lease renewal replaces the old 3-minute runner-offline
 * blind window — see migration 0025.
 *
 * Implemented as two RPCs: `runner_heartbeat` (one round-trip; cancel/pause
 * signals) + `renew_claim_leases` (one round-trip; bulk lease bump). Both
 * use the service-role admin client.
 */
export async function POST(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  let body: HeartbeatBody = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const status: RunnerStatus = body.status ?? 'online';
  const inflight = body.inflightJobIds ?? body.currentJobIds ?? [];

  const { data, error } = await admin.rpc('runner_heartbeat', {
    p_runner_id: runner.id,
    p_status: status,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Phase 4 (migration 0026) — runner self-describes its GitHub identity.
  // Only update fields the runner actually sent, so older daemons (and
  // admin-GUI-configured runners) aren't clobbered. The route never echoes
  // the identity back; the claim route reads `runners.*` fresh per claim.
  if (body.githubInheritHost !== undefined || body.githubInstallationId !== undefined) {
    const patch: Database['public']['Tables']['runners']['Update'] = {};
    if (body.githubInheritHost !== undefined) {
      patch.github_inherit_host = body.githubInheritHost;
    }
    if (body.githubInstallationId !== undefined) {
      // null clears the per-runner install; a number sets it. The claim
      // route enforces precedence (inherit_host wins).
      patch.github_installation_id = body.githubInstallationId;
    }
    const changed =
      patch.github_inherit_host !== runner.github_inherit_host ||
      patch.github_installation_id !== runner.github_installation_id;
    if (changed) {
      const { error: upErr } = await admin.from('runners').update(patch).eq('id', runner.id);
      if (upErr) {
        console.error('[runner-api] runner identity upsert failed:', upErr.message);
      }
    }
  }

  // PostgREST returns `setof record` functions as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as HeartbeatRpcRow | null | undefined;
  const cancelJobIds = row?.cancel_job_ids ?? [];
  const pauseRunIds  = row?.pause_run_ids  ?? [];

  // Bulk-renew leases. Only renews rows still claimed_by_runner = this runner
  // AND status ∈ ('claimed','running') — so a watchdog-reclaimed job won't be
  // re-leased back. The runner uses the diff (sent vs. renewed) to detect
  // lost claims and abort those jobs.
  let renewedJobIds: string[] = [];
  if (inflight.length > 0) {
    const { data: rows, error: renewErr } = await admin.rpc('renew_claim_leases', {
      p_runner_id: runner.id,
      p_job_ids: inflight,
    });
    if (renewErr) {
      console.error('[runner-api] renew_claim_leases failed:', renewErr.message);
    } else {
      renewedJobIds = ((rows ?? []) as RenewRow[]).map((r) => r.renewed_id);
    }
  }

  return NextResponse.json({ ok: true, cancelJobIds, pauseRunIds, renewedJobIds });
}
