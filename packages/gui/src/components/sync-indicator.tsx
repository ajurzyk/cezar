'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { syncAndDigest } from '@/app/inbox/sync-action';
import type { Database, SyncCounts, SyncPhase } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

/** A `syncing` row older than this is abandoned (container restarted mid-sync);
 *  we treat it as idle instead of showing a permanent spinner. Mirrors the
 *  server-side guard in sync-action.ts and sync-button.tsx. */
const STALE_SYNC_MS = 10 * 60 * 1000;

/** Synced within this window → render a subtle "fresh" tint on the dot. */
const FRESH_SYNC_MS = 5 * 60 * 1000;

const PHASE_LABEL: Record<SyncPhase, string> = {
  issues: 'issues',
  digests: 'digests',
  comments: 'comments',
  prs: 'pull requests',
};

/** Turn the `counts` blob into a short human string, e.g. "346 issues · 65 PRs". */
function summarize(counts: SyncCounts | null | undefined): string | null {
  if (!counts) return null;
  const bits: string[] = [];
  if (counts.issuesFetched) bits.push(`${counts.issuesFetched} issue${counts.issuesFetched === 1 ? '' : 's'}`);
  if (counts.digestsCreated) bits.push(`${counts.digestsCreated} digested`);
  if (counts.commentsFetched) bits.push(`${counts.commentsFetched} commented`);
  if (counts.prsUpdated) bits.push(`${counts.prsUpdated} PR${counts.prsUpdated === 1 ? '' : 's'}`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

/** "5 minutes ago", "2 hours ago", etc. — coarse relative time. */
function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  if (diff < 60 * 1000) return 'just now';
  const mins = Math.floor(diff / (60 * 1000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface SyncIndicatorProps {
  workspaceId: string;
  initialStatus: SyncStatusRow | null;
  readOnly: boolean;
  /** 'manual' workspaces don't auto-sync — the tooltip flags it. */
  syncMode: 'auto' | 'manual';
}

/**
 * Global sync indicator for the top header. A small dot that reflects the
 * active workspace's live `sync_status` (subscribed over Supabase Realtime),
 * is clickable to trigger a "sync now", and shows a tooltip with the last-sync
 * time + status + counts on hover.
 */
export function SyncIndicator({ workspaceId, initialStatus, readOnly, syncMode }: SyncIndicatorProps) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatusRow | null>(initialStatus);
  const [pending, startKickoff] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Refresh exactly once when a sync transitions to a terminal state.
  const wasSyncing = useRef(initialStatus?.status === 'syncing');

  // ── Realtime: follow this workspace's sync_status row. ──
  useEffect(() => {
    if (!workspaceId) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`sync-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_status',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          const row = payload.new as Partial<SyncStatusRow>;
          // Ignore DELETE / tombstone payloads (no row data).
          if (!row || !row.workspace_id || !row.status) return;
          setStatus(row as SyncStatusRow);
          if (row.status === 'syncing') {
            wasSyncing.current = true;
          } else if (wasSyncing.current && (row.status === 'done' || row.status === 'error')) {
            // Sync just finished — pull the freshly-synced data into every page.
            wasSyncing.current = false;
            router.refresh();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, router]);

  const isStale =
    status?.status === 'syncing' &&
    Date.now() - new Date(status.updated_at).getTime() > STALE_SYNC_MS;
  const syncing = (status?.status === 'syncing' && !isStale) || pending;
  const isError = !syncing && (Boolean(error) || status?.status === 'error');

  const lastSyncedAt = status?.finished_at ?? (status?.status === 'done' ? status?.updated_at : null);
  const isFresh =
    !syncing &&
    !isError &&
    Boolean(lastSyncedAt) &&
    Date.now() - new Date(lastSyncedAt as string).getTime() < FRESH_SYNC_MS;

  function handleClick() {
    if (syncing || readOnly) return;
    setError(null);
    startKickoff(async () => {
      const result = await syncAndDigest();
      if (!result.ok) {
        setError(result.error ?? 'Sync failed');
      }
      // On success the Realtime subscription drives the rest; nothing to await.
    });
  }

  // ── Tooltip lines. ──
  const tooltip = (() => {
    const lines: string[] = [];
    if (syncing) {
      if (status?.message) lines.push(status.message);
      else if (status?.phase) lines.push(`Syncing ${PHASE_LABEL[status.phase]}…`);
      else lines.push('Starting sync…');
      return lines;
    }
    if (isError) {
      lines.push(error ?? status?.error ?? 'Sync failed');
      return lines;
    }
    const rel = relativeTime(lastSyncedAt);
    if (rel) lines.push(`Last synced ${rel}`);
    else lines.push('Not synced yet');
    const counts = summarize(status?.counts);
    if (counts) lines.push(counts);
    // Flag manual workspaces — the cron won't auto-sync; the user drives it.
    if (syncMode === 'manual') {
      lines.push(readOnly ? 'Auto-sync off' : 'Auto-sync off — click to sync');
    }
    return lines;
  })();

  const dotColor = syncing
    ? 'bg-primary animate-pulse'
    : isError
      ? 'bg-error'
      : isFresh
        ? 'bg-primary/60'
        : 'bg-outline';

  const aria = syncing ? 'Syncing…' : isError ? 'Sync failed' : 'Sync now';

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        disabled={syncing || readOnly}
        onClick={handleClick}
        aria-label={aria}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant transition-colors',
          readOnly ? 'cursor-default' : 'hover:bg-surface-container hover:text-on-surface',
          syncing && 'cursor-wait',
        )}
      >
        <span className={cn('h-2 w-2 rounded-full transition-colors', dotColor)} aria-hidden />
      </button>

      {/* Tooltip — appears on hover, right-aligned under the dot. */}
      <div
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-max max-w-[260px] rounded-md border border-outline-variant bg-surface-container-high px-3 py-2 text-xs shadow-ambient group-hover:block"
      >
        <div className="font-medium text-on-surface">
          {syncing ? 'Syncing' : isError ? 'Sync failed' : readOnly ? 'Sync status' : 'Sync now'}
        </div>
        {tooltip.map((line, i) => (
          <div key={i} className={cn('mt-0.5', isError && i === 0 ? 'text-error' : 'text-on-surface-variant')}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
