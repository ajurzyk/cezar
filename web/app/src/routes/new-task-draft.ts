import type { Runner } from '@/api/types'
import type { TaskSource } from './new-task-form'

/**
 * The new-task draft store (spec: "Queued form state survives navigation (draft store)").
 *
 * localStorage-backed so the form is refresh-resilient: stepping away to check a thread — or
 * accidentally reloading the tab — loses nothing. Nulls mean "the user has not chosen" — the
 * form falls back to persisted/last-used/default values, so an untouched draft never shadows a
 * fresher `lastTask` from the server. Images are deliberately NOT persisted (multi-MB base64
 * would blow the ~5 MB localStorage quota); everything the pickers hold is.
 */
export interface NewTaskDraft {
  text: string
  source: TaskSource | null
  runner: Runner | null
  model: string | null
  variants: number
  /** The `Start | Plan first` toggle (#383). Sticky like the pickers: plan-first is a way of
   *  working, not a per-task whim — it survives navigation with the rest of the draft. */
  planFirst: boolean
  /** Worktree opt-out (#worktree-toggle): false runs in the repo working tree. null → the
   *  remembered `lastWorktree` / default (isolated worktree). */
  worktree: boolean | null
  /** Autonomous (#autonomous): true never pauses for the user. null → remembered
   *  `lastAutonomous` / default (off). */
  autonomous: boolean | null
}

const EMPTY: NewTaskDraft = {
  text: '',
  source: null,
  runner: null,
  model: null,
  variants: 1,
  planFirst: false,
  worktree: null,
  autonomous: null,
}

const STORAGE_KEY = 'cez-new-task-draft'

/** Coerce arbitrary parsed JSON back into a NewTaskDraft, defaulting anything malformed — the
 *  store must survive a hand-edited or older-shape localStorage value without throwing. */
function normalize(raw: unknown): NewTaskDraft {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    text: typeof obj.text === 'string' ? obj.text : '',
    source: isSource(obj.source) ? obj.source : null,
    runner: typeof obj.runner === 'string' ? (obj.runner as Runner) : null,
    model: typeof obj.model === 'string' ? obj.model : null,
    variants: obj.variants === 2 || obj.variants === 3 ? obj.variants : 1,
    planFirst: obj.planFirst === true,
    worktree: typeof obj.worktree === 'boolean' ? obj.worktree : null,
    autonomous: typeof obj.autonomous === 'boolean' ? obj.autonomous : null,
  }
}

function isSource(raw: unknown): raw is TaskSource {
  return (
    !!raw &&
    typeof raw === 'object' &&
    ((raw as TaskSource).source === 'skill' || (raw as TaskSource).source === 'workflow') &&
    typeof (raw as TaskSource).ref === 'string'
  )
}

// In-memory cache mirrors storage so reads stay synchronous and cheap; storage is the source of
// truth across reloads.
let cache: NewTaskDraft | null = null

export function readDraft(): NewTaskDraft {
  if (cache) return { ...cache }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    cache = stored ? normalize(JSON.parse(stored)) : { ...EMPTY }
  } catch {
    cache = { ...EMPTY } // private mode / bad JSON — start clean, still works this session
  }
  return { ...cache }
}

export function writeDraft(next: NewTaskDraft): void {
  cache = { ...next }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Storage disabled/full — the in-memory cache still survives navigation this session.
  }
}

/** After a successful submit: the text is spent, the picker choices remain — the next task
 *  usually runs the same way (legacy keeps its pills too). */
export function clearDraftText(): void {
  writeDraft({ ...readDraft(), text: '' })
}

/** Test isolation — null the cache too, so the next read re-consults storage (a fresh page). */
export function resetDraft(): void {
  cache = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
