import { notFound, redirect } from 'next/navigation';
import { getActiveWorkspace } from '@/lib/workspace';
import { getFlow, listAvailableSkills } from '../actions';
import { WorkflowEditor } from './workflow-editor';

export const dynamic = 'force-dynamic';

export default async function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const [flow, skills] = await Promise.all([getFlow(id), listAvailableSkills()]);
  if (!flow) notFound();

  return (
    <WorkflowEditor
      workspaceRole={workspace.role}
      initialFlow={flow}
      availableSkills={skills.map((s) => ({ name: s.name, description: s.description }))}
    />
  );
}
