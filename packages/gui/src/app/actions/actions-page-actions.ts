'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { seedDefaultActions } from '@/lib/seed-default-actions';

export interface SeedDefaultsResult {
  ok: boolean;
  error?: string;
}

/**
 * Refreshes the built-in actions from the shipped catalog (`DEFAULT_ACTIONS`
 * in `@cezar/core`): restores any that were deleted, inserts any newly
 * shipped ones, and updates existing built-in rows in place to the current
 * prompts/config. Idempotent — an upsert on `(workspace_id, name, kind)`.
 * User-kind rows (including overrides of built-ins) are untouched.
 */
export async function seedDefaultsForCurrentWorkspace(): Promise<SeedDefaultsResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync defaults' };

  const supabase = createSupabaseAdminClient();
  const result = await seedDefaultActions(supabase, workspace.id);
  if (!result.ok) return result;
  revalidatePath('/actions');
  return { ok: true };
}
