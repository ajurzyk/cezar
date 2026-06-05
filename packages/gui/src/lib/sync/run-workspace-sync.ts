import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncCounts, SyncPhase, SyncStatusState } from '@/lib/supabase/types';

// ─────────────────────────────────────────────────────────────────────
// Shared workspace-sync core — the four-phase "pull from GitHub" pipeline
// (fetch issues → digest → fetch comments → refresh PRs), factored out of
// the Inbox `syncAndDigest` server action so BOTH that action AND a future
// cron/job worker can run the exact same sync, writing progress into the
// `sync_status` table.
//
// This is a plain server-side lib (NOT a `'use server'` file), so it can
// export constants + helpers in addition to async functions.
// ─────────────────────────────────────────────────────────────────────

/** A `syncing` row older than this is treated as stale (e.g. the container
 *  restarted mid-sync) and may be overwritten by a fresh sync. */
export const STALE_SYNC_MS = 10 * 60 * 1000;

export async function writeSyncStatus(
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
  if (error) console.warn('[sync] sync_status write failed:', error.message);
}

export interface BuildSyncContextArgs {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  token: string;
}

export interface SyncContext {
  store: Awaited<ReturnType<(typeof import('@cezar/core'))['IssueStore']['fromPort']>>;
  github: InstanceType<(typeof import('@cezar/core'))['GitHubService']>;
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
}

/** Build the store / config / github trio used to run a workspace sync.
 *  Tolerates an empty store (newly-connected workspace) by seeding an empty
 *  one. Throws on config-load failure — callers handle. */
export async function buildSyncContext({
  supabase,
  workspaceId,
  repoOwner,
  repoName,
  token,
}: BuildSyncContextArgs): Promise<SyncContext> {
  const core = await import('@cezar/core');

  const adapter = new SupabaseStoreAdapter(supabase, workspaceId);

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
            owner: repoOwner,
            repo: repoName,
            lastSyncedAt: null,
            fullSyncedAt: null,
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

  const config = await loadWorkspaceConfig(workspaceId, supabase, {
    githubToken: token,
    repoOwner,
    repoName,
  });

  const github = new core.GitHubService(config);

  return { store, github, config };
}

export interface RunSyncPhasesArgs {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  store: Awaited<ReturnType<(typeof import('@cezar/core'))['IssueStore']['fromPort']>>;
  github: InstanceType<(typeof import('@cezar/core'))['GitHubService']>;
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
}

/** The four serial sync phases, each writing its progress into `sync_status`.
 *  Phase 1 is fatal-on-error; phases 2–4 are best-effort (warn + continue)
 *  so a digest/comment/PR hiccup still produces a usable sync. */
export async function runSyncPhases({
  supabase,
  workspaceId,
  store,
  github,
  config,
}: RunSyncPhasesArgs): Promise<void> {
  const { LLMService } = await import('@cezar/core');
  const counts: SyncCounts = {};

  // ── 1. Fetch issues ──
  // Do a full (all-states, incl. closed) fetch until a complete sync has
  // succeeded, then switch to incremental `since` fetches. The full fetch
  // backfills closed issues — and corrects issues closed upstream — for stores
  // first synced by the older open-only path, and bootstraps new workspaces.
  try {
    const meta = store.getMeta();
    const fullSync = !meta.fullSyncedAt || !meta.lastSyncedAt;
    const issues = fullSync
      ? await github.fetchAllIssues(true)
      : await github.fetchIssuesSince(meta.lastSyncedAt as string, true);
    counts.issuesFetched = issues.length;
    counts.issuesCreated = 0;
    counts.issuesUpdated = 0;
    for (const issue of issues) {
      const r = store.upsertIssue(issue);
      if (r.action === 'created') counts.issuesCreated += 1;
      if (r.action === 'updated') counts.issuesUpdated += 1;
    }
    const nowIso = new Date().toISOString();
    store.updateMeta({
      lastSyncedAt: nowIso,
      totalFetched: issues.length,
      // Mark the store complete once the first all-states fetch lands, so
      // later syncs go incremental.
      ...(fullSync ? { fullSyncedAt: nowIso } : {}),
    });
    await store.save();
  } catch (err) {
    await writeSyncStatus(supabase, workspaceId, {
      status: 'error',
      phase: null,
      counts,
      error: `Issue fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  // ── 2. Generate digests for OPEN issues that don't have one yet ──
  // Scoped to open issues: a full backfill can pull in hundreds of historical
  // closed issues, and digesting those would be a large, low-value LLM spend.
  try {
    const needDigest = store.getIssues({ state: 'open', hasDigest: false });
    if (needDigest.length > 0) {
      await writeSyncStatus(supabase, workspaceId, {
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
    console.warn('[sync] digest pass failed:', err);
  }

  // ── 3. Fetch comments for open issues that need them ──
  try {
    const needComments = store
      .getIssues({ state: 'open' })
      .filter((i) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      await writeSyncStatus(supabase, workspaceId, {
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
    console.warn('[sync] comments pass failed:', err);
  }

  // ── 4. Refresh PRs (all states) into the pull_requests table ──
  try {
    await writeSyncStatus(supabase, workspaceId, {
      status: 'syncing',
      phase: 'prs',
      message: 'Refreshing pull requests…',
      counts,
    });
    // All states, newest-activity first, so PRs closed/merged upstream get
    // their state corrected; cap the walk so a repo with thousands of historical
    // PRs doesn't bloat this background pass.
    const prs = await github.listPullRequests(500);
    if (prs.length > 0) {
      const rows = prs.map((p) => ({
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
      if (!error) counts.prsUpdated = prs.length;
    }
  } catch (err) {
    console.warn('[sync] PR sync failed:', err);
  }

  // ── Done. ──
  await writeSyncStatus(supabase, workspaceId, {
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
