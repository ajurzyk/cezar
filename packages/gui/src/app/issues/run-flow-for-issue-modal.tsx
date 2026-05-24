'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { listFlows, runFlowOnIssue, type FlowSummary } from '@/app/workflows/actions';

export interface RunFlowForIssueModalProps {
  issueNumber: number;
  issueTitle: string;
  onClose: () => void;
}

/**
 * Companion to `RunActionForIssueModal` but for flows (migration 0021). The
 * user picks a saved flow and we queue it as a `kind='flow'` job pinned to
 * this issue. On success we redirect to /cockpit so the user sees the run
 * appear — matching `startAutofix`'s "redirect to /cockpit" pattern.
 */
export function RunFlowForIssueModal({ issueNumber, issueTitle, onClose }: RunFlowForIssueModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusables = node?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      lastFocused.current?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listFlows();
      if (cancelled) return;
      // Hide paused flows + ones with no steps — can't run them anyway.
      const runnable = rows.filter((f) => !f.paused && f.steps.length > 0);
      setFlows(runnable);
      setLoading(false);
      if (runnable.length > 0) setSelectedId(runnable[0].id);
    })().catch(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function handleRun() {
    setError(null);
    if (!selectedId) {
      setError('Pick a flow');
      return;
    }
    startTransition(async () => {
      const r = await runFlowOnIssue({ flowId: selectedId, issueNumber });
      if (!r.ok) {
        setError(r.error ?? 'Run failed');
        return;
      }
      onClose();
      router.push('/cockpit');
    });
  }

  const selected = flows.find((f) => f.id === selectedId);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-flow-title"
        className="w-full max-w-lg rounded-lg border border-outline-variant bg-surface-container-low p-5 shadow-xl"
      >
        <h2 id="run-flow-title" className="text-base font-semibold text-on-surface">
          Run flow on #{issueNumber}
        </h2>
        <p className="mt-1 truncate text-xs text-on-surface-variant">{issueTitle}</p>

        <div className="mt-4 space-y-2">
          <label className="block text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
            Flow
          </label>
          {loading ? (
            <p className="text-xs text-on-surface-variant">Loading flows…</p>
          ) : flows.length === 0 ? (
            <p className="text-xs text-on-surface-variant">
              No runnable flows. Visit{' '}
              <a className="text-primary hover:underline" href="/workflows">/workflows</a>{' '}
              to create one.
            </p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="block w-full rounded-md border border-outline-variant bg-surface-container px-2 py-1.5 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
            >
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.steps.length} step{f.steps.length === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          )}
          {selected && selected.steps.length > 0 && (
            <div className="mt-2 rounded-md border border-outline-variant/60 bg-surface-container/60 p-2">
              <div className="text-[11px] uppercase tracking-wide text-on-surface-variant">Steps</div>
              <ol className="mt-1 list-decimal pl-5 text-xs text-on-surface space-y-0.5">
                {selected.steps.map((s, i) => (
                  <li key={i}>
                    <span className="font-mono">{s.skill || '(no skill)'}</span>{' '}
                    <span className="text-on-surface-variant">→ {s.argsTemplate}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-outline-variant bg-surface-container px-3 py-1.5 text-sm text-on-surface hover:bg-surface-container-high"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={pending || !selectedId || flows.length === 0}
            className={cn(
              'rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-sm font-medium text-on-surface',
              'hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {pending ? 'Queueing…' : 'Run on this issue'}
          </button>
        </div>
      </div>
    </div>
  );
}
