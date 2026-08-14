import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'
import { forgeLabel } from '@/lib/forge-label'
import { useForgeKind } from '@/lib/use-forge-kind'

/**
 * The forge tab's loading state, in its own module ON PURPOSE (same rule as ThreadLoading):
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * github chunk (routes.tsx) — and the fallback must not import anything from that chunk, or
 * the split that keeps the markdown stack off the main bundle quietly disappears.
 *
 * `@/lib/forge-label` and `@/lib/use-forge-kind` are safe to reach for here: both are tiny, and
 * the queries the hook reads (`useHealth`, `useProjects`) are already in the main bundle — the
 * app shell has been calling them since before this route existed.
 */
export function GithubLoading() {
  const forge = forgeLabel(useForgeKind())
  return (
    <div data-route="github" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title={`Loading ${forge}…`}
        subtitle="Fetching open issues and pull requests."
      />
    </div>
  )
}
