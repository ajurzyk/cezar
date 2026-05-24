'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import {
  renderStepPreview,
  type FlowStep,
  type FlowStepOutcome,
  type FlowSummary,
  type FlowTrigger,
  type PreviewResult,
} from './actions';

/**
 * Mirrors `DEFAULT_STEP_NOTES` in `@/lib/flow-runner` — kept here as a literal
 * so the client bundle doesn't pull node-only deps. Update both together.
 */
const DEFAULT_STEP_NOTES_TEXT = `If you open a pull request, end your response with two lines on separate lines:
  PR_URL=<the PR url>
  PR_NUMBER=<the PR number>
so the next step in the workflow can reference it via {{previousPullRequestUrl}} / {{previousPullRequestNumber}}.`;

export interface SkillOption {
  name: string;
  description: string;
}

export interface FlowCardProps {
  flow: FlowSummary;
  canWrite: boolean;
  availableSkills: SkillOption[];
  onNameChange: (name: string) => void;
  onStepChange: (idx: number, patch: Partial<FlowStep>) => void;
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onMoveStepDown: (idx: number) => void;
  onTriggersChange: (triggers: FlowTrigger[]) => void;
  onPausedChange: (paused: boolean) => void;
  onDelete: () => void;
  onRun: (issue: number) => void;
  onOpenRun: () => void;
}

const TEMPLATE_VARS = [
  { name: 'input', label: '{{input}}', hint: 'value passed when the flow runs' },
  { name: 'previousTaskId', label: '{{previousTaskId}}', hint: 'previous step\'s agent_runs.id' },
  { name: 'previousPullRequestUrl', label: '{{previousPullRequestUrl}}', hint: 'PR url from previous step (if any)' },
  { name: 'previousPullRequestNumber', label: '{{previousPullRequestNumber}}', hint: 'PR number from previous step (if any)' },
] as const;

const PR_CREATING_PATTERN = /(fix|open|create|pr|pull|merge|raise)/i;

export function FlowCard(props: FlowCardProps) {
  const { flow } = props;

  return (
    <div
      className={
        'rounded-lg border bg-bg-elevated p-4 ' +
        (flow.paused ? 'border-border/60 opacity-90' : 'border-border')
      }
    >
      {/* Name + pause toggle + flow actions */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
            Name
          </label>
          <input
            type="text"
            value={flow.name}
            onChange={(e) => props.onNameChange(e.target.value)}
            disabled={!props.canWrite}
            className="mt-1 w-full rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg focus:border-accent/50 focus:outline-none"
            placeholder="fix github issue"
          />
        </div>
        {props.canWrite && (
          <>
            <PauseToggle
              paused={flow.paused}
              onChange={props.onPausedChange}
            />
            <button
              onClick={props.onAddStep}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:bg-bg"
            >
              <PlusIcon /> Step
            </button>
            <button
              onClick={props.onDelete}
              aria-label="Delete flow"
              className="rounded-md border border-border bg-bg-subtle px-2 py-2 text-rose-400 hover:bg-rose-500/10"
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>

      {/* Stats + history strip */}
      {!flow.id.startsWith('__new__') && (flow.recentRuns.length > 0 || flow.stats.totalLast7d > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {flow.stats.totalLast7d > 0 && (
            <span
              className="rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted"
              title="Successful runs in the last 7 days"
            >
              ✓ <span className="text-fg">{flow.stats.succeededLast7d}/{flow.stats.totalLast7d}</span>{' '}
              <span className="text-fg-muted/60">(7d)</span>
            </span>
          )}
          {flow.stats.avgTokens > 0 && (
            <span
              className="rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted"
              title="Average cost-weighted tokens per run, last 7 days"
            >
              ~<span className="text-fg">{formatTokens(flow.stats.avgTokens)}</span> tokens/run
            </span>
          )}
          {flow.recentRuns.length > 0 && (
            <span className="ml-1 flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-fg-muted/60">recent</span>
              {flow.recentRuns.map((r) => (
                <a
                  key={r.id}
                  href={`/cockpit/${r.id}`}
                  title={`${r.status}${r.issueNumber != null ? ` · #${r.issueNumber}` : ''} · ${new Date(r.startedAt).toLocaleString()}`}
                  className={`inline-block h-3 w-3 rounded-sm ${historyDotClass(r.status)}`}
                />
              ))}
            </span>
          )}
          {flow.paused && (
            <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
              paused
            </span>
          )}
        </div>
      )}

      {/* Triggers panel */}
      <TriggersPanel
        triggers={flow.triggers}
        canWrite={props.canWrite}
        onChange={props.onTriggersChange}
      />

      {/* Steps */}
      <div className="mt-4 space-y-2">
        {flow.steps.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No steps yet. {props.canWrite && 'Click "+ Step" to add one.'}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[auto_minmax(220px,1fr)_minmax(220px,2fr)_auto_auto] gap-3 px-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              <div>Step</div>
              <div>Skill</div>
              <div>Args template</div>
              <div></div>
              <div></div>
            </div>
            {flow.steps.map((step, idx) => (
              <StepRow
                key={idx}
                step={step}
                idx={idx}
                steps={flow.steps}
                flowId={flow.id}
                canWrite={props.canWrite}
                availableSkills={props.availableSkills}
                stepOutcome={flow.lastRun?.steps.find((s) => s.stepId === `step-${idx + 1}`)}
                onChange={(patch) => props.onStepChange(idx, patch)}
                onRemove={() => props.onRemoveStep(idx)}
                onMoveDown={() => props.onMoveStepDown(idx)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Run on issue + most-recent run summary */}
      {!flow.id.startsWith('__new__') && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          {props.canWrite ? (
            <RunOnIssue onRun={props.onRun} />
          ) : (
            <span className="text-xs text-fg-muted">Viewers can&apos;t start runs.</span>
          )}
          {flow.lastRun && (
            <div className="flex items-center gap-2 text-xs">
              <StatusBadge status={flow.lastRun.status} />
              <span className="text-fg-muted">
                {flow.lastRun.issueNumber != null ? `#${flow.lastRun.issueNumber}` : ''}
                {' · '}
                {new Date(flow.lastRun.startedAt).toLocaleString()}
              </span>
              {flow.lastRun.reason && (
                <span className="text-fg-muted" title={flow.lastRun.reason}>
                  · {flow.lastRun.reason.slice(0, 80)}
                  {flow.lastRun.reason.length > 80 ? '…' : ''}
                </span>
              )}
              <button onClick={props.onOpenRun} className="text-accent hover:underline">
                Open →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pause toggle ───────────────────────────────────────────────────────────

function PauseToggle({ paused, onChange }: { paused: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!paused)}
      aria-pressed={!paused}
      title={paused ? 'Resume auto-triggers' : 'Pause auto-triggers'}
      className={
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium transition ' +
        (paused
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15'
          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15')
      }
    >
      <span className={`inline-block h-2 w-2 rounded-full ${paused ? 'bg-amber-400' : 'bg-emerald-400'}`} />
      {paused ? 'Paused' : 'Active'}
    </button>
  );
}

// ─── Step notes (pencil disclosure) ────────────────────────────────────────

function StepNotesPanel({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const overriding = value.trim().length > 0;
  return (
    <div className="mt-2 rounded-md border border-border bg-bg p-3">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide">
        <span className="text-fg-muted">Step notes — extra system-prompt content</span>
        <span className={overriding ? 'text-accent' : 'text-fg-muted/70'}>
          {overriding ? 'overriding default' : 'using default'}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={DEFAULT_STEP_NOTES_TEXT}
        spellCheck={false}
        rows={6}
        className="block w-full resize-y rounded-md border border-border/60 bg-bg-subtle px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg placeholder:text-fg-muted/60 focus:border-accent/50 focus:outline-none"
      />
      <p className="mt-1 text-[10px] text-fg-muted/80">
        Prepended to the skill body at run time. Leave empty to use the default (the `PR_URL=` / `PR_NUMBER=` marker contract).
      </p>
    </div>
  );
}

// ─── Stop-chain input ───────────────────────────────────────────────────────

function StopChainInput({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const empty = !value;
  return (
    <div className="mt-1 flex items-center gap-1.5 px-1">
      <span className={`text-[10px] uppercase tracking-wide ${empty ? 'text-fg-muted/60' : 'text-amber-300/80'}`}>
        Stop chain if output contains
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="NO_ACTION_NEEDED"
        className={
          'flex-1 rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg focus:border-accent/50 focus:outline-none ' +
          (empty ? 'opacity-60 focus:opacity-100' : '')
        }
      />
    </div>
  );
}

// ─── Helpers (formatting + history dots) ────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function historyDotClass(status: string): string {
  if (status === 'succeeded') return 'bg-emerald-500/70';
  if (status === 'failed') return 'bg-rose-500/70';
  if (status === 'running') return 'bg-amber-400/80';
  if (status === 'cancelled') return 'bg-fg-muted/40';
  if (status === 'paused') return 'bg-amber-300/60';
  return 'bg-fg-muted/40';
}

// ─── Step row (with autocomplete, lint, preview, output) ────────────────────

function StepRow(props: {
  step: FlowStep;
  idx: number;
  steps: FlowStep[];
  flowId: string;
  canWrite: boolean;
  availableSkills: SkillOption[];
  stepOutcome?: FlowStepOutcome;
  onChange: (patch: Partial<FlowStep>) => void;
  onRemove: () => void;
  onMoveDown: () => void;
}) {
  const { step, idx } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const skillDescription = useMemo(
    () => props.availableSkills.find((s) => s.name === step.skill)?.description ?? '',
    [props.availableSkills, step.skill],
  );

  const lintWarnings = useMemo(
    () => lintArgsTemplate(step.argsTemplate, idx, props.steps),
    [step.argsTemplate, idx, props.steps],
  );

  return (
    <div className="rounded-md border border-border/60 bg-bg-subtle/40 p-2">
      <div className="grid grid-cols-[auto_minmax(220px,1fr)_minmax(220px,2fr)_auto_auto] items-start gap-3">
        <div className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
          Step {idx + 1}
        </div>
        <div>
          <SkillPicker
            value={step.skill}
            options={props.availableSkills}
            onChange={(skill) => props.onChange({ skill })}
            disabled={!props.canWrite}
          />
          {step.skill && skillDescription && (
            <p className="mt-1 px-1 text-[11px] text-fg-muted/80 leading-snug">
              {skillDescription}
            </p>
          )}
          {step.skill && !skillDescription && (
            <p className="mt-1 px-1 text-[11px] text-fg-muted/50">
              (no description — add one in the skill\'s frontmatter)
            </p>
          )}
        </div>
        <div>
          <ArgsTemplateInput
            value={step.argsTemplate}
            disabled={!props.canWrite}
            onChange={(argsTemplate) => props.onChange({ argsTemplate })}
          />
          <StopChainInput
            value={step.stopChainIfContains ?? ''}
            disabled={!props.canWrite}
            onChange={(v) =>
              props.onChange({ stopChainIfContains: v ? v : undefined })
            }
          />
          {lintWarnings.length > 0 && (
            <ul className="mt-1 space-y-0.5 px-1">
              {lintWarnings.map((w, i) => (
                <li key={i} className="text-[11px] text-amber-300/90 leading-snug">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <IconButton
            disabled={!props.canWrite || idx === props.steps.length - 1}
            ariaLabel="Move step down"
            onClick={props.onMoveDown}
          >
            <ArrowDownIcon />
          </IconButton>
          {!props.flowId.startsWith('__new__') && (
            <IconButton
              ariaLabel="Toggle preview"
              onClick={() => setPreviewOpen((v) => !v)}
              tone={previewOpen ? 'accent' : 'neutral'}
            >
              <EyeIcon />
            </IconButton>
          )}
          <IconButton
            ariaLabel={
              step.systemNotes && step.systemNotes.trim()
                ? 'Edit step notes (overrides default)'
                : 'Edit step notes (using default marker contract)'
            }
            onClick={() => setNotesOpen((v) => !v)}
            tone={notesOpen ? 'accent' : step.systemNotes && step.systemNotes.trim() ? 'accent' : 'neutral'}
          >
            <PencilIcon />
          </IconButton>
        </div>
        <div className="flex flex-col gap-1">
          <IconButton
            disabled={!props.canWrite}
            ariaLabel="Remove step"
            tone="danger"
            onClick={props.onRemove}
          >
            <TrashIcon />
          </IconButton>
          {props.stepOutcome && (
            <IconButton
              ariaLabel="Toggle output"
              onClick={() => setOutputOpen((v) => !v)}
              tone={outputOpen ? 'accent' : 'neutral'}
            >
              <ChatIcon />
            </IconButton>
          )}
        </div>
      </div>

      {notesOpen && (
        <StepNotesPanel
          value={step.systemNotes ?? ''}
          disabled={!props.canWrite}
          onChange={(systemNotes) =>
            props.onChange({ systemNotes: systemNotes ? systemNotes : undefined })
          }
        />
      )}

      {previewOpen && !props.flowId.startsWith('__new__') && (
        <StepPreview flowId={props.flowId} stepIdx={idx} />
      )}

      {outputOpen && props.stepOutcome && (
        <div className="mt-2 rounded-md border border-border bg-bg p-3">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-fg-muted">
            <span>Last run · {props.stepOutcome.stepId}</span>
            <StatusBadge status={props.stepOutcome.status} />
          </div>
          {props.stepOutcome.output ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg/90">
              {props.stepOutcome.output}
            </pre>
          ) : (
            <p className="text-[11px] text-fg-muted">(no captured output)</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Skill picker with description hint ─────────────────────────────────────

function SkillPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: SkillOption[];
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  if (options.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="auto-fix-github"
        className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 font-mono text-xs text-fg focus:border-accent/50 focus:outline-none"
      />
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 font-mono text-xs text-fg focus:border-accent/50 focus:outline-none"
    >
      <option value="">— pick a skill —</option>
      {!options.find((o) => o.name === value) && value && (
        <option value={value}>{value} (custom)</option>
      )}
      {options.map((o) => (
        <option key={o.name} value={o.name}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

// ─── Args template input with autocomplete ──────────────────────────────────

function ArgsTemplateInput({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Show autocomplete when the cursor sits just after `{{` with no `}}` yet.
  const updateAutocompleteState = () => {
    const input = inputRef.current;
    if (!input) return;
    const pos = input.selectionStart ?? 0;
    const before = input.value.slice(0, pos);
    const after = input.value.slice(pos);
    const openIdx = before.lastIndexOf('{{');
    const closeIdx = before.lastIndexOf('}}');
    const open = openIdx > closeIdx;
    const hasCloser = open && after.indexOf('}}') !== -1 && after.indexOf('}}') < (after.indexOf('{{') === -1 ? Infinity : after.indexOf('{{'));
    setShowAutocomplete(open && !hasCloser);
    setHighlight(0);
  };

  const insertVariable = (varName: string) => {
    const input = inputRef.current;
    if (!input) return;
    const pos = input.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const openIdx = before.lastIndexOf('{{');
    const newBefore = before.slice(0, openIdx) + '{{' + varName + '}}';
    const newValue = newBefore + after;
    onChange(newValue);
    setShowAutocomplete(false);
    // Restore focus + cursor after React commits the new value.
    window.setTimeout(() => {
      input.focus();
      const cursor = newBefore.length;
      input.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showAutocomplete) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % TEMPLATE_VARS.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + TEMPLATE_VARS.length) % TEMPLATE_VARS.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertVariable(TEMPLATE_VARS[highlight].name);
    } else if (e.key === 'Escape') {
      setShowAutocomplete(false);
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Defer so selectionStart reflects the post-change state.
          window.setTimeout(updateAutocompleteState, 0);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={updateAutocompleteState}
        onClick={updateAutocompleteState}
        onBlur={() => window.setTimeout(() => setShowAutocomplete(false), 100)}
        disabled={disabled}
        placeholder="{{input}}"
        className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 font-mono text-xs text-fg focus:border-accent/50 focus:outline-none"
      />
      {showAutocomplete && (
        <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-md border border-border bg-bg-elevated shadow-lg">
          {TEMPLATE_VARS.map((v, i) => (
            <button
              key={v.name}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertVariable(v.name);
              }}
              className={
                'block w-full px-3 py-1.5 text-left text-xs ' +
                (i === highlight ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-subtle')
              }
            >
              <span className="font-mono">{v.label}</span>
              <span className="ml-2 text-[10px] text-fg-muted/80">— {v.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Lint heuristics ────────────────────────────────────────────────────────

/**
 * Static checks for an args template:
 *   - `{{previous*}}` used in step 1 → no previous step yet
 *   - PR vars used after a step whose skill name doesn't look PR-creating
 *   - Unknown `{{vars}}` (not in TEMPLATE_VARS)
 */
function lintArgsTemplate(tpl: string, stepIdx: number, allSteps: FlowStep[]): string[] {
  const out: string[] = [];
  const refs = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  for (const m of tpl.matchAll(re)) refs.add(m[1]);

  const known = new Set<string>(TEMPLATE_VARS.map((v) => v.name));

  for (const ref of refs) {
    if (!known.has(ref)) {
      out.push(`unknown template var '{{${ref}}}'`);
    }
  }

  const usesAnyPrevious =
    refs.has('previousTaskId') || refs.has('previousPullRequestUrl') || refs.has('previousPullRequestNumber');
  if (usesAnyPrevious && stepIdx === 0) {
    out.push("'previous*' references have no value in the first step");
  }

  const usesPrevPr = refs.has('previousPullRequestUrl') || refs.has('previousPullRequestNumber');
  if (usesPrevPr && stepIdx > 0) {
    const prev = allSteps[stepIdx - 1];
    if (prev && prev.skill && !PR_CREATING_PATTERN.test(prev.skill)) {
      out.push(
        `previous step '${prev.skill}' may not open a PR — '{{previousPullRequest*}}' could be empty`,
      );
    }
  }

  return out;
}

// ─── Triggers panel ─────────────────────────────────────────────────────────

function TriggersPanel({
  triggers,
  canWrite,
  onChange,
}: {
  triggers: FlowTrigger[];
  canWrite: boolean;
  onChange: (next: FlowTrigger[]) => void;
}) {
  const openedOn = triggers.some((t) => t.kind === 'issue.opened');
  const labelTriggers = triggers.filter((t): t is { kind: 'issue.labeled'; label: string } => t.kind === 'issue.labeled');
  const [draftLabel, setDraftLabel] = useState('');

  const setOpenedOn = (on: boolean) => {
    if (on === openedOn) return;
    const next: FlowTrigger[] = triggers.filter((t) => t.kind !== 'issue.opened');
    if (on) next.push({ kind: 'issue.opened' });
    onChange(next);
  };

  const addLabel = () => {
    const t = draftLabel.trim();
    if (!t) return;
    if (labelTriggers.some((lt) => lt.label === t)) {
      setDraftLabel('');
      return;
    }
    onChange([...triggers, { kind: 'issue.labeled', label: t }]);
    setDraftLabel('');
  };

  const removeLabel = (label: string) => {
    onChange(triggers.filter((t) => !(t.kind === 'issue.labeled' && t.label === label)));
  };

  return (
    <details className="mt-3 rounded-md border border-border/60 bg-bg-subtle/40">
      <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
        Run automatically when…{' '}
        <span className="text-fg-muted/60 normal-case">
          ({triggers.length === 0 ? 'manual only' : describeTriggers(triggers)})
        </span>
      </summary>
      <div className="space-y-2 border-t border-border/60 p-3">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={openedOn}
            onChange={(e) => setOpenedOn(e.target.checked)}
            disabled={!canWrite}
            className="h-4 w-4 rounded border-border bg-bg-subtle accent-accent"
          />
          An issue is <strong className="font-semibold">opened</strong>
        </label>
        <div>
          <div className="text-sm text-fg">A label is added:</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {labelTriggers.map((lt) => (
              <span
                key={lt.label}
                className="inline-flex items-center gap-1 rounded bg-bg px-2 py-0.5 font-mono text-[11px] text-fg"
              >
                {lt.label}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => removeLabel(lt.label)}
                    aria-label={`remove ${lt.label}`}
                    className="text-fg-muted hover:text-rose-400"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {canWrite && (
              <span className="inline-flex items-center gap-1">
                <input
                  type="text"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addLabel();
                    }
                  }}
                  placeholder="auto-fix"
                  className="w-32 rounded-md border border-border bg-bg-subtle px-2 py-1 font-mono text-[11px] text-fg focus:border-accent/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={addLabel}
                  disabled={!draftLabel.trim()}
                  className="rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11px] text-fg hover:bg-bg disabled:opacity-50"
                >
                  Add
                </button>
              </span>
            )}
          </div>
        </div>
        <p className="text-[11px] text-fg-muted">
          Triggers fire via the GitHub App webhook. The dispatcher dedupes against in-flight jobs for the same flow+issue.
        </p>
      </div>
    </details>
  );
}

function describeTriggers(triggers: FlowTrigger[]): string {
  const parts: string[] = [];
  if (triggers.some((t) => t.kind === 'issue.opened')) parts.push('issue opened');
  const labels = triggers
    .filter((t): t is { kind: 'issue.labeled'; label: string } => t.kind === 'issue.labeled')
    .map((t) => `:${t.label}`);
  if (labels.length > 0) parts.push(`label ${labels.join(', ')}`);
  return parts.join(' · ');
}

// ─── Preview pane ───────────────────────────────────────────────────────────

function StepPreview({ flowId, stepIdx }: { flowId: string; stepIdx: number }) {
  const [sampleInput, setSampleInput] = useState('42');
  const [samplePrev, setSamplePrev] = useState({ taskId: '', prUrl: '', prNumber: '' });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startTransition] = useTransition();

  const run = () => {
    setError(null);
    startTransition(async () => {
      const result = await renderStepPreview({
        flowId,
        stepIdx,
        sampleInput,
        samplePrevTaskId: samplePrev.taskId,
        samplePrevPrUrl: samplePrev.prUrl,
        samplePrevPrNumber: samplePrev.prNumber,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result);
    });
  };

  // Auto-render on open with default sample.
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-2 rounded-md border border-border bg-bg p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wide text-fg-muted">Preview · sample:</span>
        <label className="inline-flex items-center gap-1">
          <span className="text-fg-muted">input</span>
          <input
            type="text"
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
            className="w-20 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-xs text-fg"
          />
        </label>
        {stepIdx > 0 && (
          <>
            <label className="inline-flex items-center gap-1">
              <span className="text-fg-muted">prev PR #</span>
              <input
                type="text"
                value={samplePrev.prNumber}
                onChange={(e) => setSamplePrev((s) => ({ ...s, prNumber: e.target.value }))}
                placeholder="7"
                className="w-12 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-xs text-fg"
              />
            </label>
            <label className="inline-flex items-center gap-1">
              <span className="text-fg-muted">prev task</span>
              <input
                type="text"
                value={samplePrev.taskId}
                onChange={(e) => setSamplePrev((s) => ({ ...s, taskId: e.target.value }))}
                placeholder="uuid"
                className="w-32 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-xs text-fg"
              />
            </label>
          </>
        )}
        <button
          onClick={run}
          disabled={loading}
          className="ml-auto rounded-md border border-border bg-bg-subtle px-2 py-0.5 text-[11px] text-fg hover:bg-bg disabled:opacity-50"
        >
          {loading ? 'Rendering…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400">{error}</p>}
      {preview && (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">User prompt sent to agent</div>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-bg-subtle p-2 font-mono text-[11px] text-fg">
              {preview.userPrompt || '(empty)'}
            </pre>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">System prompt scaffolding</div>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-bg-subtle p-2 font-mono text-[11px] text-fg-muted">
              {preview.scaffoldingSystemPrompt}
            </pre>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Step notes
              {' '}
              <span className={preview.stepNotesIsDefault ? 'normal-case text-fg-muted/70' : 'normal-case text-accent'}>
                — {preview.stepNotesIsDefault ? 'default (the marker contract)' : 'user override'}
              </span>
            </div>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-bg-subtle p-2 font-mono text-[11px] text-fg/80">
              {preview.stepNotes}
            </pre>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Skill body ({preview.skill || '—'})
              {preview.skillBodyMissing && (
                <span className="ml-2 normal-case text-amber-300/90">
                  ⚠ couldn\'t read skill body from the repo clone
                </span>
              )}
            </div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-bg-subtle p-2 font-mono text-[11px] text-fg/80">
              {preview.skillBody || '(skill body unavailable — appended at runtime from .ai/skills/)'}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Bottom strip: Run on issue ────────────────────────────────────────────

function RunOnIssue({ onRun }: { onRun: (issue: number) => void }) {
  const [issueInput, setIssueInput] = useState('');
  const [running, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-fg-muted">Run on issue</label>
      <span className="text-xs text-fg-muted">#</span>
      <input
        type="number"
        min={1}
        value={issueInput}
        onChange={(e) => setIssueInput(e.target.value)}
        placeholder="42"
        className="w-20 rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-fg"
      />
      <button
        disabled={running || !issueInput.trim()}
        onClick={() => {
          const n = Number(issueInput);
          if (!Number.isInteger(n) || n <= 0) {
            alert('issue number must be a positive integer');
            return;
          }
          startTransition(() => {
            onRun(n);
            setIssueInput('');
          });
        }}
        className="rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-medium text-fg hover:bg-accent/20 disabled:opacity-50"
      >
        {running ? 'Queueing…' : 'Run'}
      </button>
    </div>
  );
}

// ─── Small UI primitives ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'succeeded' ? 'text-emerald-400 bg-emerald-500/15'
    : status === 'failed' ? 'text-rose-400 bg-rose-500/15'
    : status === 'running' ? 'text-amber-300 bg-amber-500/15'
    : status === 'cancelled' ? 'text-fg-muted bg-bg-subtle'
    : status === 'skipped' ? 'text-fg-muted bg-bg-subtle'
    : 'text-fg-muted bg-bg-subtle';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>;
}

function IconButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  tone?: 'neutral' | 'danger' | 'accent';
}) {
  const cls =
    tone === 'danger'
      ? 'border-border bg-bg-subtle text-rose-400 hover:bg-rose-500/10'
      : tone === 'accent'
        ? 'border-accent/50 bg-accent/10 text-fg hover:bg-accent/20'
        : 'border-border bg-bg-subtle text-fg-muted hover:text-fg hover:bg-bg';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`rounded-md border px-2 py-1.5 disabled:opacity-30 ${cls}`}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
