import { z } from 'zod';

/**
 * A workflow is an ordered list of steps. Two step kinds:
 *  - `agent` — one claude CLI run (prompt + optional skill + model + tools);
 *  - `check` — a shell command; exit 0 passes, non-zero can loop back to an
 *    earlier step via `onFail` (bounded by `max`).
 *
 * `{{task}}` in a prompt is replaced with the user's task text. When a check
 * loops back, the failing output is appended to the retried agent's prompt.
 */
export const workflowStepSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
      })
      .optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  });

/**
 * A workflow file names either full `steps` or the portable `skills` shorthand
 * (spec 012 — what the builder exports): an ordered list of skill names, each
 * becoming one agent step that applies that skill to `{{task}}`.
 */
export const workflowFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    steps: z.array(workflowStepSchema).min(1).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .refine((d) => Boolean(d.steps) !== Boolean(d.skills), {
    message: 'a workflow lists either "steps" or "skills", not both',
  });

export type WorkflowStepDef = z.infer<typeof workflowStepSchema>;
export type WorkflowDoc = z.infer<typeof workflowFileSchema>;

export interface WorkflowDef {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
  source: 'built-in' | 'file';
  path?: string;
}

/** `skills: [a, b]` → agent steps, one per skill, each running `{{task}}`. */
export function skillsToSteps(skills: string[]): WorkflowStepDef[] {
  const used = new Set<string>();
  return skills.map((skill) => {
    let id = skill;
    for (let n = 2; used.has(id); n++) id = `${skill}-${n}`;
    used.add(id);
    return { id, name: skill, skill, prompt: '{{task}}' };
  });
}

/** Resolve the steps/skills XOR into plain steps. */
export function normalizeWorkflowDoc(doc: WorkflowDoc): {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
} {
  return {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    steps: doc.steps ?? skillsToSteps(doc.skills ?? []),
  };
}

/**
 * The inverse of `skillsToSteps`: when every step is a plain "apply this
 * skill to the task" agent step, return the skill list — the workflow can be
 * written in the portable compact form. Anything richer (checks, custom
 * prompts, per-step models/tools, loops) returns null.
 */
export function skillStackOf(steps: WorkflowStepDef[]): string[] | null {
  const skills: string[] = [];
  for (const s of steps) {
    if (stepKind(s) !== 'agent' || !s.skill) return null;
    if (s.prompt !== undefined && s.prompt !== '{{task}}') return null;
    if (s.name !== undefined && s.name !== s.skill) return null;
    if (s.model || s.allowedTools || s.bashAllowlist || s.onFail) return null;
    skills.push(s.skill);
  }
  return skills.length ? skills : null;
}

export function stepKind(step: WorkflowStepDef): 'agent' | 'check' {
  return step.command ? 'check' : 'agent';
}

/**
 * Structural checks beyond the per-step schema: ids must be unique and every
 * `onFail.retry` must reference an *earlier* step (loops only go backwards).
 * Returns a human-readable problem, or null when the list is sound. Shared by
 * the file loader and the inline-steps / save-workflow API routes (spec 008).
 */
export function stepsIssue(steps: WorkflowStepDef[]): string | null {
  const ids = steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return `duplicate step id "${dup}"`;
  for (const [i, s] of steps.entries()) {
    if (!s.onFail) continue;
    const target = ids.indexOf(s.onFail.retry);
    if (target < 0 || target >= i) {
      return `step "${s.id}": onFail.retry must reference an earlier step (got "${s.onFail.retry}")`;
    }
  }
  return null;
}

/** Tools an agent step gets when the workflow doesn't say otherwise. */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

/** The zero-config workflow: one agent step that just does the task. */
export const QUICK_TASK_WORKFLOW: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [
    {
      id: 'task',
      name: 'Do the task',
      prompt: '{{task}}',
    },
  ],
};
