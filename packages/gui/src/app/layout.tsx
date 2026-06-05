import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace, listWorkspaces } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { isWebhookConfigured } from '@/lib/webhook-config';
import type { Database } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

export const metadata: Metadata = {
  title: 'Cezar AI',
  description: 'AI-powered GitHub issue management',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  const isLoginPage = !user;

  if (isLoginPage) {
    return (
      <html lang="en" className="dark">
        <body className="bg-surface text-on-surface">{children}</body>
      </html>
    );
  }

  const [workspace, workspaces] = await Promise.all([
    getActiveWorkspace(),
    listWorkspaces(),
  ]);

  // Initial sync_status + sync_mode for the active workspace so the header dot
  // is correct on first paint; the client subscription keeps the status live
  // thereafter. sync_mode lets the indicator flag manual ("auto-sync off")
  // workspaces.
  let initialSyncStatus: SyncStatusRow | null = null;
  let syncMode: 'auto' | 'manual' = 'auto';
  // The reconcile cadence — passed to the indicator so it can compute the
  // staleness threshold (spec §3: max(2 × interval, 30 min)).
  let syncIntervalMinutes = 30;
  // Webhook health drives the indicator's "⚡ Live" vs "⏱ Polling" line (spec
  // §1). Live = the receiver is active (secret set) AND the GitHub App is
  // installed on this repo; we treat installed-but-quiet as Live too (low-traffic
  // repos are normal), passing the last-delivery time through so the tooltip can
  // note "no recent activity".
  let webhookHealth: 'live' | 'polling' = 'polling';
  let lastWebhookAt: string | null = null;
  if (workspace) {
    const supabase = createSupabaseAdminClient();
    const [{ data: status }, { data: ws }] = await Promise.all([
      supabase.from('sync_status').select('*').eq('workspace_id', workspace.id).maybeSingle<SyncStatusRow>(),
      supabase
        .from('workspaces')
        .select('sync_mode, sync_interval_minutes, installation_id, last_webhook_received_at')
        .eq('id', workspace.id)
        .maybeSingle<{ sync_mode: 'auto' | 'manual'; sync_interval_minutes: number | null; installation_id: number | null; last_webhook_received_at: string | null }>(),
    ]);
    initialSyncStatus = status ?? null;
    syncMode = ws?.sync_mode ?? 'auto';
    syncIntervalMinutes = ws?.sync_interval_minutes ?? 30;
    lastWebhookAt = ws?.last_webhook_received_at ?? null;
    webhookHealth = isWebhookConfigured() && ws?.installation_id != null ? 'live' : 'polling';
  }

  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-on-surface">
        <div className="flex min-h-screen">
          <Sidebar user={user} workspace={workspace} workspaces={workspaces} />
          <div className="flex min-h-screen flex-1 flex-col overflow-x-hidden">
            <TopBar
              user={{
                id: user.id,
                email: user.email,
                name: user.name,
                avatarUrl: user.avatarUrl,
              }}
              workspaceId={workspace?.id ?? null}
              readOnly={workspace ? workspace.role !== 'admin' : true}
              initialSyncStatus={initialSyncStatus}
              syncMode={syncMode}
              syncIntervalMinutes={syncIntervalMinutes}
              webhookHealth={webhookHealth}
              lastWebhookAt={lastWebhookAt}
            />
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
