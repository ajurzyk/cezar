import type { ActionDef } from './action.js';

/**
 * Built-in default Action catalog — 2 actions: `auto-triage` (classification
 * + duplicate detection in one pass) and `security`.
 *
 * The CLI consumes this catalog directly because it has no Supabase client.
 * The SaaS path seeds from it too — `packages/gui/src/lib/seed-default-actions.ts`
 * upserts these specs into the `actions` table (the SQL seed function was
 * retired in migration 0044). This file is the single seed source.
 *
 * `id` and `workspaceId` are intentionally blank — the CLI never persists
 * Action rows, and the runner treats `ActionDef` as a pure spec.
 */
export const DEFAULT_ACTIONS: ActionDef[] = [
  {
    id: '',
    workspaceId: '',
    name: 'auto-triage',
    kind: 'built-in',
    description:
      'First triage pass per issue: adds a bug or feature label and links confident duplicates against the open-issue knowledge base. Never comments, closes, or assigns.',
    systemPrompt:
      'You are running the first triage pass on an issue. Follow the auto-triage playbook in your reference skills. Do two things: (a) classify the issue and add ONLY a `bug` or `feature` label via label.add — questions, docs, and anything else get no label; (b) when the user message contains an "Open-issue knowledge base" section, compare the issue against it and call link-duplicate on a confident match — never close. If the section is absent, skip the duplicate check. When a `suggest-workflow` tool is available and you added a `bug` label with no duplicate found, call it once with a one-line reason. Never comment, close, or assign. Include `_confidence` (integer 0-100) on every effect tool call. Calibrate: >=90 only when the evidence is unambiguous; 60-89 for plausible but contestable calls; below 60 do not call the tool at all.',
    skillRefs: ['auto-triage-playbook', 'bug-classification', 'dedupe-heuristics'],
    contextRefs: ['open-issues'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-reopened', 'manual'],
    effects: null,
    outputSchema: null,
    enabled: true,
    acceptanceMode: 'human-in-the-loop',
    confidenceConfig: { autoAcceptAbove: 90, autoDenyBelow: 60 },
  },
  {
    id: '',
    workspaceId: '',
    name: 'security',
    kind: 'built-in',
    description: 'Flag issues with security implications, even when not explicitly labelled.',
    systemPrompt:
      'Apply the security-signals playbook in your reference skills. Flag only at confidence ≥ 0.70 — a false positive beats a missed vulnerability. Add a security label via label.add. Any comment you post must be short and to the point — finding, severity, evidence; no filler.',
    skillRefs: ['security-signals'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-edited', 'manual'],
    effects: ['label.add', 'comment'],
    outputSchema: {
      type: 'object',
      required: ['isSecurityRelated', 'confidence'],
      properties: {
        isSecurityRelated: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        category: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        explanation: { type: 'string' },
      },
    },
    enabled: true,
  },
];
