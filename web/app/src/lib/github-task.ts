import type { CreateRunInput, GithubItem, Runner, WorkflowStepDef } from '@/api/types'

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

/** Which backend runs the issue/PR (#401) — the composer's runner/model pills, resolved. */
export interface GithubRunEngine {
  /** `''` is auto: the pill's explicit "let the runner decide", sent as an omitted field. */
  model: string
  runner: Runner
  /** How many backends the host offers; a single-backend host never sends a runner. */
  runnerCount: number
}

/**
 * The `POST /api/runs` body for one issue/PR, given what the pickers hold:
 *  - a workflow selected → that workflow (skills ride along as a prompt hint);
 *  - no workflow but skills toggled → the skills ARE the chain (spec 008);
 *  - nothing selected → quick-task.
 *
 * `engine` (#401) picks the backend, following `buildCreateRunBody`'s two rules verbatim so the
 * GitHub tab and the /new composer cannot drift: auto (`''`) stays implicit, and a runner is
 * sent only on a multi-backend host. Omit it entirely and the body is the legacy one.
 */
export function githubRunBody(
  item: GithubItem,
  workflow: string | null,
  skills: readonly string[],
  customPrompt?: string,
  engine?: GithubRunEngine,
): CreateRunInput {
  // A non-empty custom prompt REPLACES the auto-generated task text (the user's words win); the
  // workflow/skill routing is unchanged. Empty → the default "Fix GitHub issue #N …" prompt.
  const custom = customPrompt?.trim()
  const backend: Pick<CreateRunInput, 'model' | 'runner'> = engine
    ? {
        model: engine.model || undefined,
        runner: engine.runnerCount > 1 ? engine.runner : undefined,
      }
    : {}
  if (workflow) return { ...backend, workflow, task: custom || githubTaskPrompt(item, skills) }
  if (skills.length)
    return { ...backend, steps: skillChainSteps(skills), task: custom || githubTaskPrompt(item) }
  return { ...backend, workflow: 'quick-task', task: custom || githubTaskPrompt(item) }
}
