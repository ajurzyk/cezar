import { redirect } from 'next/navigation';
import { getActiveWorkspace } from '@/lib/workspace';
import { listFlows } from './actions';
import { WorkflowsList } from './workflows-list';

export const dynamic = 'force-dynamic';

export default async function WorkflowsPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const flows = await listFlows();

  return (
    <WorkflowsList
      workspaceName={workspace.name}
      workspaceRole={workspace.role}
      initialFlows={flows}
    />
  );
}
