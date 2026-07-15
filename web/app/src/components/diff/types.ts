/**
 * The `<Diff>` facade contract (spec §"Session git view — Changes & Files tabs (#390)",
 * R5 Step 1.4). These props are OURS — consumers (Changes tab, repo view, commit diff view)
 * import from `@/components/diff` and never from a diff-rendering library. Whatever renders
 * underneath (today: our own renderer; the evaluated `@pierre/diffs` did not fit — see
 * `diff.tsx` header) must satisfy exactly this surface, so swapping engines is a local edit.
 */

/**
 * One changed file, in the server's `/api/runs/:id/changes` / `/api/repo/changes` shape
 * (`ChangedFile` in `src/server/git-changes.ts`) — the facade takes the API payload as-is.
 */
export interface DiffFileChange {
  path: string
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  adds: number
  dels: number
  /** Binary per numstat — there is no text patch to render. */
  binary?: boolean
  /** This file's unified-diff section (`diff --git …` headers + `@@` hunks), possibly
   *  ending in the server's `… (patch truncated)` marker, possibly empty (metadata-only). */
  patch: string
}

export type DiffMode = 'unified' | 'split'

export interface DiffProps {
  files: DiffFileChange[]
  /** Layout: one interleaved column, or old|new side by side. Default `unified`. */
  mode?: DiffMode
  /** Soft-wrap long lines instead of horizontal scrolling. Default `false`. */
  wrap?: boolean
  /**
   * Expandable context needs file bytes the patch doesn't carry: given a path, resolve the
   * file's current (new-side) text — the Changes tab wires `/api/runs/:id/files` here (1.5).
   * Resolve `null` when unavailable (binary, deleted, too large); the gap stays collapsed.
   * Absent ⇒ gaps render as static "N unchanged lines" separators.
   */
  loadFileText?: (path: string) => Promise<string | null>
  className?: string
}
