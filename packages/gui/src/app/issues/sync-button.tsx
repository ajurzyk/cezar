'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { RefreshIcon } from '@/components/icons';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { syncAndDigest } from '@/app/inbox/sync-action';
import type { Database, SyncPhase } from '@/lib/supabase/types';

export type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

/** A `syncing` row older than this is abandoned (container restarted mid-sync);
 *  we render the idle button instead of a permanent spinner. Mirrors the
 *  server-side guard in sync-action.ts. */
const STALE_SYNC_MS = 10 * 60 * 1000;

const PHASE_LABEL: Record<SyncPhase, string> = {
  issues: 'issues',
  digests: 'digests',
  comments: 'comments',
  prs: 'pull requests',
};

interface SyncButtonProps {
  workspaceId: string;
  readOnly: boolean;
  initialStatus: SyncStatusRow | null;
}

/**
 * Shared "Sync & Digest" button + live status, used by the Issues and Inbox
 * headers. The actual sync runs in the background (see sync-action.ts); this
 * component just kicks it off and reflects the `sync_status` row it writes,
 * subscribed over Supabase Realtime. The app never blocks waiting on the sync.
 */
export function SyncButton({ workspaceId, readOnly, initialStatus }: SyncButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatusRow | null>(initialStatus);
  const [pending, startKickoff] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Remember the last status we saw 'syncing' on, so we can refresh exactly
  // once when it transitions to a terminal state.
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
            // Sync just finished — pull the freshly-synced data into the page.
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

  function handleClick() {
    if (syncing) return;
    setError(null);
    startKickoff(async () => {
      const result = await syncAndDigest();
      if (!result.ok) {
        setError(result.error ?? 'Sync failed');
      }
      // On success the Realtime subscription drives the rest; nothing to await.
    });
  }

  if (readOnly) return null;

  const statusText = (() => {
    if (error) return error;
    if (syncing) {
      if (status?.message) return status.message;
      if (status?.phase) return `Syncing ${PHASE_LABEL[status.phase]}…`;
      return 'Starting sync…';
    }
    if (status?.status === 'error') return status.error ? `Sync failed: ${status.error}` : 'Sync failed';
    if (status?.status === 'done') return status.message ?? null;
    return null;
  })();

  const label = syncing
    ? status?.phase
      ? `Syncing — ${PHASE_LABEL[status.phase]}`
      : 'Syncing…'
    : 'Sync & Digest';

  return (
    <div className="flex items-center gap-3">
      {statusText && (
        <span
          className={cn(
            'max-w-[280px] truncate text-xs',
            error || status?.status === 'error' ? 'text-error' : 'text-on-surface-variant',
          )}
          title={statusText}
        >
          {statusText}
        </span>
      )}
      <button
        type="button"
        disabled={syncing}
        onClick={handleClick}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors',
          syncing
            ? 'cursor-wait border-outline-variant bg-surface-container text-on-surface-variant'
            : 'border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/15',
        )}
      >
        <RefreshIcon className={cn('h-4 w-4', syncing && 'animate-spin')} />
        {label}
      </button>
    </div>
  );
}
