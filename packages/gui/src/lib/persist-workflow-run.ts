import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentRunRecord } from '@cezar/core';
import type { Database, AgentRunEventType } from './supabase/types';

type AgentRunsRow = Database['public']['Tables']['agent_runs']['Row'];

export interface CreateWorkflowRunOpts {
  workspaceId: string;
  jobId?: string | null;
  /**
   * The `workflow_runs.workflow` column — plain text. Built-ins are 'autofix',
   * 'ci-followup', 'triage'; the legacy single-action path uses 'single-action';
   * custom data-driven workflows carry their descriptor id (e.g. 'autofix-lite').
   */
  workflow: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber?: number | null;
  /**
   * Reports a per-write persistence failure (Supabase rejection / network blip).
   * The persister itself never throws on writes — failures here are best-effort
   * by design (a workflow run shouldn't die because one event insert failed).
   * Callers can hook this to log, surface in their legacy event channel, etc.
   */
  onPersistError?: (label: string, err: unknown) => void;
}

/**
 * The shared `workflow_runs` / `agent_runs` / `agent_run_events` persister.
 * `execute-workflow-job.ts` (the cron dispatch path) builds one and writes
 * through it; the runner-finalize API does its own thinner writes today.
 *
 * Designed for fire-and-forget callers — every write is wrapped in a `safe(...)`
 * try/catch so a transient Supabase error never propagates and kills the run.
 * The pause/cancel probes are simple re-reads of the same row.
 */
export interface WorkflowRunPersister {
  /** The `workflow_runs.id` this persister writes against. Null when the initial insert failed. */
  readonly id: string | null;
  /**
   * Open an `agent_runs` row with `status='running'` for a step that's about
   * to execute, then emit a matching `step-start` event so the cockpit can
   * render the step card and the ▶ marker as work begins (instead of waiting
   * for the step to finish). Upserts on `(workflow_run_id, step_id,
   * iteration)` — re-deliveries don't double-insert. Best-effort.
   */
  recordStepStart(record: AgentRunRecord): Promise<void>;
  /**
   * Close the `agent_runs` row opened by `recordStepStart` (or insert it
   * outright when no start was delivered — the previous fallback path),
   * then emit a matching `step-end` event tagged with that row's id and
   * bump `workflow_runs.current_step_id` to this step. Best-effort.
   */
  recordAgentRun(record: AgentRunRecord): Promise<void>;
  /** Append one `agent_run_events` row (best-effort). */
  recordEvent(type: AgentRunEventType, payload: unknown, agentRunId?: string | null): Promise<void>;
  /** Update the `workflow_runs` row with the supplied patch (best-effort). */
  finalize(patch: Database['public']['Tables']['workflow_runs']['Update']): Promise<void>;
  /** Convenience: mark the run failed with `reason` and `finished_at = now`. */
  fail(reason: string): Promise<void>;
  /** True when the `workflow_runs.pause_requested` flag is set. */
  isPauseRequested(): Promise<boolean>;
  /** True when the `workflow_runs.status` has been flipped to `'cancelled'`. */
  isCancelled(): Promise<boolean>;
}

/**
 * Inserts the `workflow_runs` row and returns a persister bound to it.
 * If the insert fails the returned persister's `id` is null and all subsequent
 * writes are no-ops — callers don't need to special-case that.
 */
export async function createWorkflowRunPersister(
  supabase: SupabaseClient<Database>,
  opts: CreateWorkflowRunOpts,
): Promise<WorkflowRunPersister> {
  const { workspaceId, jobId, workflow, repo, issueNumber, prNumber, onPersistError } = opts;

  const safe = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); } catch (err) {
      if (onPersistError) onPersistError(label, err);
      else console.error(`[persist-workflow-run] ${label} failed:`, err instanceof Error ? err.message : err);
    }
  };

  let workflowRunId: string | null = null;
  await safe('workflow_runs insert', async () => {
    const { data, error } = await supabase
      .from('workflow_runs')
      .insert({
        workspace_id: workspaceId,
        job_id: jobId ?? null,
        workflow,
        repo,
        issue_number: issueNumber,
        pr_number: prNumber ?? null,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw error;
    workflowRunId = data?.id ?? null;
  });

  const recordEvent: WorkflowRunPersister['recordEvent'] = async (type, payload, agentRunId) => {
    if (!workflowRunId) return;
    await safe(`event:${type}`, async () => {
      await supabase.from('agent_run_events').insert({
        workspace_id: workspaceId,
        workflow_run_id: workflowRunId!,
        agent_run_id: agentRunId ?? null,
        type,
        payload: payload as Database['public']['Tables']['agent_run_events']['Row']['payload'],
      });
    });
  };

  const recordStepStart: WorkflowRunPersister['recordStepStart'] = async (r) => {
    if (!workflowRunId) return;
    await safe('agent_runs step-start', async () => {
      // Upsert on the (workflow_run_id, step_id, iteration) unique key from
      // migration 0020 — a re-delivery is a no-op, and the row stays in
      // `running` until `recordAgentRun` closes it.
      const { data, error } = await supabase
        .from('agent_runs')
        .upsert(
          {
            workspace_id: workspaceId,
            workflow_run_id: workflowRunId!,
            step_id: r.stepId,
            iteration: r.iteration,
            kind: (r.kind ?? null) as AgentRunsRow['kind'],
            backend: r.backend,
            model: r.model,
            status: 'running',
            started_at: r.startedAt,
            tokens_used: 0,
          },
          { onConflict: 'workflow_run_id,step_id,iteration', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (error) throw error;
      await recordEvent(
        'step-start',
        { stepId: r.stepId, iteration: r.iteration },
        data?.id,
      );
      await supabase.from('workflow_runs').update({ current_step_id: r.stepId }).eq('id', workflowRunId!);
    });
  };

  const recordAgentRun: WorkflowRunPersister['recordAgentRun'] = async (r) => {
    if (!workflowRunId) return;
    await safe('agent_runs step-end', async () => {
      // Upsert closes the row opened by `recordStepStart` (or inserts it
      // outright if start wasn't delivered — the previous fallback path).
      const { data, error } = await supabase
        .from('agent_runs')
        .upsert(
          {
            workspace_id: workspaceId,
            workflow_run_id: workflowRunId!,
            step_id: r.stepId,
            iteration: r.iteration,
            kind: (r.kind ?? null) as AgentRunsRow['kind'],
            backend: r.backend,
            model: r.model,
            status: r.status === 'running' ? 'running' : r.status,
            started_at: r.startedAt,
            finished_at: r.finishedAt ?? null,
            tokens_used: r.tokensUsed,
            summary: r.summary ?? null,
            error: r.error ?? null,
          },
          { onConflict: 'workflow_run_id,step_id,iteration', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (error) throw error;
      await recordEvent(
        'step-end',
        { stepId: r.stepId, iteration: r.iteration, status: r.status, summary: r.summary, error: r.error },
        data?.id,
      );
      await supabase.from('workflow_runs').update({ current_step_id: r.stepId }).eq('id', workflowRunId!);
    });
  };

  const finalize: WorkflowRunPersister['finalize'] = async (patch) => {
    if (!workflowRunId) return;
    await safe('workflow_runs finalize', async () => {
      await supabase.from('workflow_runs').update(patch).eq('id', workflowRunId!);
    });
  };

  const fail: WorkflowRunPersister['fail'] = async (reason) => {
    if (!workflowRunId) return;
    await finalize({ status: 'failed', reason, finished_at: new Date().toISOString() });
  };

  const isPauseRequested = async (): Promise<boolean> => {
    if (!workflowRunId) return false;
    const { data } = await supabase
      .from('workflow_runs')
      .select('pause_requested')
      .eq('id', workflowRunId)
      .single();
    return data?.pause_requested === true;
  };

  const isCancelled = async (): Promise<boolean> => {
    if (!workflowRunId) return false;
    const { data } = await supabase
      .from('workflow_runs')
      .select('status')
      .eq('id', workflowRunId)
      .single();
    return data?.status === 'cancelled';
  };

  return {
    get id() { return workflowRunId; },
    recordStepStart,
    recordAgentRun,
    recordEvent,
    finalize,
    fail,
    isPauseRequested,
    isCancelled,
  };
}
