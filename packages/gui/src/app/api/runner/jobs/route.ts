import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { loadWorkspaceLabels } from '@/lib/load-workspace-labels';
import { authRunner } from '../_auth';
import type { Database } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type JobRow = Database['public']['Tables']['jobs']['Row'];

/**
 * GET /api/runner/jobs?backends=anthropic-api,claude-cli
 *
 * A runner long-polls this to claim work. We:
 *   1. refresh the runner's heartbeat,
 *   2. `claim_next_job_for_runner` (FOR UPDATE SKIP LOCKED) restricted to the
 *      requested backends,
 *   3. on a hit: build the merged workspace config (incl. a freshly-minted
 *      GitHub token), snapshot the issue store, create the `workflow_runs` row,
 *      mark the job `running`, and return everything the runner needs.
 *
 * Returns `{ job: null }` when there's nothing to do.
 */
export async function GET(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  // No heartbeat-on-poll: the daemon's dedicated `/api/runner/heartbeat` (now
  // a single RPC, migration 0020) is the single source of truth. The previous
  // double-write here was pure overhead per claim tick.

  const url = new URL(req.url);
  const requested = (url.searchParams.get('backends') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const backends = requested.length ? requested : runner.backends;
  if (backends.length === 0) return NextResponse.json({ job: null });

  const { data: claimed, error: claimErr } = await admin.rpc('claim_next_job_for_runner', {
    p_runner_id: runner.id,
    p_backends: backends,
    p_limit: 1,
  });
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  const job = ((claimed ?? []) as JobRow[])[0];
  if (!job) return NextResponse.json({ job: null });

  // From here on, any failure should release the job back to the queue so it
  // isn't stuck `claimed` until the watchdog.
  const releaseJob = async () => {
    await admin.from('jobs').update({ status: 'queued', claimed_by_runner: null, updated_at: new Date().toISOString() }).eq('id', job.id);
  };

  try {
    const core = await import('@cezar/core');

    // ── workspace + github token ──
    const { data: ws } = await admin.from('workspaces').select('repo_owner, repo_name').eq('id', job.workspace_id).single();
    if (!ws) throw new Error(`workspace ${job.workspace_id} not found`);
    const owner = ws.repo_owner;
    const repo = ws.repo_name;

    let githubToken: string | null = null;
    if (owner && core.GitHubAppService.isConfigured()) {
      try { githubToken = await new core.GitHubAppService().getInstallationToken(owner); }
      catch (err) { console.error(`[runner-api] installation token failed for ${owner}:`, err instanceof Error ? err.message : err); }
    }
    if (!githubToken) githubToken = await resolveWorkspaceToken(job.workspace_id, admin);
    if (!githubToken) throw new Error('no github token available for workspace');

    const config = await loadWorkspaceConfig(job.workspace_id, admin, { githubToken });
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };
    // The runner clones the repo itself — don't ship the SaaS's (local) repoRoot.
    config.autofix.repoRoot = '';

    // Workspace label catalog — shipped to the runner so the engine on the
    // self-hosted side gets the same per-step prompt augmentation as the cron
    // dispatcher (see execute-workflow-job.ts).
    const labels = await loadWorkspaceLabels(admin, job.workspace_id);

    // ── issue-store snapshot ──
    const adapter = new SupabaseStoreAdapter(admin, job.workspace_id);
    const store = await core.IssueStore.fromPort(adapter);
    const storeSnapshot = store.getAllData();

    const runIssueNumber = job.kind === 'ci-followup'
      ? ((job.payload as { ciFollowup?: { issueNumber?: number } })?.ciFollowup?.issueNumber ?? job.issue_number)
      : job.issue_number;

    // ── flow lookup ── For `kind='flow'` jobs the runner needs the flow's
    //   name + steps so it can build a Workflow and call runFlow. Load the
    //   row by `payload.flowId` here so the runner doesn't need DB access.
    //   `workflow_runs.workflow` becomes `flow:<name>` so the cockpit labels
    //   runner-driven flow runs the same way cron-driven ones look.
    type FlowPayload = { flowId?: string; flowInput?: string };
    let flowOut: { name: string; steps: import('@cezar/core').FlowStep[]; input: string } | null = null;
    let workflowLabel: string = job.kind;
    if (job.kind === 'flow') {
      const payload = (job.payload ?? {}) as FlowPayload;
      if (!payload.flowId) throw new Error('flow job missing payload.flowId');
      const { data: flowRow, error: fErr } = await admin
        .from('flows')
        .select('name, steps, paused')
        .eq('id', payload.flowId)
        .eq('workspace_id', job.workspace_id)
        .single();
      if (fErr || !flowRow) throw new Error(`flow ${payload.flowId} not found: ${fErr?.message ?? 'no row'}`);
      const parsedSteps = parseFlowSteps(flowRow.steps);
      flowOut = {
        name: flowRow.name,
        steps: parsedSteps,
        input: payload.flowInput ?? (runIssueNumber != null ? String(runIssueNumber) : ''),
      };
      workflowLabel = `flow:${flowRow.name}`;
    }

    // ── workflow_runs row ──
    const repoSlug = owner && repo ? `${owner}/${repo}` : job.repo;
    const { data: runRow, error: runErr } = await admin
      .from('workflow_runs')
      .insert({
        workspace_id: job.workspace_id,
        job_id: job.id,
        workflow: workflowLabel,
        repo: repoSlug,
        issue_number: runIssueNumber ?? null,
        pr_number: job.pr_number ?? null,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (runErr || !runRow) throw new Error(`workflow_runs insert failed: ${runErr?.message}`);

    await admin.from('jobs').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', job.id);

    const ciFollowupSeed = job.kind === 'ci-followup'
      ? (job.payload as { ciFollowup?: unknown })?.ciFollowup ?? null
      : null;

    return NextResponse.json({
      job: {
        id: job.id,
        workspaceId: job.workspace_id,
        repo: job.repo,
        kind: job.kind,
        issueNumber: job.issue_number,
        prNumber: job.pr_number,
        requiredBackend: job.required_backend,
      },
      workflowRunId: runRow.id,
      workspace: { id: job.workspace_id, owner, repo },
      // `config.github.token` IS included on purpose — the runner needs it; it's
      // already a short-lived/scoped token. No other secrets travel.
      config,
      githubToken,
      store: storeSnapshot,
      ciFollowupSeed,
      flow: flowOut,
      labels,
    });
  } catch (err) {
    await releaseJob().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error('[runner-api] /jobs failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Defensive parser for the `flows.steps` JSONB column — keeps the runner-API
 * contract clean even if a row was inserted by an older client. Mirrors the
 * GUI-side `parseSteps` in `app/workflows/actions.ts`.
 */
function parseFlowSteps(raw: unknown): import('@cezar/core').FlowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const obj = s as Record<string, unknown>;
      const step: import('@cezar/core').FlowStep = {
        skill: typeof obj.skill === 'string' ? obj.skill : '',
        argsTemplate: typeof obj.argsTemplate === 'string' ? obj.argsTemplate : '',
      };
      if (typeof obj.stopChainIfContains === 'string' && obj.stopChainIfContains) step.stopChainIfContains = obj.stopChainIfContains;
      if (typeof obj.systemNotes === 'string' && obj.systemNotes) step.systemNotes = obj.systemNotes;
      return step;
    })
    .filter((x): x is import('@cezar/core').FlowStep => x !== null);
}

/** Mirrors the per-workspace token lookup in the crons (`execute-workflow-job.ts`). */
async function resolveWorkspaceToken(
  workspaceId: string,
  admin: SupabaseClient<Database>,
): Promise<string | null> {
  const { data: admins } = await admin.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await admin.from('user_github_tokens').select('provider_token').in('user_id', ids).limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  return process.env.GITHUB_TOKEN || null;
}
