'use client';

import Link from 'next/link';
import { SyncIndicator } from '../sync-indicator';
import { MenuIcon } from '../icons';
import type { Database } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

interface MobileTopBarProps {
  onOpenNav: () => void;
  user: { id: string; email: string; name: string; avatarUrl: string };
  /** Workspace repo label shown in the centre (truncates). */
  workspaceLabel: string | null;
  workspaceId: string | null;
  readOnly: boolean;
  initialSyncStatus: SyncStatusRow | null;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  webhookHealth: 'live' | 'polling';
  lastWebhookAt: string | null;
}

/**
 * `< lg` top bar (spec §3.3): hamburger (≥44px) on the left, workspace label in
 * the middle, compact SyncIndicator + avatar on the right. Sticky, `h-topbar`.
 * The full desktop `TopBar` is `hidden lg:flex`; this is `flex lg:hidden`.
 *
 * The notification bell is intentionally omitted — it's a no-op today (spec
 * §6.0: don't spend scarce phone topbar width on a dead control).
 */
export function MobileTopBar({
  onOpenNav,
  user,
  workspaceLabel,
  workspaceId,
  readOnly,
  initialSyncStatus,
  syncMode,
  syncIntervalMinutes,
  webhookHealth,
  lastWebhookAt,
}: MobileTopBarProps) {
  const initials = (user.name || user.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="sticky top-0 z-sticky flex h-topbar items-center gap-2 border-b border-outline-variant bg-surface px-2 backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-on-surface">
          {workspaceLabel ?? 'Cezar'}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {workspaceId && (
          <SyncIndicator
            workspaceId={workspaceId}
            readOnly={readOnly}
            initialStatus={initialSyncStatus}
            syncMode={syncMode}
            syncIntervalMinutes={syncIntervalMinutes}
            webhookHealth={webhookHealth}
            lastWebhookAt={lastWebhookAt}
          />
        )}

        <Link
          href="/settings"
          aria-label="Account settings"
          className="flex h-11 w-11 items-center justify-center rounded-md"
        >
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </span>
          )}
        </Link>
      </div>
    </header>
  );
}
