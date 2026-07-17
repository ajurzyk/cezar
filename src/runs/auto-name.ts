import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createRunner } from '../core/runner-factory.js';
import { parseStructured } from '../planner.js';
import { extractTaskRefs, refineTaskRefs, titleRefNumber, type TaskRefs } from './task-refs.js';

/**
 * The one-shot LLM namer (spec 2026-07-17-task-auto-naming): turns a task's
 * INTENT — skill + arguments + prompt + PR/issue context, never the agent's
 * streamed words — into a short `<number>: <gerund phrase>` display title with
 * structured, regex-cross-checked PR/issue numbers. Mirrors the planner (spec
 * 008): `[cez-namer]` dry-run marker, strict JSON, never blocks, never fails a
 * run. This module is the pure half; the runner call lives in `generateRunName`.
 */

export const NAMER_TIMEOUT_MS = 20_000;

/** Title budget in code points — the tasks table shows ~20-25 chars, 40 is the hard cap. */
export const TITLE_MAX = 40;

export const NAMER_SYSTEM_PROMPT =
  'You are a task-naming assistant for an AI coding agent cockpit. Respond with ONLY a JSON object: ' +
  '{"title": string, "pr"?: number, "issue"?: number}. Rules: "title" is a terse lowercase gerund phrase ' +
  'naming the task INTENT (e.g. "implementing cr fixes", "verifying pr ui"), at most 40 characters, no ' +
  'trailing period, and NEVER a restatement of an assistant reply. When the task is about a GitHub pull ' +
  'request or issue, set "pr" or "issue" to that number and do NOT repeat the number inside the title ' +
  'text. Never invent a number that is not in the task.';

const namerResponseSchema = z.object({
  title: z.string().min(1),
  pr: z.number().int().positive().optional(),
  issue: z.number().int().positive().optional(),
});

export interface NamerContext {
  task: string;
  skillName?: string;
  skillDescription?: string;
  /** Live refresh only (spec step 3): the just-finished turn's text. */
  turnText?: string;
  /** Live refresh only: current `git diff --shortstat` line. */
  diffStat?: string;
}

export interface NameResult {
  titleSummary: string;
  prNumber?: number;
  issueNumber?: number;
}

/** The `[cez-namer]` marker lets the CEZ_DRY_RUN mock recognize a naming call. */
export function buildNamerPrompt(ctx: NamerContext): string {
  const refs = advisoryRefs(ctx);
  const lines = [
    '[cez-namer] Name this task.',
    '',
    ...(ctx.skillName ? [`Selected skill: /${ctx.skillName}`] : []),
    ...(ctx.skillDescription ? [`Skill description: ${ctx.skillDescription}`] : []),
    'Task:',
    clip(ctx.task, 500),
  ];
  if (refs.length) lines.push('', `References found programmatically (advisory): ${refs.join(', ')}`);
  if (ctx.turnText) lines.push('', 'Latest progress (context only — do not quote it):', clip(ctx.turnText, 400));
  if (ctx.diffStat) lines.push('', `Change size so far: ${ctx.diffStat}`);
  return lines.join('\n');
}

function advisoryRefs(ctx: NamerContext): string[] {
  const refs = refineTaskRefs(extractTaskRefs(ctx.task), ctx.skillName);
  const out: string[] = [];
  if (refs.prNumber !== undefined) out.push(`pr ${refs.prNumber}`);
  if (refs.issueNumber !== undefined) out.push(`issue ${refs.issueNumber}`);
  if (refs.ambiguousNumber !== undefined) out.push(`number ${refs.ambiguousNumber} (kind unknown)`);
  return out;
}

function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/**
 * Anti-hallucination cross-check: the model's `pr`/`issue` is accepted only
 * when the regex layer agrees or the number literally occurs in the task text;
 * on any disagreement the regex wins. The regex's own explicit findings always
 * carry through, so a lying model can add nothing and remove nothing.
 */
export function crossCheckRefs(
  raw: { pr?: number; issue?: number },
  task: string,
  refs: TaskRefs,
): { prNumber?: number; issueNumber?: number } {
  const inTask = (n: number | undefined): boolean =>
    n !== undefined && new RegExp(`(^|\\D)${n}(\\D|$)`).test(task);
  const claimedPr = refs.prNumber ?? (raw.pr !== undefined && (inTask(raw.pr) || refs.ambiguousNumber === raw.pr) ? raw.pr : undefined);
  const claimedIssue =
    refs.issueNumber ?? (raw.issue !== undefined && (inTask(raw.issue) || refs.ambiguousNumber === raw.issue) ? raw.issue : undefined);
  return {
    ...(claimedPr !== undefined ? { prNumber: claimedPr } : {}),
    ...(claimedIssue !== undefined ? { issueNumber: claimedIssue } : {}),
  };
}

/** Enforce the title contract regardless of what the model produced. */
export function postValidateTitle(title: string, refNumber?: number): string {
  let t = title.trim().replace(/\.+$/, '').replace(/\s+/g, ' ');
  // The number leads; strip a model-repeated number from the phrase first.
  if (refNumber !== undefined) {
    t = t.replace(new RegExp(`^#?${refNumber}\\s*[:—-]?\\s*`), '');
  }
  if (t) t = t[0]?.toLowerCase() + t.slice(1);
  const chars = [...t];
  if (chars.length > TITLE_MAX) t = `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…`;
  return refNumber !== undefined ? `${refNumber}: ${t}`.trim().replace(/:\s*$/, ':') : t;
}

/**
 * The one-shot runner call: never throws, never blocks a run — every failure
 * path (runner error, timeout, junk twice) answers null and the caller keeps
 * the heuristic title. `namerModel` is a Claude alias, so it is passed only
 * when the namer runs on Claude (the `plannerModel` precedent).
 */
export async function generateRunName(repoRoot: string, ctx: NamerContext): Promise<NameResult | null> {
  try {
    const config = await loadConfig(repoRoot);
    const runner = createRunner(config.defaultRunner);
    const model = config.defaultRunner === 'claude' ? config.namerModel : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runner.run({
        systemPrompt: NAMER_SYSTEM_PROMPT,
        userPrompt: buildNamerPrompt(ctx),
        cwd: repoRoot,
        allowedTools: [],
        model,
        timeoutMs: NAMER_TIMEOUT_MS,
      });
      const composed = composeNameResult(result.text, ctx);
      if (composed) return composed;
    }
  } catch {
    // runner unavailable / crashed — the heuristic title stays
  }
  return null;
}

/**
 * Raw model text → validated NameResult, or null when the answer is junk
 * (caller retries once, then keeps the heuristic title).
 */
export function composeNameResult(rawText: string, ctx: NamerContext): NameResult | null {
  const parsed = parseStructured(rawText, namerResponseSchema);
  if (!parsed) return null;
  const refs = refineTaskRefs(extractTaskRefs(ctx.task), ctx.skillName);
  const checked = crossCheckRefs(parsed, ctx.task, refs);
  const refNumber = checked.prNumber ?? checked.issueNumber ?? titleRefNumber(refs);
  const titleSummary = postValidateTitle(parsed.title, refNumber);
  if (!titleSummary || titleSummary === String(refNumber ?? '')) return null;
  return { titleSummary, ...checked };
}
