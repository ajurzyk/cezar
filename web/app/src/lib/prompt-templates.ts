/**
 * Follow-up prompt templates (#413): a small set of reusable snippets a user can insert into a
 * follow-up instructions box — the GitHub hand-over's custom prompt (`routes/github/hand-to-agent.tsx`)
 * and the Inbox's "Add instructions" composer (`routes/inbox.tsx`). Both surfaces read the SAME
 * list through `normalizePromptTemplates`, so editing it in one place (Settings → Prompt
 * templates) reshapes what shows up in both.
 *
 * Zero-config by design: `DEFAULT_PROMPT_TEMPLATES` ship built-in and need no setup. The list is
 * only ever persisted once a user edits it — `ui-state.json`'s additive `promptTemplates` key
 * (`.passthrough()` schema, the #408 `skillUsage` pattern) — so "no key at all" and "the built-ins,
 * saved verbatim" are indistinguishable in effect but the former costs nothing to ship.
 */

export interface PromptTemplate {
  id: string
  label: string
  text: string
}

const LABEL_MAX = 80
const TEXT_MAX = 2000
const LIST_MAX = 50

/** Sensible built-ins (issue #413: "a small set of reusable prompt templates"). Order is the
 *  order they render in the menu and in Settings. */
export const DEFAULT_PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: 'add-tests',
    label: 'Add tests',
    text: 'Also add or update tests covering this change.',
  },
  {
    id: 'explain-change',
    label: 'Explain the change',
    text: 'Explain what changed and why before finishing.',
  },
  {
    id: 'keep-minimal',
    label: 'Keep it minimal',
    text: 'Keep the change as small and targeted as possible — no unrelated refactors.',
  },
  {
    id: 'update-docs',
    label: 'Update docs',
    text: 'Also update any relevant documentation or comments.',
  },
  {
    id: 'check-edge-cases',
    label: 'Double-check edge cases',
    text: 'Double-check edge cases and error handling before finishing.',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/**
 * Coerce the `promptTemplates` ui-state field (or anything read from it) into a usable list.
 *
 * `undefined` (the key was never written — first run, or an old ui-state.json) is the only case
 * that falls back to the built-ins; a present-but-malformed value degrades the same way (garbage
 * must not brick the menu), but a deliberately EMPTY array (`[]`) stays empty — a user who
 * cleared every template gets no templates, not the defaults reappearing underneath them.
 */
export function normalizePromptTemplates(raw: unknown): PromptTemplate[] {
  if (raw === undefined) return DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template }))
  if (!Array.isArray(raw)) return DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template }))

  const seen = new Set<string>()
  const out: PromptTemplate[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!id || !label || !text || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: label.slice(0, LABEL_MAX), text: text.slice(0, TEXT_MAX) })
    if (out.length >= LIST_MAX) break
  }
  return out
}

/** A fresh id for a template a user adds in Settings — client-side only, never sent anywhere
 *  else, so a timestamp+random suffix is plenty (no collision handling needed beyond that). */
export function makeTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Insert `snippet` into `text` at `caret`, separated from whatever is already there by a blank
 * line (so stacking a few templates reads as separate instructions, not a run-on sentence).
 * Empty text is a plain assignment — no leading blank line for the first template. Returns the
 * caret position right after the inserted snippet so the caller can restore focus there.
 */
export function insertTemplate(
  text: string,
  caret: number,
  snippet: string,
): { text: string; caret: number } {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, safeCaret)
  const after = text.slice(safeCaret)

  let separator = ''
  if (before.length > 0) {
    if (before.endsWith('\n\n')) separator = ''
    else if (before.endsWith('\n')) separator = '\n'
    else separator = '\n\n'
  }

  const inserted = `${separator}${snippet}`
  return {
    text: before + inserted + after,
    caret: before.length + inserted.length,
  }
}
