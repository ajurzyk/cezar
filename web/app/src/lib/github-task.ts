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
 * The prompt handed to the agent — shared by "Run agent on this …" and the drag-into-the-
 * composer path. `skillNames` ride along as a hint ONLY on workflow runs (legacy rule: when
 * the skills ARE the chain, the steps already carry them).
 */
export function githubTaskPrompt(item: GithubItem, skillNames: readonly string[] = []): string {
  let task = `${item.kind === 'pr' ? 'Address GitHub pull request' : 'Fix GitHub issue'} #${item.number}: ${item.title}\n\n${item.url}`
  if (item.body?.trim()) task += `\n\n---\n\n${item.body.trim()}`
  if (skillNames.length) task += `\n\nUse these skills where relevant: ${skillNames.join(', ')}.`
  return task
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
 *
 * `backend` (#401) is the already-resolved runner/model pair — `engineBody(useResolvedEngine(…))`
 * from components/engine-pills. It arrives pre-shaped rather than raw on purpose: the omit rules
 * are subtle enough to be worth having in exactly one place, and this stays a pure body builder.
 * Omit it and the body is the pre-#401 one.
 */
export function githubRunBody(
  item: GithubItem,
  workflow: string | null,
  skills: readonly string[],
  customPrompt?: string,
  backend: Pick<CreateRunInput, 'model' | 'runner'> = {},
): CreateRunInput {
  // A non-empty custom prompt REPLACES the auto-generated task text (the user's words win); the
  // workflow/skill routing is unchanged. Empty → the default "Fix GitHub issue #N …" prompt.
  const custom = customPrompt?.trim()
  if (workflow) return { ...backend, workflow, task: custom || githubTaskPrompt(item, skills) }
  if (skills.length)
    return { ...backend, steps: skillChainSteps(skills), task: custom || githubTaskPrompt(item) }
  return { ...backend, workflow: 'quick-task', task: custom || githubTaskPrompt(item) }
}
