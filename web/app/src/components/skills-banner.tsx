import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { Link } from '@/lib/project-router'

import { putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import { Banner } from '@/components/ui/banner'
import { toast } from '@/components/ui/toaster'

const SKILLS_REPO_URL = 'https://github.com/open-mercato/skills'
const INSTALL_COMMAND = "npx skills add open-mercato/skills --skill '*'"

/**
 * Promotes `open-mercato/skills` once (#391) — cezar's built-in default skills source
 * (`DEFAULT_SKILLS_REPOS` in `src/config.ts`) that today only surfaces in `--help`
 * (see `src/skills-banner.ts` for the CLI-side counterpart).
 *
 * "Shown once" is persisted server-side in `ui-state.json`, not a cookie — the house pattern
 * (`AppearanceProvider`, `RunNotifications`): read via `useUiState()`, write via `putUiState()`,
 * reconcile the cache with the server's merged answer on success, toast + refetch on failure.
 * A server truth (not a per-browser cookie) is deliberate here: a promo that is meant to be
 * shown exactly once should not reappear in every new browser, device, or private window.
 *
 * Renders nothing until `uiState` resolves. That, rather than defaulting to visible, is what
 * keeps a returning user (whose dismissal already landed on the server) from ever seeing the
 * banner flash on before the "already dismissed" truth loads — the dismissal itself has no
 * pre-paint requirement (unlike theme/appearance), so there is nothing worth mirroring into
 * localStorage for this one.
 *
 * The copy says WHY to install a repo cezar already clones and merges by default
 * (`DEFAULT_SKILLS_REPOS`): the install is for using the skills OUTSIDE cezar. Inside it, the
 * answer is Skills → Refresh, which this points at rather than duplicating.
 */
export function SkillsBanner() {
  const queryClient = useQueryClient()
  const uiState = useUiState()

  const dismiss = useCallback(() => {
    // Optimistic: hide immediately rather than waiting on the round trip, same as the
    // instant-feel of AppearanceProvider's local state update.
    queryClient.setQueryData(queryKeys.uiState, { ...uiState.data, dismissedSkillsBanner: true })
    putUiState({ dismissedSkillsBanner: true })
      .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // The dismiss failed to persist — re-sync with the server's truth rather than leave the
        // cache claiming a dismissal that never saved (it would reappear on the next reload
        // anyway, so keeping it hidden this session would be a lie the next visit corrects).
        void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
      })
  }, [queryClient, uiState.data])

  if (!uiState.isSuccess || uiState.data.dismissedSkillsBanner) return null

  return (
    <Banner onDismiss={dismiss} dismissLabel="Dismiss the open-mercato/skills banner">
      <span className="font-semibold">Make the most of parallel coding with our AI skills.</span>{' '}
      <a
        href={SKILLS_REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-muted-foreground"
      >
        open-mercato/skills
      </a>{' '}
      — reusable, technology-agnostic agent skills for PR creation, code review, CI
      stabilisation, spec writing and more. cezar already loads them for you; refresh them any
      time from <Link to="/skills" className="underline underline-offset-2 hover:text-muted-foreground">Skills</Link>.
      To use them outside cezar:{' '}
      <code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">{INSTALL_COMMAND}</code>
    </Banner>
  )
}
