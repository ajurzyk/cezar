import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import {
  applyAppearance,
  normalizeAppearance,
  readStoredAppearance,
  writeStoredAppearance,
  type Accent,
  type Appearance,
  type Density,
} from '@/lib/appearance'

type AppearanceContextValue = {
  accent: Accent
  density: Density
  setAccent: (accent: Accent) => void
  setDensity: (density: Density) => void
}

const AppearanceContext = React.createContext<AppearanceContextValue | null>(null)

/** Owns the accent + density preference (Settings → Appearance, R6 Step 1.3).
 *
 *  Boot order, mirroring the theme's no-flash contract:
 *   1. the pre-paint script in index.html stamped `data-accent`/`data-density` from the
 *      localStorage mirror before the bundle loaded;
 *   2. this provider seeds from the same mirror, so mounting never repaints;
 *   3. when `GET /api/ui-state` answers, the server value is authoritative — it is applied
 *      and mirrored, so the next cold load pre-paints the truth.
 *
 *  Writes go through `PUT /api/ui-state` with the FULL `appearance` object every time: the
 *  server merges ui-state shallowly (top-level keys), so a partial `{ accent }` would drop
 *  the stored density. On a failed write the server truth is re-fetched and re-applied —
 *  the control must not claim a persistence the file never got.
 */
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const [appearance, setAppearanceState] = React.useState<Appearance>(readStoredAppearance)

  // The server's word wins over the mirror — including "no appearance key" meaning defaults,
  // so wiping ui-state.json honestly resets every browser that visits.
  const serverAppearance = uiState.data
  React.useEffect(() => {
    if (serverAppearance === undefined) return
    const next = normalizeAppearance(serverAppearance.appearance)
    setAppearanceState(next)
    writeStoredAppearance(next)
  }, [serverAppearance])

  // Layout effect, not effect: the attributes must land before the browser paints the tree.
  React.useLayoutEffect(() => {
    applyAppearance(document.documentElement, appearance)
  }, [appearance])

  const save = React.useCallback(
    (next: Appearance) => {
      setAppearanceState(next)
      writeStoredAppearance(next)
      putUiState({ appearance: next })
        .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          // Fall back to the server's truth rather than keep painting an unsaved choice.
          void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
        })
    },
    [queryClient],
  )

  const setAccent = React.useCallback(
    (accent: Accent) => save({ accent, density: appearance.density }),
    [save, appearance.density],
  )
  const setDensity = React.useCallback(
    (density: Density) => save({ accent: appearance.accent, density }),
    [save, appearance.accent],
  )

  const value = React.useMemo<AppearanceContextValue>(
    () => ({ accent: appearance.accent, density: appearance.density, setAccent, setDensity }),
    [appearance, setAccent, setDensity],
  )

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useAppearance(): AppearanceContextValue {
  const context = React.useContext(AppearanceContext)
  if (!context) throw new Error('cezar: useAppearance() must be called inside <AppearanceProvider>')
  return context
}
