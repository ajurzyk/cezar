import { NextResponse } from 'next/server';
import { authRunner } from '../_auth';
import type { RunnerStatus } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HeartbeatBody {
  status?: RunnerStatus;
  currentJobIds?: string[];
}

interface HeartbeatRpcRow {
  cancel_job_ids: string[] | null;
  pause_run_ids: string[] | null;
}

/**
 * POST /api/runner/heartbeat  { status?, currentJobIds? }
 *
 * Refreshes the runner's `last_heartbeat_at`/`status` and tells it which of its
 * jobs/runs the operator has asked to cancel/pause (the runner has no other
 * channel for that).
 *
 * Implemented as a single `runner_heartbeat` RPC (migration 0020) — previously
 * this was four sequential statements, which caused the bimodal 200ms / 10-16s
 * tail latency we hit at multi-runner scale.
 */
export async function POST(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  let body: HeartbeatBody = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const status: RunnerStatus = body.status ?? 'online';

  const { data, error } = await admin.rpc('runner_heartbeat', {
    p_runner_id: runner.id,
    p_status: status,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // PostgREST returns `setof record` functions as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as HeartbeatRpcRow | null | undefined;
  const cancelJobIds = row?.cancel_job_ids ?? [];
  const pauseRunIds  = row?.pause_run_ids  ?? [];

  return NextResponse.json({ ok: true, cancelJobIds, pauseRunIds });
}
