import type { CreateRunInput, GithubItem, WorkflowStepDef } from '@/api/types'

/**
 * The GitHub tab's hand-to-agent contract, ported verbatim from the legacy tab
 * (`web/app.js` `ghTaskPrompt` / `runOnGithub` / `wbSkillStep`) so a run started from the
 * redesigned tab is byte-for-byte the run the legacy tab would have started — same prompt,
 * same `POST /api/runs` body. Pure functions, because the three-way body rule is the part
 * worth pinning independently of any dropdown.
 */

/** A skills-as-chain run carries at most 8 steps — the workflow builder's own limit. */
export const MAX_CHAIN_STEPS = 8

/**
 * The item's IDENTITY alone — verb, `#N`, title, URL — with no body quoted (#524). This is the
 * irreducible context: without it "port this one to develop" names nothing, and `extractTaskRefs`
 * (`src/runs/task-refs.ts`) has no `#N` or URL to recover the run's PR/issue attribution from.
 *
 * The wording is load-bearing, not decorative: `task-refs.ts`'s tier-2 patterns were written to
 * match "Address GitHub pull request #N" / "Fix GitHub issue #N" verbatim. Rewording this without
 * updating those regexes silently costs every run its PR/issue chip and its `#N` title prefix.
 */
export function githubTaskRef(item: GithubItem): string {
  return `${item.kind === 'pr' ? 'Address GitHub pull request' : 'Fix GitHub issue'} #${item.number}: ${item.title}\n\n${item.url}`
}

/**
 * The full auto-generated prompt: the ref block plus the item's body quoted below a rule —
 * the drag-into-the-composer path's text, and the fallback when a hand-off carries no prompt of
 * its own. `skillNames` ride along as a hint ONLY on workflow runs (legacy rule: when the skills
 * ARE the chain, the steps already carry them).
 *
 * The hand-off composer no longer defaults to THIS — it pre-fills the editable box with
 * `githubTaskRef` alone, per #524: a wall of quoted issue body is unreadable in a textarea the
 * user is meant to edit, and the agent can read the item itself from the URL.
 */
export function githubTaskPrompt(item: GithubItem, skillNames: readonly string[] = []): string {
  let task = githubTaskRef(item)
  if (item.body?.trim()) task += `\n\n---\n\n${item.body.trim()}`
  if (skillNames.length) task += skillsHint(skillNames)
  return task
}

function skillsHint(skillNames: readonly string[]): string {
  return `\n\nUse these skills where relevant: ${skillNames.join(', ')}.`
}

/**
 * Substitute the item tokens a custom prompt may use — `{{number}}` → `#N`, `{{title}}`,
 * `{{url}}`. Purely a convenience for placing the reference mid-sentence ("rebase {{number}}
 * onto develop"); it is NEVER what makes the context reach the agent. `composeGithubTask`
 * attaches the ref block regardless, because a user who was never told a token exists cannot be
 * expected to reach for one (#524).
 */
export function applyItemTokens(text: string, item: GithubItem): string {
  return text
    .replace(/\{\{\s*number\s*\}\}/gi, `#${item.number}`)
    .replace(/\{\{\s*title\s*\}\}/gi, item.title)
    .replace(/\{\{\s*url\s*\}\}/gi, item.url)
}

/**
 * Does this text already carry the item's reference? The URL, or `#N` as a whole token — `#142`
 * must not be satisfied by `#1420`, hence the trailing `\b` (digits are word characters, so
 * "#1420" yields no boundary after "142" and correctly fails to match).
 */
export function mentionsItem(text: string, item: GithubItem): boolean {
  return text.includes(item.url) || new RegExp(`#${item.number}\\b`).test(text)
}

/**
 * The final task text for a hand-off — the fix for #524.
 *
 * The rule that matters: a custom prompt EXTENDS the item context, it never replaces it. The
 * ref block is attached unconditionally unless the prompt already carries the reference itself
 * (the pre-filled box's own text does, so keeping the default costs no duplicate).
 *
 * Ordering is context FIRST, the user's instruction LAST, so their words are the most recent
 * thing the agent reads. The skills hint keeps its place at the very end, as it always had.
 *
 * A blank or whitespace-only prompt yields byte-for-byte the previous default text.
 */
export function composeGithubTask(
  item: GithubItem,
  skillNames: readonly string[],
  customPrompt?: string,
): string {
  const custom = applyItemTokens((customPrompt ?? '').trim(), item)
  if (!custom) return githubTaskPrompt(item, skillNames)
  const task = mentionsItem(custom, item) ? custom : `${githubTaskRef(item)}\n\n${custom}`
  return skillNames.length ? task + skillsHint(skillNames) : task
}

/**
 * Skills → a workflow chain (spec 008): one `{{task}}` step per skill, ids deduped the way
 * the legacy builder deduped them (`om-fix`, `om-fix-2`, …), capped at `MAX_CHAIN_STEPS`.
 */
export function skillChainSteps(names: readonly string[]): WorkflowStepDef[] {
  const steps: WorkflowStepDef[] = []
  for (const name of names.slice(0, MAX_CHAIN_STEPS)) {
    const used = new Set(steps.map((step) => step.id))
    let id = name
    for (let n = 2; used.has(id); n++) id = `${name}-${n}`
    steps.push({ id, name, skill: name, prompt: '{{task}}' })
  }
  return steps
}

/**
 * The `POST /api/runs` body for one issue/PR, given what the pickers hold:
 *  - a workflow selected → that workflow (skills ride along as a prompt hint);
 *  - no workflow but skills toggled → the skills ARE the chain (spec 008);
 *  - nothing selected → quick-task.
 */
export function githubRunBody(
  item: GithubItem,
  workflow: string | null,
  skills: readonly string[],
  customPrompt?: string,
): CreateRunInput {
  // A custom prompt EXTENDS the item context rather than replacing it (#524) — see
  // `composeGithubTask`. The workflow/skill routing below is unchanged; only the task text is.
  if (workflow) return { workflow, task: composeGithubTask(item, skills, customPrompt) }
  if (skills.length) {
    return { steps: skillChainSteps(skills), task: composeGithubTask(item, [], customPrompt) }
  }
  return { workflow: 'quick-task', task: composeGithubTask(item, [], customPrompt) }
}
