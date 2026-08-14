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
 * Health is still the right answer for the BOOT project — in single-project mode the routes mount
 * unscoped (no `/p/<id>` to read) and the boot folder IS the only project, and a scoped URL naming
 * the boot project describes that same folder. For any OTHER project health is a different repo's
 * answer, so it is not consulted at all.
 *
 * `undefined` means "nothing has said yet", and every consumer treats it as the pre-Stage-4
 * default (`forgeLabel` → "GitHub"). The nav and the screen both read through here so the two
 * can never disagree about what to call the same tab.
 */
export function useForgeKind(): ForgeKind | undefined {
  return useForgeKindStatus().kind
}

export type ForgeKindStatus = {
  /** The forge, or `undefined` — the pre-Stage-4 default (`forgeLabel` → "GitHub"). */
  kind: ForgeKind | undefined
  /**
   * Has the AUTHORITY for this surface answered? Not "is `kind` defined": a registry entry with
   * no `forge` is a settled `undefined`, and health naming a forge for the BOOT folder says
   * nothing about a scoped project.
   *
   * One consumer needs the distinction — the hand-off box's one-shot prompt correction
   * (`routes/github/hand-to-agent.tsx`), which must fire when the answer arrives and never on a
   * value that merely happens to be non-undefined.
   */
  settled: boolean
}

/** `useForgeKind` plus whether that answer is final — see `ForgeKindStatus.settled`. */
export function useForgeKindStatus(): ForgeKindStatus {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const health = useHealth()
  // `?? []` on the lookup rather than a bare `?.`: nothing validates this payload client-side
  // (`unwrap` casts), and a label is not worth crashing a screen over a registry that answered
  // oddly. The undefined-vs-empty distinction still matters, so the query's own silence is kept.
  const registry = projects.data?.projects
  const entry =
    projectId === null
      ? undefined
      : (registry ?? []).find((candidate) => candidate.id === projectId)
  // A LOADED entry is the whole truth, including its silence: a registry project with no `forge`
  // has none, and borrowing the boot folder's kind there would be inventing one.
  if (entry) return { kind: entry.forge, settled: true }
  // Unscoped — single-project mode, where the routes mount without a `/p/<id>` and the boot
  // folder IS the only project. Health is the authority here, not a stand-in.
  if (projectId === null) return { kind: health.data?.forge?.kind, settled: health.data !== undefined }
  // Scoped: the REGISTRY is the authority, so nothing is settled until it has answered. Health is
  // workspace-level (`project-scope.ts` WORKSPACE_LEVEL) — the server always builds it from
  // `bootRoot` — so it may stand in for the boot project alone, the same guard
  // `useProjectRepoBase` puts in front of repo links. Without that guard, while the registry is
  // in flight (or after it failed, which the `?? []` above tolerates on purpose) a scoped Forgejo
  // project wears the boot project's GitHub name across the heading, the refresh tooltip, the
  // "open on …" links, the empty-state hint and the hand-off prompt.
  const placeholder = projectId === health.data?.bootProject ? health.data?.forge?.kind : undefined
  return { kind: placeholder, settled: registry !== undefined }
}
