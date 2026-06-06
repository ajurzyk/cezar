import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { runDispatch } from '@/lib/scheduler/run-dispatch';
import { requireCronSecret } from '@/lib/scheduler/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Phase 3c dispatcher (docs §3.7). The route is a thin auth shim around
// `runDispatch`, driven by the in-process scheduler (the sole cron driver; see
// `lib/scheduler/in-process-scheduler.ts`). It stays an HTTP route so the
// scheduler can hit it over loopback and so it can be invoked manually.
export async function GET(req: Request) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runDispatch(supabase);
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}
