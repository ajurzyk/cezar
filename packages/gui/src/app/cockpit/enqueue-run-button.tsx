'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enqueueWorkflowRun } from './actions';

/**
 * Minimal "put a job on the queue" control for the cockpit header. The
 * `/api/cron/dispatch` cron picks it up and runs it via the workflow engine.
 * Triage needs only an issue number; autofix/ci-followup do too (ci-followup's
 * full seed is normally supplied by the CI crons — here we just enqueue a bare
 * job, which the dispatcher will skip if it lacks a seed).
 */
export function EnqueueRunButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [workflow, setWorkflow] = useState<'autofix' | 'triage'>('autofix');
  const [issue, setIssue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  function submit() {
    const issueNumber = Number(issue);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      setMsg('Enter a valid issue number');
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await enqueueWorkflowRun({ workflow, issueNumber });
      if (res.error) setMsg(res.error);
      else {
        setMsg(`Queued (job ${res.jobId?.slice(0, 8)}…)`);
        setIssue('');
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
      <select
        value={workflow}
        onChange={(e) => setWorkflow(e.target.value as 'autofix' | 'triage')}
        disabled={disabled || pending}
        className="min-h-11 w-full rounded border border-border bg-bg px-2 py-1 text-fg-muted sm:min-h-0 sm:w-auto"
      >
        <option value="autofix">autofix</option>
        <option value="triage">triage</option>
      </select>
      <div className="flex items-center gap-2">
        <input
          value={issue}
          onChange={(e) => setIssue(e.target.value)}
          placeholder="issue #"
          inputMode="numeric"
          disabled={disabled || pending}
          className="min-h-11 w-20 rounded border border-border bg-bg px-2 py-1 text-base sm:min-h-0 sm:text-sm"
        />
        <button
          onClick={submit}
          disabled={disabled || pending}
          className="min-h-11 flex-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg hover:bg-accent-hover disabled:opacity-50 sm:min-h-0 sm:flex-none"
        >
          {pending ? 'Queuing…' : 'Run workflow'}
        </button>
      </div>
      {msg && <span className="text-xs text-fg-muted">{msg}</span>}
    </div>
  );
}
