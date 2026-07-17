import { useConfig, useHealth } from '@/api/queries'
import type { Runner } from '@/api/types'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import {
  availableRunners,
  modelsForRunner,
  resolveModel,
  resolveRunner,
} from '@/routes/new-task-form'

/**
 * The runner + model pill pair for the surfaces that START a run outside the /new composer
 * (#401): the Inbox card's "▶ Run" and the GitHub tab's "Run agent on this issue/PR".
 *
 * It exists so those two cannot drift from the composer: the resolution quartet
 * (`availableRunners` → `resolveRunner` → `modelsForRunner` → `resolveModel`) and the
 * "hide the runner pill on a single-backend host" rule live here once, read from the same
 * health/config queries new-task.tsx reads. The composer itself keeps its own inline copy —
 * it threads the pills through a persisted draft and a variants pill this pair has no notion of.
 *
 * The caller owns the pick (`null` = never touched, so the configured default shows through);
 * this component only resolves and renders. `useResolvedEngine` hands back what the POST body
 * needs, so the pick and the thing sent to the server can never disagree.
 */

/** What the user actually touched. `null` on either field means "never touched". */
export interface EnginePick {
  runner: Runner | null
  model: string | null
}

/** The effective backend + what `buildCreateRunBody`/`githubRunBody` need to shape the body. */
export interface ResolvedEngine {
  runner: Runner
  model: string
  /** The backends this host offers. A single-backend host must not send a runner (composer
   *  rule) and shows no runner pill, so callers read `runners.length` for both decisions. */
  runners: readonly Runner[]
  runnerCount: number
}

export function useResolvedEngine(pick: EnginePick): ResolvedEngine {
  const health = useHealth()
  const config = useConfig()
  const runners = availableRunners(health.data?.checks ?? [])
  const runner = resolveRunner(pick.runner, runners, health.data?.defaultRunner ?? 'claude')
  return {
    runner,
    model: resolveModel(pick.model, runner, config.data?.defaultModels),
    runners,
    runnerCount: runners.length,
  }
}

export function EnginePills({
  pick,
  onChange,
  disabled = false,
}: {
  pick: EnginePick
  onChange: (pick: EnginePick) => void
  disabled?: boolean
}) {
  const { runner, model, runners } = useResolvedEngine(pick)
  const models = modelsForRunner(runner)

  return (
    <>
      {runners.length > 1 ? (
        <RunnerPill
          runners={runners}
          value={runner}
          disabled={disabled}
          // Switching backend drops the model pick: the presets are per-runner, so a kept
          // model would be a preset the new runner does not have (composer rule).
          onPick={(next) => onChange({ runner: next, model: null })}
        />
      ) : null}
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label={models.find((m) => m.id === model)?.label ?? 'auto'}
        value={model}
        disabled={disabled}
        onPick={(next) => onChange({ ...pick, model: next })}
        options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
      />
    </>
  )
}
