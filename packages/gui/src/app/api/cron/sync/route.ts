import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { runSyncSweep } from '@/lib/scheduler/run-sync-sweep';
import { requireCronSecret } from '@/lib/scheduler/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Unified-sync sweep (Phase B). Thin auth shim around `runSyncSweep` —
// enqueues one deduped `sync` job per workspace; the dispatch worker runs the
// shared sync engine. Same logic is also called by the in-process scheduler in
// self-hosted Node deployments (see `lib/scheduler/in-process-scheduler.ts`).
export async function GET(req: Request) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runSyncSweep(supabase);
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}
