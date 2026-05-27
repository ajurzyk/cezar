/**
 * Workspace label catalog — the per-workspace label vocabulary produced by
 * the label-analysis job and materialized into `workspace_labels`. The catalog
 * is loaded by the GUI dispatch layer and threaded through to each agent step
 * via {@link formatLabelCatalogPrompt}, which renders a markdown section that
 * the system prompt composer appends to the skill body.
 *
 * The shape mirrors the `workspace_labels` table (see migration 0022). It's
 * defined here in `@cezar/core` so the workflow engine, autofix workflow,
 * flow runner, and triage runner can all consume the same type without
 * each importing the GUI's supabase types.
 */
export type LabelScope = 'issue' | 'pr' | 'both';

export interface WorkspaceLabel {
  name: string;
  scope: LabelScope;
  color?: string | null;
  description?: string | null;
  when_to_add?: string | null;
  when_to_remove?: string | null;
  add_meaning?: string | null;
  remove_meaning?: string | null;
}

/**
 * Which subset of the catalog applies to a given agent step. `issue` keeps
 * issue + both; `pr` keeps pr + both; `both` keeps everything.
 */
export type LabelPromptScope = 'issue' | 'pr' | 'both';

function filterByScope(labels: WorkspaceLabel[], scope: LabelPromptScope): WorkspaceLabel[] {
  if (scope === 'both') return labels;
  return labels.filter((l) => l.scope === scope || l.scope === 'both');
}

function renderLabelEntry(l: WorkspaceLabel): string {
  const lines: string[] = [`- \`${l.name}\` (scope: ${l.scope})`];
  if (l.description) lines.push(`  - Description: ${l.description}`);
  if (l.when_to_add) lines.push(`  - When to add: ${l.when_to_add}`);
  if (l.when_to_remove) lines.push(`  - When to remove: ${l.when_to_remove}`);
  if (l.add_meaning) lines.push(`  - Adding signals: ${l.add_meaning}`);
  if (l.remove_meaning) lines.push(`  - Removing signals: ${l.remove_meaning}`);
  return lines.join('\n');
}

/**
 * Render the label catalog as a markdown section suitable for appending to an
 * agent's system prompt. Returns an empty string when there are no labels in
 * the requested scope so callers can unconditionally concat the result.
 *
 * `target` controls the usage-instructions paragraph: `'issue'` and `'pr'`
 * tell the agent which gh CLI command to use; `'both'` describes both.
 */
export function formatLabelCatalogPrompt(
  labels: WorkspaceLabel[] | null | undefined,
  scope: LabelPromptScope,
  target: LabelPromptScope = scope,
): string {
  if (!labels || labels.length === 0) return '';
  const filtered = filterByScope(labels, scope);
  if (filtered.length === 0) return '';

  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  const entries = sorted.map(renderLabelEntry).join('\n');

  const usage = renderUsageInstructions(target);

  return [
    '## Repository label catalog',
    '',
    'This repository uses a curated set of GitHub labels as a *design language* for triage, scope, and review state. Treat the catalog below as authoritative: use the listed names exactly, respect the scope (issue vs PR), and follow the "when to add / when to remove" guidance.',
    '',
    entries,
    '',
    usage,
  ].join('\n');
}

function renderUsageInstructions(target: LabelPromptScope): string {
  const lines: string[] = [
    '### Using labels as a tool',
    '',
    'Labels are not just documentation — they are how Cezar and the team communicate state. When the guidance above says a label should be added or removed for the situation you observe, apply it yourself (do not just describe what should happen). When in doubt, prefer adding a label that is clearly warranted over leaving it off.',
    '',
    'Rules:',
    '- Only use label names that appear in the catalog above. Do not invent new labels.',
    '- Respect scope: issue-scoped labels go on issues; pr-scoped labels go on PRs; `both` labels apply to either.',
    '- Apply labels via the `gh` CLI from inside the checked-out repo.',
  ];

  if (target === 'issue' || target === 'both') {
    lines.push(
      '',
      'For issues:',
      '```',
      'gh issue edit <number> --add-label "<exact-label-name>"',
      'gh issue edit <number> --remove-label "<exact-label-name>"',
      '```',
    );
  }
  if (target === 'pr' || target === 'both') {
    lines.push(
      '',
      'For pull requests:',
      '```',
      'gh pr edit <number> --add-label "<exact-label-name>"',
      'gh pr edit <number> --remove-label "<exact-label-name>"',
      '```',
    );
  }

  lines.push(
    '',
    'When you change labels, briefly note in your output which labels you added or removed and why — this keeps the audit trail readable.',
  );
  return lines.join('\n');
}
