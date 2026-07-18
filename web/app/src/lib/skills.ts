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

/** Locality first (project before global, the #377 rule), then recency WITHIN each locality:
 *  a skill you ran more recently sorts above one you ran longer ago, and both sort above skills
 *  you have never run. `recentNames` is newest-first (the ui-state `recentSources` refs). The
 *  sort is stable, so never-run skills keep the server's directory order. */
export function orderSkillsByRecency(skills: readonly Skill[], recentNames: readonly string[]): Skill[] {
  const rank = new Map<string, number>()
  recentNames.forEach((name, index) => {
    if (!rank.has(name)) rank.set(name, index)
  })
  const recency = (skill: Skill) => rank.get(skill.name) ?? Number.MAX_SAFE_INTEGER
  return [...skills].sort(
    (a, b) => Number(!isProjectSkill(a)) - Number(!isProjectSkill(b)) || recency(a) - recency(b),
  )
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

/** A skill's match score for a typed query: a name hit always outranks a description-only
 *  hit (the +10 offset), and within each the stronger `matchScore` wins. 0 = no match. */
function skillMatchScore(skill: Skill, query: string): number {
  const nameScore = matchScore(skill.name, query)
  if (nameScore > 0) return nameScore + 10
  return skill.description ? matchScore(skill.description, query) : 0
}

/** The `/` autocomplete's list for a typed query: ordered project-first, then filtered and
 *  **ranked by match quality** (#484 — an (almost-)exact match must sort to the top, the same
 *  rule the cmdk pickers follow; supersedes the old #380 "filter without re-sorting"). Matches
 *  on the name and, as a fallback, the description ("review" should find `om-code-review` even
 *  when the name says less than the description does). Ties keep the project-first order, so an
 *  empty query and equally-good matches still render project skills before global/team. */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const ordered = orderSkills(skills)
  if (query.trim() === '') return ordered
  return ordered
    .map((skill, index) => ({ skill, index, score: skillMatchScore(skill, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.skill)
}
