import type { Skill, WorkflowDef } from '@/api/types'

/**
 * The shared skill presentation rules (#377/#380): the ⌘K palette, the composer's `/`
 * autocomplete, and (R4) the new-task skill picker must agree on what "project first" means
 * and how a typed query narrows the list — so the rules live here, not in any one surface.
 */

/** Project skills first, global/team after — the #377 ordering rule, matching the server's
 *  `Skill.source` values (`src/skills.ts`): `ai`/`cezar`/`agents` live in the repo, `global`
 *  and `team` come from outside it. */
const PROJECT_SKILL_SOURCES: ReadonlySet<Skill['source']> = new Set(['ai', 'cezar', 'agents'])

/** Project skills render emphasized (bold) wherever skills are listed. Accepts anything
 *  carrying a `source` so tag components need not conjure a whole Skill. */
export function isProjectSkill(skill: Pick<Skill, 'source'>): boolean {
  return PROJECT_SKILL_SOURCES.has(skill.source)
}

/** The sort is stable, so within each half the server's own order (its directory precedence)
 *  is preserved. */
export function orderSkills(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((a, b) => Number(!isProjectSkill(a)) - Number(!isProjectSkill(b)))
}

/**
 * The composer picker's frequency sort (#408): locality first (project before global, the #377
 * rule), then MOST-SELECTED first within each half. `usage` is the ui-state `skillUsage` map
 * (name → times chosen, counted across BOTH composers — `/new`'s SourcePill and the GitHub tab's
 * follow-up `SkillsPicker`). The sort is stable, so ties — including "never selected", the
 * common case before any stats exist — keep the server's own directory order: the project-first
 * fallback (#2) falls out of stability for free, no separate branch needed. Shared by both
 * pickers so they can never drift into two different orders.
 */
export function orderSkillsByUsage(
  skills: readonly Skill[],
  usage: Readonly<Record<string, number>> | undefined,
): Skill[] {
  return [...skills].sort(
    (a, b) =>
      Number(!isProjectSkill(a)) - Number(!isProjectSkill(b)) ||
      usageCount(usage, b.name) - usageCount(usage, a.name),
  )
}

/** One skill's count out of the `skillUsage` map. `Object.hasOwn`, not a plain lookup: `usage`
 *  comes from `JSON.parse`, so it carries Object.prototype — a skill named `constructor` or
 *  `toString` would otherwise resolve to the INHERITED function, which `??` does not catch,
 *  turning the comparator into NaN and the bump into string garbage. */
function usageCount(usage: Readonly<Record<string, number>> | undefined, name: string): number {
  if (!usage || !Object.hasOwn(usage, name)) return 0
  const count = usage[name]
  return typeof count === 'number' ? count : 0
}

/** A pure reducer over the ui-state `skillUsage` map (#408): bump one skill's count by one. The
 *  server's `PUT /api/ui-state` merge is shallow (`uiStateSchema` passthrough), so a successful
 *  run start always sends the WHOLE updated map back, never just the one changed entry. */
export function bumpSkillUsage(
  usage: Readonly<Record<string, number>> | undefined,
  name: string,
): Record<string, number> {
  return { ...usage, [name]: usageCount(usage, name) + 1 }
}

/**
 * Does `query` fuzzy-match `candidate`? Case-insensitive subsequence — `omfx` finds
 * `om-fix-issue` — the same permissiveness cmdk gives the palette, minus its score-reordering:
 * the composer autocomplete filters WITHOUT re-sorting, so the project-first order above
 * survives any query (a deliberate difference from the palette, where cmdk may interleave).
 */
export function fuzzyMatch(candidate: string, query: string): boolean {
  if (query === '') return true
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/** Workflows referencing a skill, as "workflow › step" breadcrumbs — the skill detail's
 *  "Used by" list (legacy `skillUsedBy`, ported). Steps fall back to their id when unnamed. */
export function skillUsedBy(workflows: readonly WorkflowDef[], name: string): string[] {
  const out: string[] = []
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      if (step.skill === name) out.push(`${workflow.name} › ${step.name ?? step.id}`)
    }
  }
  return out
}

/** Characters that begin a new "word" inside a skill value ("skill om-auto-review-pr /path"):
 *  whitespace and the separators used in names and paths. Lets us tell a whole-word or
 *  word-start hit ("review" in "om-auto-**review**-pr") from an incidental buried substring. */
const WORD_BOUNDARY = /[\s\-/_.]/

/** How well a single lowercased `word` matches inside a lowercased `haystack`.
 *  0 = absent, 1 = buried substring, 2 = starts on a word boundary, 3 = a whole word
 *  (bounded on both sides). Scans every occurrence and keeps the strongest — so the score
 *  reflects match *quality*, not where the first hit happens to land. */
function wordScore(haystack: string, word: string): number {
  let best = 0
  for (let from = haystack.indexOf(word); from !== -1; from = haystack.indexOf(word, from + 1)) {
    let score = 1
    const before = haystack[from - 1]
    if (from === 0 || (before !== undefined && WORD_BOUNDARY.test(before))) {
      const after = haystack[from + word.length]
      score = after === undefined || WORD_BOUNDARY.test(after) ? 3 : 2
    }
    if (score > best) best = score
    if (best === 3) break
  }
  return best
}

/**
 * Multi-word filter for cmdk `<Command filter={…}>`: splits the typed query on whitespace
 * and requires every word to appear as a case-insensitive substring in the combined
 * value + keywords text.  "auto review" finds "om-auto-review-pr", "verify ui" finds
 * "om-auto-verify-ui".  Returns a 0–1 score (0 = no match) so cmdk hides non-matches and
 * ranks the rest.
 *
 * The score is the average per-word match *quality* (#484): a whole-word / word-start hit
 * outranks an incidental buried substring, so an (almost-)exact match sorts to the top. It
 * is deliberately independent of the haystack length — the old coverage ratio diluted every
 * match on a long value+path down to ~0.5, leaving cmdk nothing to rank by.
 */
export function multiWordFilter(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  let total = 0
  for (const word of words) {
    const score = wordScore(haystack, word)
    if (score === 0) return 0 // every word must match
    total += score
  }
  return total / (words.length * 3) // normalize into (0, 1]
}

/**
 * How well a whole `query` matches a single `text` (a skill name or its description).
 * 0 = no match; higher = better: exact > prefix > word-boundary hit > buried substring >
 * subsequence. The subsequence fallback keeps `fuzzyMatch`'s permissiveness ("omfx" still
 * finds "om-fix-issue"), just ranked below the literal hits so the best match wins.
 */
export function matchScore(text: string, query: string): number {
  if (query === '') return 1
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  if (haystack === needle) return 6
  if (haystack.startsWith(needle)) return 5
  const idx = haystack.indexOf(needle)
  if (idx > 0) {
    const before = haystack[idx - 1]
    return before !== undefined && WORD_BOUNDARY.test(before) ? 4 : 3
  }
  return fuzzyMatch(haystack, needle) ? 1 : 0
}

/** Split a skill/workflow name on hyphens so each part is independently searchable as a
 *  cmdk keyword — keeps the description keyword too. */
export function skillKeywords(name: string, description?: string | null): string[] {
  const parts = name.split('-').filter(Boolean)
  return description ? [...parts, description] : parts
}

/** A name hit outranks a description-only hit by this much, so an (almost-)exact name match
 *  always sorts above a skill that merely mentions the query in its description (#484). */
const NAME_MATCH_BONUS = 10

/** How well a name/description pair matches a typed query. The query is split on whitespace
 *  and EVERY word must appear in the name or the description (the multi-keyword rule from #411:
 *  "fix project" finds `om-fix` "project fixer"); a query that misses any word scores 0. Each
 *  word contributes its `matchScore` quality (exact > prefix > word-boundary > substring >
 *  subsequence), and a word that lands in the NAME is boosted over one that only lands in the
 *  description — so the total ranks (almost-)exact name matches to the top (#484). Empty query
 *  is a neutral match (1). The shared match signal behind every skill/workflow search surface. */
export function queryScore(name: string, description: string | null | undefined, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  let total = 0
  for (const word of words) {
    const nameScore = matchScore(name, word)
    const descScore = description ? matchScore(description, word) : 0
    if (nameScore === 0 && descScore === 0) return 0 // every word must match somewhere
    total += nameScore > 0 ? nameScore + NAME_MATCH_BONUS : descScore
  }
  return total
}

/** Filter a name/description list down to matches and rank them by match quality (#484),
 *  preserving the incoming order for an empty query and for equally-scored ties — so a
 *  caller's project-first or recency order survives. This is the shared ranking engine behind
 *  both the composer `/` autocomplete and the cmdk pickers: the pickers rank in JS through
 *  this rather than trusting cmdk's built-in score-sort, which does not reliably re-order the
 *  list in this app (React re-renders reset cmdk's imperative DOM ordering), so before #484 an
 *  (almost-)exact match could sit below weaker ones. */
function rankByQuery<T extends { name: string; description?: string | null }>(
  items: readonly T[],
  query: string,
): T[] {
  if (query.trim() === '') return [...items]
  return items
    .map((item, index) => ({ item, index, score: queryScore(item.name, item.description, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

/** Rank skills for a grouped picker by match quality, keeping the caller's incoming order
 *  (project-first / recency) for ties and the empty query. Callers split the result into their
 *  own Project/Global groups; each group stays match-ranked. */
export function searchSkills(skills: readonly Skill[], query: string): Skill[] {
  return rankByQuery(skills, query)
}

/** Rank workflows for a picker by match quality — the workflow counterpart of `searchSkills`. */
export function searchWorkflows(workflows: readonly WorkflowDef[], query: string): WorkflowDef[] {
  return rankByQuery(workflows, query)
}

/** The `/` autocomplete's list for a typed query: ordered project-first, then filtered and
 *  **ranked by match quality** (#484 — an (almost-)exact match must sort to the top, the same
 *  rule the pickers now follow; supersedes the old #380 "filter without re-sorting"). Matches
 *  on the name and, as a fallback, the description ("review" should find `om-code-review` even
 *  when the name says less than the description does). Ties keep the project-first order, so an
 *  empty query and equally-good matches still render project skills before global/team. */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  return rankByQuery(orderSkills(skills), query)
}
