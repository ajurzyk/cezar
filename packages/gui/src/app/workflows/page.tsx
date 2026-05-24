import { redirect } from 'next/navigation';
import { getActiveWorkspace } from '@/lib/workspace';
import { listFlows, listAvailableSkills } from './actions';
import { WorkflowsClient } from './workflows-client';

export const dynamic = 'force-dynamic';

export default async function WorkflowsPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const [flows, skills] = await Promise.all([listFlows(), listAvailableSkills()]);

  return (
    <WorkflowsClient
      workspaceName={workspace.name}
      workspaceRole={workspace.role}
      initialFlows={flows}
      availableSkills={skills.map((s) => ({ name: s.name, description: s.description }))}
    />
  );
}
