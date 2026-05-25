import { z } from 'zod';
import type { AgentEvent as RunnerAgentEvent } from '../agents/agent-runner.js';
import type { Config } from '../config/config.model.js';
import type { GitHubService } from '../services/github.service.js';
import type { IssueStore } from '../store/store.js';
import { discoverSkills } from '../skills/skill-catalog.js';
import { createWorktree } from '../actions/autofix/worktree.js';
import {
  agentStep,
  type AgentRunRecord,
  type Workflow,
  type WorkflowRunResult,
  type WorkflowStep,
} from './workflow.js';
import { runWorkflow } from './workflow-engine.js';

/**
 * Runtime for the simple "flows" UI (migration 0021). A flow is a named chain
 * of `{ skill, argsTemplate }` steps. This module turns one into a multi-step
 * `Workflow<FlowBlackboard>` and runs it through the existing engine.
 *
 *   - The skill body (from `<repo>/.ai/skills/<name>.md`) is appended to the
 *     step's system prompt via `resolveStepConfig` (existing path).
 *   - The args template is rendered against a fixed scope:
 *       {{input}}                  — passed by the caller (typically the issue number)
 *       {{previousTaskId}}         — the previous step's `agent_runs.id`
 *       {{previousPullRequestUrl}} — `PR_URL=…` parsed from the previous agent's text
 *       {{previousPullRequestNumber}} — `PR_NUMBER=…` parsed from the same
 *   - PR markers are a soft contract: skills that create PRs should emit
 *     `PR_URL=https://github.com/...` and `PR_NUMBER=42` in their final text
 *     so the next step can reference them.
 */

export interface FlowStep {
  skill: string;
  argsTemplate: string;
  /**
   * When set, if the step's text output contains this substring the chain
   * stops cleanly (status succeeded, reason "stopped at step N…"). Simple
   * short-circuit for skills that legitimately decide "no action needed".
   */
  stopChainIfContains?: string;
  /**
   * Extra system-prompt content for this step, prepended to the skill body.
   * When unset (or empty/whitespace-only), `DEFAULT_STEP_NOTES` is used —
   * the marker contract reminder so the chain works even if the skill body
   * doesn't itself document `PR_URL=` / `PR_NUMBER=`.
   */
  systemNotes?: string;
}

export interface FlowRow {
  name: string;
  steps: FlowStep[];
}

export interface RunFlowParams {
  flow: FlowRow;
  input: string;
  store: IssueStore;
  config: Config;
  github: GitHubService;
  issueNumber: number;
  onEvent: (msg: string) => void;
  onAgentEvent: (e: { type: string; [k: string]: unknown }) => void;
  onRunRecord: (r: AgentRunRecord) => void;
  pauseRequested?: () => boolean | Promise<boolean>;
  cancelRequested?: () => boolean | Promise<boolean>;
}

interface FlowBlackboard extends Record<string, unknown> {
  input: string;
  previousTaskId: string;
  previousPullRequestUrl: string;
  previousPullRequestNumber: string;
  /**
   * The previous step's raw text output, truncated. Without this, a step can
   * only reference the prior step by `previousTaskId` (an opaque UUID) — which
   * means the agent has no way to see what the prior agent actually decided.
   * Threaded into the next step's user prompt via `{{previousOutput}}`.
   */
  previousOutput: string;
}

export async function runFlow(params: RunFlowParams): Promise<WorkflowRunResult<FlowBlackboard>> {
  if (params.flow.steps.length === 0) {
    throw new Error(`flow '${params.flow.name}' has no steps`);
  }

  // Discover skills so resolveStepConfig (called by the engine) can find each
  // step's skill body and append it to the system prompt.
  const repoRoot = params.config.autofix?.repoRoot;
  const skills = repoRoot
    ? await discoverSkills(repoRoot, params.config.autofix?.skillsDir ?? '.ai/skills').catch((err: Error) => {
        params.onEvent(`[flow] skill discovery failed: ${err.message}`);
        return [];
      })
    : [];

  // Closure-captured state the engine updates between steps. We need this so
  // each step's `buildUserPrompt` sees the freshest `previousTaskId` (which
  // the engine doesn't expose through the step context directly).
  let lastAgentRunId = '';

  const workflow: Workflow<FlowBlackboard> = {
    id: `flow:${params.flow.name}`,
    title: params.flow.name,
    commentTargetOrder: ['issue', 'pr'],
    initialBlackboard: () => ({
      input: params.input,
      previousTaskId: '',
      previousPullRequestUrl: '',
      previousPullRequestNumber: '',
      previousOutput: '',
    }),
    steps: params.flow.steps.map((step, idx) => makeAgentStepForFlowStep(step, idx, params.config)),
  };

  return runWorkflow(workflow, {
    store: params.store,
    config: params.config,
    github: params.github,
    issueNumber: params.issueNumber,
    apply: true,
    skills,
    // Bindings: per-step, set the skillName so resolveStepConfig appends the
    // skill body to the system prompt. The engine reads these from `bindings`.
    bindings: params.flow.steps.map((step, idx) => ({
      stepId: stepIdFor(idx),
      skillName: step.skill,
      backend: null,
      model: null,
      extraTools: [],
    })),
    prepareWorktree: repoRoot
      ? async () => {
          const wt = await createWorktree({
            repoRoot,
            branch: (params.config.autofix?.branchPrefix ?? 'autofix/cezar-issue-') + params.issueNumber,
            baseBranch: params.config.autofix?.baseBranch ?? 'main',
            remote: params.config.autofix?.remote ?? 'origin',
            fetchRemote: params.config.autofix?.fetchBeforeAttempt ?? true,
            onWarn: (m: string) => params.onEvent(m),
          });
          return { path: wt.path, dispose: wt.dispose };
        }
      : undefined,
    onEvent: params.onEvent,
    onAgentEvent: (e: RunnerAgentEvent) => params.onAgentEvent(e as unknown as { type: string; [k: string]: unknown }),
    onRunRecord: (r: AgentRunRecord) => {
      lastAgentRunId = r.id;
      params.onRunRecord(r);
    },
    pauseRequested: params.pauseRequested,
    cancelRequested: params.cancelRequested,
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function stepIdFor(idx: number): string {
    return `step-${idx + 1}`;
  }

  function makeAgentStepForFlowStep(
    step: FlowStep,
    idx: number,
    cfg: Config,
  ): WorkflowStep<FlowBlackboard> {
    const autofix = cfg.autofix;
    const builtinTools = autofix?.allowedTools ?? ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];
    const bashAllowlist = autofix?.bashAllowlist;
    const maxTurns = autofix?.maxTurns?.fixer ?? 30;
    const model = autofix?.models?.fixer ?? 'claude-sonnet-4-6';

    return agentStep<FlowBlackboard, unknown>({
      id: stepIdFor(idx),
      kind: 'agent',
      builtinSkillId: step.skill,
      builtinSystemPrompt: composeStepSystemPrompt(step),
      builtinModel: model,
      builtinTools,
      bashAllowlist,
      maxTurns,
      cwdRequired: true,
      // Free-form output. We don't enforce JSON; we parse PR_URL/PR_NUMBER
      // markers from the text in onNoParse below.
      responseSchema: z.never() as unknown as z.ZodSchema<unknown>,
      buildUserPrompt: (ctx) => {
        // Refresh `previousTaskId` from the closure right before render — it's
        // updated by `onRunRecord` between steps.
        const scope: FlowBlackboard = {
          ...ctx.blackboard,
          previousTaskId: lastAgentRunId,
        };
        return renderTemplate(step.argsTemplate, scope);
      },
      // If the agent emitted JSON that happened to validate, we still want
      // to chain — but `z.never()` ensures this branch never fires.
      onResult: () => ({ kind: 'continue' as const }),
      onNoParse: (rawText, _ctx) => {
        const { url, number } = extractPrMarkers(rawText);
        const patch: Partial<FlowBlackboard> = {
          previousPullRequestUrl: url ?? '',
          previousPullRequestNumber: number != null ? String(number) : '',
          previousOutput: truncateOutput(rawText),
        };
        // Stop-chain: cleanly end the workflow when the agent's output
        // contains the configured marker. We rely on `skip-run` rather than
        // a hard fail so the cockpit shows it as `succeeded (with reason)`.
        if (step.stopChainIfContains && rawText.includes(step.stopChainIfContains)) {
          return {
            kind: 'skip-run',
            reason: `stopped at step ${idx + 1}: output matched "${step.stopChainIfContains}"`,
          };
        }
        // Hard fail when the skill explicitly reports a blocked/failed status.
        // Convention used by the autofix skill set ('fix', 'open-pr', etc.):
        // an end-of-output line like `Status: blocked` or `Status: failed`
        // means "I cannot proceed safely; do not run downstream steps."
        // Returning `fail` here (vs `continue`) marks the step failed in the
        // cockpit AND stops the chain — otherwise a no-op fix would cascade
        // into open-pr opening nothing, then review-pr asking which PR.
        const statusFailMatch = rawText.match(STATUS_FAIL_RE);
        if (statusFailMatch) {
          const status = statusFailMatch[1].toLowerCase();
          const tailReason = extractStatusReason(rawText, statusFailMatch.index ?? 0);
          return {
            kind: 'fail',
            reason: `step ${idx + 1} (\`${step.skill}\`) reported Status: ${status}${tailReason ? ` — ${tailReason}` : ''}`,
            blackboardPatch: patch,
          };
        }
        return { kind: 'continue', blackboardPatch: patch };
      },
      // Render the agent's actual output into the living comment. The flow
      // runtime never enforces a JSON schema, so the engine takes the
      // `unparsedCommentSection` path (not `commentSection`).
      unparsedCommentSection: (rawText) => ({
        heading: flowStepHeading(idx, step, rawText),
        body: flowStepBody(rawText),
      }),
      failCommentSection: (reason) => ({
        heading: `Step ${idx + 1} — \`${step.skill}\` (failed)`,
        body: reason,
      }),
    });
  }
}

// ─── Living-comment rendering helpers ──────────────────────────────────────

const STOP_MARKER_RE = /^NO_ACTION_NEEDED\b/m;
const MAX_BODY_CHARS = 1500;

/** Cap on `{{previousOutput}}` (chars) so a chain of long outputs doesn't
 *  cascade into runaway prompts. ~8KB ≈ ~2k tokens — enough for a structured
 *  brief, not enough to balloon. */
const MAX_PREV_OUTPUT_CHARS = 8000;

/** Matches an end-of-output `Status: blocked` / `Status: failed` marker (per the
 *  autofix skill set's output contract). Case-insensitive, line-anchored. */
const STATUS_FAIL_RE = /^Status:\s*(blocked|failed)\b/im;

function truncateOutput(rawText: string): string {
  const trimmed = (rawText ?? '').trim();
  if (trimmed.length <= MAX_PREV_OUTPUT_CHARS) return trimmed;
  return `… (truncated; showing last ${MAX_PREV_OUTPUT_CHARS} chars)\n\n${trimmed.slice(-MAX_PREV_OUTPUT_CHARS)}`;
}

/** Grab a one-line reason that follows a `Status: blocked|failed` marker. */
function extractStatusReason(rawText: string, matchIndex: number): string {
  // Take the rest of the matched line + the next non-empty line as the reason.
  const after = rawText.slice(matchIndex);
  const lines = after.split(/\r?\n/);
  const sameLineRest = lines[0].replace(STATUS_FAIL_RE, '').trim();
  if (sameLineRest) return sameLineRest.slice(0, 200);
  const nextLine = (lines[1] ?? '').trim();
  return nextLine.slice(0, 200);
}

function flowStepHeading(idx: number, step: FlowStep, rawText: string): string {
  const base = `Step ${idx + 1} — \`${step.skill}\``;
  if (step.stopChainIfContains && rawText.includes(step.stopChainIfContains)) {
    return `${base} (stopped: \`${step.stopChainIfContains}\`)`;
  }
  if (STOP_MARKER_RE.test(rawText)) return `${base} (stopped: \`NO_ACTION_NEEDED\`)`;
  const { url, number } = extractPrMarkers(rawText);
  if (url && number != null) return `${base} → PR [#${number}](${url})`;
  return base;
}

/**
 * Render the most useful tail of the agent's output. Most skills end with a
 * structured summary block (Status/Files changed/Summary/…); the last ~1500
 * chars reliably capture that without flooding the GitHub comment with full
 * tool-call transcripts.
 */
function flowStepBody(rawText: string): string {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return '_(no output)_';
  if (trimmed.length <= MAX_BODY_CHARS) return trimmed;
  const tail = trimmed.slice(-MAX_BODY_CHARS).trimStart();
  return `_… (truncated; showing last ${MAX_BODY_CHARS} chars)_\n\n${tail}`;
}

// ─── PR marker extraction ──────────────────────────────────────────────────

/**
 * Extracts `PR_URL=...` and `PR_NUMBER=...` markers from a step's text output.
 * Soft contract: skills that create PRs should print these lines (anywhere in
 * the response) so the next step can reference them via `{{previousPullRequest*}}`.
 * Also tries common URL patterns as a fallback.
 */
export function extractPrMarkers(text: string): { url: string | null; number: number | null } {
  let url: string | null = null;
  let number: number | null = null;

  const urlMatch = text.match(/PR_URL\s*=\s*(\S+)/);
  if (urlMatch) url = urlMatch[1];
  const numMatch = text.match(/PR_NUMBER\s*=\s*(\d+)/);
  if (numMatch) number = Number(numMatch[1]);

  // Fallback: scrape any GitHub PR URL.
  if (!url) {
    const fall = text.match(/https?:\/\/[\w./-]*github\.com\/[\w-]+\/[\w.-]+\/pull\/(\d+)/);
    if (fall) {
      url = fall[0];
      if (number == null) number = Number(fall[1]);
    }
  }
  return { url, number };
}

// ─── Template rendering ────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Render `{{path}}` references against a flat scope. Missing → empty string. */
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(TEMPLATE_RE, (_, path: string) => {
    const v = lookupDotPath(scope, path);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

function lookupDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ─── Per-step scaffolding system prompt ────────────────────────────────────

/**
 * Minimal scaffolding shipped to every flow step. Generic — describes that
 * this is one step of a workflow and that the skill body holds the actual
 * instructions. The marker contract lives in `DEFAULT_STEP_NOTES` so users
 * can edit/override it per step (see `step.systemNotes`).
 */
export const FLOW_STEP_SCAFFOLDING = `You are an agent executing one step of a user-defined workflow. Follow the SKILL instructions appended below to complete the task described in the user message.

When the task is done, respond with a short plain-text summary (no JSON).`;

/**
 * Default notes prepended to the skill body when `step.systemNotes` is unset.
 * Documents the marker contract that lets the next step reference the PR via
 * `{{previousPullRequestUrl}}` / `{{previousPullRequestNumber}}` templates.
 * Users override this per step via the pencil/notes panel in the editor.
 */
export const DEFAULT_STEP_NOTES = `If you open a pull request, end your response with two lines on separate lines:
  PR_URL=<the PR url>
  PR_NUMBER=<the PR number>
so the next step in the workflow can reference it via {{previousPullRequestUrl}} / {{previousPullRequestNumber}}.`;

/** Back-compat alias — kept temporarily for any out-of-tree code. */
export const FLOW_STEP_SYSTEM_PROMPT = FLOW_STEP_SCAFFOLDING + '\n\n' + DEFAULT_STEP_NOTES;

/** What the scaffolding+notes actually compose to at run time. */
export function effectiveStepNotes(step: FlowStep): string {
  const trimmed = (step.systemNotes ?? '').trim();
  return trimmed.length > 0 ? step.systemNotes! : DEFAULT_STEP_NOTES;
}

/** The system prompt the engine actually sends (before the skill body is appended). */
export function composeStepSystemPrompt(step: FlowStep): string {
  return `${FLOW_STEP_SCAFFOLDING}\n\n${effectiveStepNotes(step)}`;
}
