'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { saveAutomationToggles, type SaveAutomationState } from './automation-actions';

const SYNC_INTERVAL_OPTIONS = [5, 15, 30, 60, 120, 360] as const;

function formatInterval(min: number): string {
  if (min < 60) return `Every ${min} minutes`;
  const hours = min / 60;
  return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
}

interface AutomationSectionProps {
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  actionAutoComment: boolean;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  readOnly: boolean;
}

export function AutomationSection({
  autoTriageEnabled,
  autofixEnabled,
  separateCommentPerStep,
  actionAutoComment,
  syncMode,
  syncIntervalMinutes,
  readOnly,
}: AutomationSectionProps) {
  const [state, formAction, pending] = useActionState<SaveAutomationState, FormData>(saveAutomationToggles, {});
  const [autofix, setAutofix] = useState(autofixEnabled);
  const [syncAuto, setSyncAuto] = useState(syncMode === 'auto');

  return (
    <form action={formAction} className="space-y-4">
      {state.ok && <Banner tone="ok">Automation settings saved.</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      <Toggle
        name="autoTriageEnabled"
        label="Auto-triage new issues"
        hint="When a GitHub issue is opened (or its title/body edited), Cezar runs the triage workflow — classifies it, sets a priority, applies labels, and posts a summary comment."
        defaultChecked={autoTriageEnabled}
        readOnly={readOnly}
      />

      <Toggle
        name="autofixEnabled"
        label="Auto-fix triaged bugs"
        hint="When on, Cezar opens a draft PR automatically on triaged bugs that clear the confidence threshold (config: autofix.minBugConfidence). PRs are always opened as drafts."
        defaultChecked={autofixEnabled}
        readOnly={readOnly}
        onChange={setAutofix}
      />

      {autofix && !autofixEnabled && (
        <Banner tone="warn">
          With auto-fix on, Cezar will open draft PRs without a human in the loop (only on bugs above the
          confidence threshold). Review the draft before merging.
        </Banner>
      )}

      <Toggle
        name="separateCommentPerStep"
        label="One comment per workflow step"
        hint="Off (default): a single living comment is edited as the run progresses. On: each step posts its own comment."
        defaultChecked={separateCommentPerStep}
        readOnly={readOnly}
      />

      <Toggle
        name="actionAutoComment"
        label="Auto-comment on actions"
        hint="Cezar leaves a short summary comment on the issue or PR after each action runs, explaining what it did and why. Skipped when the action already posted its own comment."
        defaultChecked={actionAutoComment}
        readOnly={readOnly}
      />

      <Toggle
        name="syncAuto"
        label="Automatic sync"
        hint="On (default): Cezar pulls issues and pull requests from GitHub on a schedule. Off (manual): the workspace syncs only when an admin clicks the sync indicator in the header."
        defaultChecked={syncAuto}
        readOnly={readOnly}
        onChange={setSyncAuto}
      />

      {syncAuto && (
        <label
          className={cn(
            'flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container/40 p-4 transition-colors',
            readOnly ? 'opacity-70' : 'hover:border-outline',
          )}
        >
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm font-medium text-on-surface">Sync frequency</span>
            <span className="block text-xs leading-relaxed text-on-surface-variant">
              How often Cezar auto-syncs from GitHub. The minimum gap between automatic syncs — the cron
              checks every 5 minutes, so faster than that has no effect.
            </span>
          </span>
          <select
            name="syncIntervalMinutes"
            defaultValue={String(syncIntervalMinutes)}
            disabled={readOnly}
            className="mt-1 h-9 shrink-0 rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-70"
          >
            {(SYNC_INTERVAL_OPTIONS.includes(syncIntervalMinutes as (typeof SYNC_INTERVAL_OPTIONS)[number])
              ? SYNC_INTERVAL_OPTIONS
              : [syncIntervalMinutes, ...SYNC_INTERVAL_OPTIONS]
            ).map((min) => (
              <option key={min} value={min}>
                {formatInterval(min)}
              </option>
            ))}
          </select>
        </label>
      )}

      {!readOnly && (
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save automation settings'}
          </button>
        </div>
      )}
    </form>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  readOnly,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
  readOnly: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container/40 p-4 transition-colors',
        readOnly ? 'opacity-70' : 'hover:border-outline',
      )}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={readOnly}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-4 w-4 accent-primary"
      />
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        <span className="block text-xs leading-relaxed text-on-surface-variant">{hint}</span>
      </span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : tone === 'warn'
        ? 'border-tertiary/40 bg-tertiary/10 text-tertiary'
        : 'border-error/40 bg-error/10 text-error';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', cls)} role="status">
      {children}
    </div>
  );
}
