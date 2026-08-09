import { useHealth, useProjects } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'

import type { ForgeKind } from './forge-label'

/**
 * Which forge the surface the user is looking at belongs to — the input every forge label needs.
 *
 * The project in the URL is the authority, NOT `/api/v1/health`. Health is workspace-global and
 * describes the boot folder alone: on a multi-project workspace whose boot folder is an ordinary
 * repo it answers `forge: null` while another project sits happily on Forgejo. A screen that
 * trusted health there would label a Forgejo backlog "GitHub".
 *
 * Health is still the right answer in single-project mode, where the routes mount unscoped
 * (no `/p/<id>` to read) and the boot folder IS the only project — so it serves as the fallback,
 * used only while no registry entry answers.
 *
 * `undefined` means "nothing has said yet", and every consumer treats it as the pre-Stage-4
 * default (`forgeLabel` → "GitHub"). The nav and the screen both read through here so the two
 * can never disagree about what to call the same tab.
 */
export function useForgeKind(): ForgeKind | undefined {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const health = useHealth()
  const entry =
    projectId === null
      ? undefined
      // `?? []` rather than a bare `?.`: nothing validates this payload client-side (`unwrap`
      // casts), and a label is not worth crashing a screen over a registry that answered oddly.
      : (projects.data?.projects ?? []).find((candidate) => candidate.id === projectId)
  // A LOADED entry is the whole truth, including its silence: a registry project with no `forge`
  // has none, and borrowing the boot folder's kind there would be inventing one.
  if (entry) return entry.forge
  return health.data?.forge?.kind
}
