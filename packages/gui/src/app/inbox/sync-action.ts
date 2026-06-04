'use server';

import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncCounts, SyncPhase, SyncStatusState } from '@/lib/supabase/types';

// ─────────────────────────────────────────────────────────────────────
// Sync & Digest — the global "pull from GitHub" action shared by the
// Inbox and Issues page headers.
//
// The four phases (fetch issues → digest → fetch comments → refresh PRs)
// are external-API-bound and can take 30s–2min. Running them inline in the
// server action used to block the whole UI (Next.js serializes server
// actions, so navigations + router.refresh() queued behind it). Instead we
// now do a fast in-request kickoff (auth + a row flip) and run the phases as
// a detached background task that writes its progress into `sync_status`.
// The client subscribes to that row over Realtime to show live progress and
// refreshes when it lands on 'done'/'error'. The app is a long-lived Node
// container (output: 'standalone', Docker/Dokploy), so a non-awaited promise
// keeps running safely after the action returns.
// ─────────────────────────────────────────────────────────────────────

/** A `syncing` row older than this is treated as stale (e.g. the container
 *  restarted mid-sync) and may be overwritten by a fresh sync. */
const STALE_SYNC_MS = 10 * 60 * 1000;

export interface SyncResult {
  /** True once the background sync has been kicked off (not when it finishes). */
  ok: boolean;
  error?: string;
}

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

async function writeStatus(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  patch: {
    status: SyncStatusState;
    phase?: SyncPhase | null;
    message?: string | null;
    counts?: SyncCounts;
    error?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from('sync_status')
    .upsert({ workspace_id: workspaceId, ...patch }, { onConflict: 'workspace_id' });
  if (error) console.warn('[syncAndDigest] sync_status write failed:', error.message);
}

export async function syncAndDigest(): Promise<SyncResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync' };

  const supabase = createSupabaseAdminClient();

  // ── Concurrency guard: refuse to start a second sync while one is live. ──
  // A `syncing` row older than STALE_SYNC_MS is considered abandoned and is
  // allowed to be overwritten.
  const { data: existing } = await supabase
    .from('sync_status')
    .select('status, updated_at')
    .eq('workspace_id', workspace.id)
    .maybeSingle<Pick<SyncStatusRow, 'status' | 'updated_at'>>();
  if (existing?.status === 'syncing') {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < STALE_SYNC_MS) {
      return { ok: false, error: 'Sync already in progress' };
    }
  }

  const core = await import('@cezar/core');
  let token = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch (err) {
      console.warn('[syncAndDigest] GitHub App token failed, falling back to OAuth:', err);
    }
  }
  if (!token) return { ok: false, error: 'No GitHub token — sign out and back in to sync' };

  const adapter = new SupabaseStoreAdapter(supabase, workspace.id);

  // The store may be empty for a newly-connected workspace; tolerate that
  // by seeding an empty store rather than failing the sync.
  let store: Awaited<ReturnType<typeof core.IssueStore.fromPort>>;
  try {
    store = await core.IssueStore.fromPort(adapter);
  } catch {
    store = await core.IssueStore.fromPort({
      async load() {
        return {
          meta: {
            owner: workspace.repoOwner,
            repo: workspace.repoName,
            lastSyncedAt: null,
            totalFetched: 0,
            version: 1 as const,
            orgMembers: [],
            orgMembersFetchedAt: null,
          },
          issues: [],
        };
      },
      async save(data) {
        await adapter.save(data);
      },
    });
  }

  let config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  try {
    config = await loadWorkspaceConfig(workspace.id, supabase, {
      githubToken: token,
      repoOwner: workspace.repoOwner,
      repoName: workspace.repoName,
    });
  } catch (err) {
    return { ok: false, error: `Config load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const github = new core.GitHubService(config);

  // ── Flip the row to 'syncing' before we return, so the client sees the
  //    spinner immediately and the concurrency guard above is armed. ──
  await writeStatus(supabase, workspace.id, {
    status: 'syncing',
    phase: 'issues',
    message: 'Fetching issues…',
    counts: {},
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  });

  // ── Run the four phases in the background; do NOT await. ──
  void runSync({ supabase, workspaceId: workspace.id, store, github, config, llm: core.LLMService }).catch(
    async (err) => {
      console.error('[syncAndDigest] background sync crashed:', err);
      await writeStatus(supabase, workspace.id, {
        status: 'error',
        phase: null,
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      });
    },
  );

  return { ok: true };
}

interface RunSyncArgs {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  store: Awaited<ReturnType<(typeof import('@cezar/core'))['IssueStore']['fromPort']>>;
  github: InstanceType<(typeof import('@cezar/core'))['GitHubService']>;
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  llm: (typeof import('@cezar/core'))['LLMService'];
}

/** The four serial sync phases, each writing its progress into `sync_status`.
 *  Phase 1 is fatal-on-error; phases 2–4 are best-effort (warn + continue)
 *  so a digest/comment/PR hiccup still produces a usable sync. */
async function runSync({ supabase, workspaceId, store, github, config, llm: LLMService }: RunSyncArgs): Promise<void> {
  const counts: SyncCounts = {};

  // ── 1. Fetch issues (incremental when possible) ──
  try {
    const meta = store.getMeta();
    const issues = meta.lastSyncedAt
      ? await github.fetchIssuesSince(meta.lastSyncedAt, false)
      : await github.fetchAllIssues(false);
    counts.issuesFetched = issues.length;
    counts.issuesCreated = 0;
    counts.issuesUpdated = 0;
    for (const issue of issues) {
      const r = store.upsertIssue(issue);
      if (r.action === 'created') counts.issuesCreated += 1;
      if (r.action === 'updated') counts.issuesUpdated += 1;
    }
    store.updateMeta({
      lastSyncedAt: new Date().toISOString(),
      totalFetched: issues.length,
    });
    await store.save();
  } catch (err) {
    await writeStatus(supabase, workspaceId, {
      status: 'error',
      phase: null,
      counts,
      error: `Issue fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  // ── 2. Generate digests for issues that don't have one yet ──
  try {
    const needDigest = store.getIssues({ hasDigest: false });
    if (needDigest.length > 0) {
      await writeStatus(supabase, workspaceId, {
        status: 'syncing',
        phase: 'digests',
        message: `Digesting ${needDigest.length} issue${needDigest.length === 1 ? '' : 's'}…`,
        counts,
      });
      const service = new LLMService(config);
      const issueData = needDigest.map((i) => ({ number: i.number, title: i.title, body: i.body }));
      const results = await service.generateDigests(issueData, config.sync.digestBatchSize);
      for (const [number, digest] of results) {
        store.setDigest(number, digest);
      }
      counts.digestsCreated = results.size;
      await store.save();
    }
  } catch (err) {
    // Digest failure shouldn't abort the whole sync — comments + PR pull are
    // still useful, and the user can retry to fill in the rest.
    console.warn('[syncAndDigest] digest pass failed:', err);
  }

  // ── 3. Fetch comments for open issues that need them ──
  try {
    const needComments = store
      .getIssues({ state: 'open' })
      .filter((i) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      await writeStatus(supabase, workspaceId, {
        status: 'syncing',
        phase: 'comments',
        message: `Fetching comments for ${needComments.length} issue${needComments.length === 1 ? '' : 's'}…`,
        counts,
      });
      const commentMap = await github.fetchCommentsForIssues(needComments.map((i) => i.number));
      for (const [num, comments] of commentMap) {
        store.setComments(num, comments);
      }
      counts.commentsFetched = commentMap.size;
      await store.save();
    }
  } catch (err) {
    console.warn('[syncAndDigest] comments pass failed:', err);
  }

  // ── 4. Refresh open PRs into the pull_requests table ──
  try {
    await writeStatus(supabase, workspaceId, {
      status: 'syncing',
      phase: 'prs',
      message: 'Refreshing pull requests…',
      counts,
    });
    const openPrs = await github.listOpenPullRequests();
    if (openPrs.length > 0) {
      const rows = openPrs.map((p) => ({
        workspace_id: workspaceId,
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        draft: p.draft,
        labels: p.labels,
        author: p.author,
        html_url: p.htmlUrl,
        head_sha: p.headSha,
        head_ref: p.headRef,
        base_ref: p.baseRef,
        pr_created_at: p.createdAt,
        pr_updated_at: p.updatedAt,
      }));
      const { error } = await supabase
        .from('pull_requests')
        .upsert(rows, { onConflict: 'workspace_id,number' });
      if (!error) counts.prsUpdated = openPrs.length;
    }
  } catch (err) {
    console.warn('[syncAndDigest] PR sync failed:', err);
  }

  // ── Done. ──
  await writeStatus(supabase, workspaceId, {
    status: 'done',
    phase: null,
    message: summarize(counts),
    counts,
    error: null,
    finished_at: new Date().toISOString(),
  });
}

function summarize(counts: SyncCounts): string {
  const bits: string[] = [];
  if (counts.issuesFetched) {
    bits.push(
      `${counts.issuesFetched} issue${counts.issuesFetched === 1 ? '' : 's'} (${counts.issuesCreated ?? 0} new · ${counts.issuesUpdated ?? 0} updated)`,
    );
  }
  if (counts.digestsCreated) bits.push(`${counts.digestsCreated} digested`);
  if (counts.commentsFetched) bits.push(`${counts.commentsFetched} commented`);
  if (counts.prsUpdated) bits.push(`${counts.prsUpdated} PR${counts.prsUpdated === 1 ? '' : 's'}`);
  return bits.length > 0 ? `Synced: ${bits.join(' · ')}` : 'Already up to date';
}
