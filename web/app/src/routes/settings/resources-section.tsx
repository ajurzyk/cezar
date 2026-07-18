import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { WorktreesPanel } from './worktrees-panel'

/**
 * Settings → Resources: how hard the machine works. `maxParallel` caps concurrent tasks (the run
 * queue holds the rest); `memoryLimitMb` is the per-task ceiling the engine enforces by pausing a
 * task that crosses it and letting the queue advance (#memory-guard). Both persist through
 * `PUT /api/config` like the Agents knobs — the merged answer lands straight in the config query.
 */

const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16
/** Below this a limit would pause almost any real agent immediately — reject it as a footgun. */
const MEMORY_MIN_MB = 256
/** Worktree retention count bounds (#483) — 0 = unlimited, matching the config schema. */
const WORKTREE_RETENTION_MIN = 0
const WORKTREE_RETENTION_MAX = 1000

export function ResourcesSection() {
  const config = useConfig()

  if (config.isPending) {
    return (
      <p data-slot="resources-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading resource settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        tone="danger"
        title="Resource settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <ResourcesForm config={config.data} />
}

function ResourcesForm({ config }: { config: ConfigResponse }) {
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(queryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // Memory edits locally and saves explicitly — an empty field means "no limit".
  const [memory, setMemory] = useState(config.memoryLimitMb ? String(config.memoryLimitMb) : '')
  const memoryNum = memory.trim() === '' ? 0 : Number(memory)
  const memoryInvalid =
    memory.trim() !== '' && (!Number.isInteger(memoryNum) || memoryNum < MEMORY_MIN_MB)
  const memorySaved = (config.memoryLimitMb ?? 0) === (memoryInvalid ? -1 : memoryNum)
  const saveMemory = () =>
    save.mutate(
      { memoryLimitMb: memoryNum === 0 ? null : memoryNum },
      {
        onSuccess: () =>
          toast(memoryNum === 0 ? 'Memory limit cleared' : `Memory limit set to ${memoryNum} MiB`),
      },
    )

  // Worktree retention edits locally and saves explicitly (#483). 0 = unlimited
  // (a meaningful value, always sent as a number so it is never mistaken for
  // "clear back to the default").
  const [retention, setRetention] = useState(String(config.worktreeRetention))
  const retentionNum = Number(retention)
  const retentionInvalid =
    retention.trim() === '' ||
    !Number.isInteger(retentionNum) ||
    retentionNum < WORKTREE_RETENTION_MIN ||
    retentionNum > WORKTREE_RETENTION_MAX
  const retentionSaved = config.worktreeRetention === (retentionInvalid ? -1 : retentionNum)
  const saveRetention = () =>
    save.mutate(
      { worktreeRetention: retentionNum },
      {
        onSuccess: () => {
          // Keep the worktrees panel's keep-limit footer in step with the new value.
          void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
          toast(
            retentionNum === 0
              ? 'Keeping all worktrees (unlimited)'
              : `Keeping the last ${retentionNum} finished worktree${retentionNum === 1 ? '' : 's'}`,
          )
        },
      },
    )

  return (
    <div
      data-slot="resources-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <Field
        title="Max parallel tasks"
        hint="How many tasks run at once. The rest wait in the queue. A non-git directory always runs one at a time."
      >
        <select
          aria-label="Max parallel tasks"
          data-slot="resources-max-parallel"
          value={config.maxParallel}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ maxParallel: Number(event.target.value) })}
          className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {Array.from({ length: MAX_PARALLEL_MAX - MAX_PARALLEL_MIN + 1 }, (_, i) => i + MAX_PARALLEL_MIN).map(
            (n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ),
          )}
        </select>
      </Field>

      <Field
        title="Per-task memory limit"
        hint="When a task's whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={MEMORY_MIN_MB}
            step={256}
            aria-label="Per-task memory limit in MiB"
            data-slot="resources-memory-limit"
            value={memory}
            disabled={save.isPending}
            placeholder="no limit"
            onChange={(event) => setMemory(event.target.value)}
            className="block w-32 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <span className="text-xs text-soft-foreground">MiB</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-memory"
            disabled={memorySaved || memoryInvalid || save.isPending}
            onClick={saveMemory}
          >
            Save
          </Button>
        </div>
        {memoryInvalid ? (
          <p data-slot="resources-memory-invalid" className="text-[11px] text-danger">
            Enter a whole number of at least {MEMORY_MIN_MB} MiB, or leave empty for no limit.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">Applies to newly started tasks.</p>
        )}
      </Field>

      <Field
        title="Keep last N worktrees"
        hint="Older finished worktrees are reclaimed to free disk; their branch is kept so the work stays recoverable. 0 = unlimited. In-review and running tasks are never reclaimed, so the count on disk can exceed this."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={WORKTREE_RETENTION_MIN}
            max={WORKTREE_RETENTION_MAX}
            step={1}
            aria-label="Keep last N finished worktrees"
            data-slot="resources-worktree-retention"
            value={retention}
            disabled={save.isPending}
            onChange={(event) => setRetention(event.target.value)}
            className="block w-32 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <span className="text-xs text-soft-foreground">worktrees</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-retention"
            disabled={retentionSaved || retentionInvalid || save.isPending}
            onClick={saveRetention}
          >
            Save
          </Button>
        </div>
        {retentionInvalid ? (
          <p data-slot="resources-retention-invalid" className="text-[11px] text-danger">
            Enter a whole number from {WORKTREE_RETENTION_MIN} to {WORKTREE_RETENTION_MAX} (0 = unlimited).
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            {retentionNum === 0 ? 'Keeping every finished worktree.' : `Keeping the last ${retentionNum} finished worktree${retentionNum === 1 ? '' : 's'} on disk.`}
          </p>
        )}
      </Field>

      <Field
        title="Worktrees"
        hint="Task worktrees currently on disk. Delete one to reclaim its space now, or reclaim everything past the keep-limit at once. Branches are always kept, so the work stays recoverable."
      >
        <WorktreesPanel />
      </Field>
    </div>
  )
}

/** The Agents section's field chassis — same rhythm, so Settings reads as one surface. */
function Field({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
