import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import { getApiScope, setApiScope } from './project-scope'

/**
 * The React face of the project scope (multi-project spec, step 3.1): components read
 * `{projectId, apiBase}` from context; the module-level client seam (project-scope.ts) is kept
 * in sync by the provider. Step 3.2 mounts the provider from the `/p/:projectId` URL param —
 * until then nothing mounts it, the default below applies, and the app is byte-identical to the
 * single-project cockpit.
 */
export interface ProjectScope {
  /** The registered project id from the URL, or null when unscoped (the boot project). */
  projectId: string | null
  /** `/api/p/<id>` when scoped, `/api` when not — for the rare caller that builds URLs itself. */
  apiBase: string
}

const UNSCOPED: ProjectScope = { projectId: null, apiBase: '/api' }

export const ProjectScopeContext = createContext<ProjectScope>(UNSCOPED)

/** The active scope. Outside a provider this is the unscoped default, not an error — that IS
 *  the boot project's normal state until 3.2 mounts the provider. */
export function useProjectScope(): ProjectScope {
  return useContext(ProjectScopeContext)
}

/**
 * Binds the module-level API scope to this subtree's lifetime.
 *
 * The module write happens **during render**, not in an effect: the children's very first render
 * computes query keys (queries.ts reads `queryScope()`), and an effect would run after that —
 * the first paint would fetch under the wrong scope and cache it there. The write is idempotent
 * and derived solely from props, so re-renders (StrictMode's double-invoke included) converge on
 * the same value. The effect below only re-asserts it (covering StrictMode's mount–unmount–mount
 * cycle, whose cleanup ran the reset) and resets to unscoped on real unmount.
 */
export function ProjectScopeProvider({
  projectId,
  children,
}: {
  projectId: string | null
  children: ReactNode
}) {
  if (getApiScope() !== projectId) setApiScope(projectId)

  useEffect(() => {
    setApiScope(projectId)
    return () => setApiScope(null)
  }, [projectId])

  const value = useMemo<ProjectScope>(
    () => (projectId === null ? UNSCOPED : { projectId, apiBase: `/api/p/${encodeURIComponent(projectId)}` }),
    [projectId],
  )
  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>
}
