import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ACTIONS } from '@cezar/core';
import type { Database, Json } from './supabase/types';

/**
 * Seed (or refresh) the built-in Action catalog for a workspace from the
 * shipped TS catalog (`DEFAULT_ACTIONS` in `@cezar/core`).
 *
 * This replaced the `seed_default_actions(uuid)` SQL function (dropped in
 * migration 0044) — the TS catalog is the single seed definition, so newly
 * shipped prompt/config changes propagate on the next seed call instead of
 * requiring a hand-synced migration.
 *
 * Behaviour:
 *   - Upserts every catalog spec as a `kind='built-in'` row, keyed on the
 *     `(workspace_id, name, kind)` unique constraint — inserts missing rows
 *     and overwrites existing built-in rows in place. Built-ins are
 *     RLS-locked from user edits, so overwriting them is safe; user
 *     overrides are separate `kind='user'` rows and untouched.
 *   - Never writes `suggested_flow_id` or `effect_routing` — those are
 *     per-workspace user choices (Phase 5), preserved across re-seeds.
 *   - Points `workspaces.auto_triage_action_id` at the `auto-triage`
 *     built-in only when the pointer is currently NULL.
 *
 * Never throws — returns `{ ok: false, error }` so call sites can keep
 * their log-and-continue semantics (a workspace is usable without actions).
 */
export async function seedDefaultActions(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const rows: Database['public']['Tables']['actions']['Insert'][] = DEFAULT_ACTIONS.map(
      (spec) => ({
        workspace_id: workspaceId,
        name: spec.name,
        kind: 'built-in' as const,
        description: spec.description,
        system_prompt: spec.systemPrompt,
        skill_refs: spec.skillRefs as Json,
        context_refs: (spec.contextRefs ?? []) as Json,
        target: spec.target,
        triggers: spec.triggers as Json,
        effects: spec.effects as Json | null,
        output_schema: (spec.outputSchema ?? null) as Json | null,
        enabled: spec.enabled,
        // Specs without explicit acceptance config get the column defaults
        // from migration 0018 ('auto' / {"autoAcceptAbove": 0}).
        acceptance_mode: spec.acceptanceMode ?? 'auto',
        confidence_config: (spec.confidenceConfig ?? { autoAcceptAbove: 0 }) as unknown as Json,
      }),
    );

    const { error: upsertErr } = await supabase
      .from('actions')
      .upsert(rows, { onConflict: 'workspace_id,name,kind' });
    if (upsertErr) return { ok: false, error: upsertErr.message };

    // Point the workspace's auto-triage pointer at the built-in row, but only
    // when it is currently unset — an existing pointer (e.g. at a user
    // override) is a deliberate choice and must survive re-seeding.
    const { data: triageRow, error: lookupErr } = await supabase
      .from('actions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('name', 'auto-triage')
      .eq('kind', 'built-in')
      .maybeSingle();
    if (lookupErr) return { ok: false, error: lookupErr.message };

    if (triageRow) {
      const { error: ptrErr } = await supabase
        .from('workspaces')
        .update({ auto_triage_action_id: triageRow.id })
        .eq('id', workspaceId)
        .is('auto_triage_action_id', null);
      if (ptrErr) return { ok: false, error: ptrErr.message };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
