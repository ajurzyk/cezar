'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';

export interface SaveAutomationState {
  ok?: boolean;
  error?: string;
}

/** Allowed automatic-sync cadences (minutes); floored at 5 (the cron tick). */
const SYNC_INTERVAL_MIN = 5;
const SYNC_INTERVAL_MAX = 1440;

/**
 * The automation toggles on `workspaces`:
 *   - `auto_triage_enabled` — run the triage workflow on new/edited issues.
 *   - `autofix_enabled` — when a triage run routes to `autofix` (and the bug
 *     confidence clears the threshold), open a draft PR automatically.
 *   - `separate_comment_per_step` — render each workflow step as its own comment
 *     instead of one living comment.
 *   - `action_auto_comment` — post a summary comment after each action.
 *   - `sync_mode` / `sync_interval_minutes` — auto vs. manual GitHub sync and,
 *     for auto, the minimum gap between automatic syncs.
 * Admin-only.
 */
export async function saveAutomationToggles(
  _prev: SaveAutomationState,
  formData: FormData,
): Promise<SaveAutomationState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can change automation settings' };

  const bool = (key: string): boolean => formData.get(key) === 'on' || formData.get(key) === 'true';

  const update: Record<string, unknown> = {
    auto_triage_enabled: bool('autoTriageEnabled'),
    autofix_enabled: bool('autofixEnabled'),
    separate_comment_per_step: bool('separateCommentPerStep'),
    action_auto_comment: bool('actionAutoComment'),
    sync_mode: bool('syncAuto') ? 'auto' : 'manual',
  };

  // The interval field is only rendered in auto mode; when present, clamp it to
  // the allowed range. When absent (manual), leave the stored value untouched.
  const rawInterval = formData.get('syncIntervalMinutes');
  if (rawInterval != null) {
    const parsed = Number(rawInterval);
    if (Number.isFinite(parsed)) {
      update.sync_interval_minutes = Math.min(SYNC_INTERVAL_MAX, Math.max(SYNC_INTERVAL_MIN, Math.round(parsed)));
    }
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('workspaces')
    .update(update)
    .eq('id', workspace.id);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
