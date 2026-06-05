import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace, listWorkspaces } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
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
  if (workspace) {
    const supabase = createSupabaseAdminClient();
    const [{ data: status }, { data: ws }] = await Promise.all([
      supabase.from('sync_status').select('*').eq('workspace_id', workspace.id).maybeSingle<SyncStatusRow>(),
      supabase.from('workspaces').select('sync_mode').eq('id', workspace.id).maybeSingle<{ sync_mode: 'auto' | 'manual' }>(),
    ]);
    initialSyncStatus = status ?? null;
    syncMode = ws?.sync_mode ?? 'auto';
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
            />
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
