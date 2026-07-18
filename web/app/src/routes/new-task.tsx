import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  SparklesIcon,
  SquareIcon,
  WorkflowIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { createRun, getLaunchKey, postPlan, putConfig, putUiState } from '@/api/client'
import { queryKeys, useConfig, useHealth, useRepo, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { ImageInput, RepoResponse, Runner, Skill, WorkflowDef } from '@/api/types'
import { TwinkleBackdrop } from '@/components/centered-state'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import {
  autoApplyText,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import {
  bumpSkillUsage,
  isProjectSkill,
  orderSkillsByUsage,
  searchSkills,
  searchWorkflows,
  skillKeywords,
} from '@/lib/skills'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import {
  bookmarkletRunBody,
  deepLinkToast,
  unknownSkillPrefillText,
  type DeepLinkNotice,
} from './new-task-autostart'
import { clearDraftText, readDraft, writeDraft, type NewTaskDraft } from './new-task-draft'
import {
  availableRunners,
  buildCreateRunBody,
  modelsForRunner,
  pushRecentSource,
  resolveModel,
  resolveRunner,
  resolveSource,
  startedRunPath,
  RUNNERS,
  type TaskSource,
} from './new-task-form'
import { parseNewTaskParams } from './new-task-params'
import { buildPlannedRunBody, pendingPlanOf, type PendingPlan } from './new-task-plan'
import { PlanReview } from './plan-review'

/**
 * `/new` — the full-screen new-task hero (spec §"New task (full-screen, #386)"; visual
 * contract docs/mockups/new-task.html): centered composer card on the twinkle surface, the
 * picker pill row inside the card below the textarea, suggested-task ghost chips underneath.
 * In plan-first mode (#383, the `Start | Plan first` segment) submit runs `POST /api/plan`
 * and opens the review overlay (plan-review.tsx) instead of starting a run.
 *
 * This route also owns the saved-bookmarklet contract (spec 011, BACKWARD_COMPATIBILITY.md):
 * a full document load of `/new?skill=&ref=&auto=1&key=` auto-starts a run unattended when the
 * key matches `GET /api/launch-key`, and only prefills otherwise — `handleDeepLink()` in
 * web/app.js, verbatim (see new-task-autostart.ts for the verified semantics).
 */
export function NewTaskRoute() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // The deep-link params, captured ONCE: the mount effect below strips them from the URL
  // (legacy's `history.replaceState` — the launch key must not survive in history or survive
  // a reload to re-trigger), so live search params would vanish under us.
  const [deepLink] = useState(() => parseNewTaskParams(search))

  const health = useHealth()
  const workflows = useWorkflows()
  const skills = useSkills()
  const repo = useRepo()
  const uiState = useUiState()
  // Settings → Agents `defaultModels` (R6 1.5): the per-runner preset the Model pill starts on.
  const config = useConfig()

  // The draft survives navigation (module store); explicit deep-link params beat it — a
  // pasted `/new?skill=&ref=` link states intent, a leftover draft only remembers it.
  const [draft, setDraft] = useState<NewTaskDraft>(() => {
    const stored = readDraft()
    return {
      ...stored,
      ...(deepLink.ref !== '' ? { text: deepLink.ref } : {}),
      ...(deepLink.skill !== ''
        ? { source: { source: 'skill', ref: deepLink.skill } as TaskSource }
        : {}),
    }
  })
  useEffect(() => {
    writeDraft(draft)
  }, [draft])
  const update = (patch: Partial<NewTaskDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  // ---- effective picker values (rules in new-task-form.ts, mirrored from legacy) -----------
  const recentSources = uiState.data?.recentSources
  // Memoized so the picker gets a STABLE array identity across renders that don't actually
  // change the catalog or the usage stats (#408 — a raw `orderSkillsByUsage(...)` call here
  // would create a new array on EVERY render, including ones unrelated to skills/usage).
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(
    () => orderSkillsByUsage(skillsData ?? [], skillUsage),
    [skillsData, skillUsage],
  )
  const workflowList = workflows.data?.workflows ?? []
  const sourcesReady =
    skills.data !== undefined && workflows.data !== undefined && !uiState.isPending
  const source = resolveSource([draft.source, uiState.data?.lastTask], skillList, workflowList)

  // ---- prompt templates (#413 follow-up) ----------------------------------------------------
  // The same list the GitHub hand-over and Inbox composers read. Two ways in here: the footer's
  // icon trigger inserts one by hand at the caret, and a skill whose templates are assigned to it
  // applies them on selection — but only into a box the user has not typed in (`resolveAutoApply`).
  const composerRef = useRef<ComposerHandle>(null)
  const templates = useMemo(
    () => normalizePromptTemplates(uiState.data?.promptTemplates),
    [uiState.data?.promptTemplates],
  )
  const autoText = autoApplyText(templates, source.source === 'skill' ? [source.ref] : [])
  const draftTextRef = useRef(draft.text)
  draftTextRef.current = draft.text
  const autoAppliedRef = useRef('')
  useEffect(() => {
    // Wait for the pickers' data: before it lands `source` is still a provisional guess, and
    // auto-applying against it would flash text in for a skill the user may not end up on.
    if (!sourcesReady) return
    const resolved = resolveAutoApply(draftTextRef.current, autoAppliedRef.current, autoText)
    autoAppliedRef.current = resolved.applied
    if (resolved.text !== draftTextRef.current) update({ text: resolved.text })
    // `autoText` is a derived STRING — this fires when the assigned set changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoText, sourcesReady])

  const runners = availableRunners(health.data?.checks ?? [])
  const runner = resolveRunner(draft.runner, runners, health.data?.defaultRunner ?? 'claude')
  const models = modelsForRunner(runner)
  const model = resolveModel(draft.model, runner, config.data?.defaultModels)

  // Parallel variants need a worktree per variant, hence git (the server 409s without it).
  const hasGit = health.data === undefined || health.data.repo !== null
  const variants = hasGit ? draft.variants : 1

  // Worktree opt-out (#worktree-toggle): only offered for a single skill run in a git repo —
  // workflows and variants always isolate, and a non-git repo already runs in place. The choice
  // is remembered (draft → last-used → default on).
  const worktreeToggleShown = hasGit && source.source === 'skill' && variants <= 1
  const worktreeOn = worktreeToggleShown ? (draft.worktree ?? uiState.data?.lastWorktree ?? true) : true

  // Autonomous (#autonomous): the run never pauses for the user. An explicit toggle this session
  // wins; otherwise skills default ON (a skill run is meant to just execute), workflows fall back
  // to the remembered choice, else off. Plan-first forces it OFF (and disables the toggle):
  // planning is inherently interactive, so the run must be able to hand the ball back.
  const autonomousOn = draft.planFirst
    ? false
    : (draft.autonomous ?? (source.source === 'skill' ? true : (uiState.data?.lastAutonomous ?? false)))

  // Follow-up generation (#444) is offered only while the server has the global inbox on
  // (#471, `CEZ_FOLLOWUPS=1`) — there is no inbox for the follow-ups to land in otherwise, and
  // the server pins the flag to false regardless, so a toggle would be a lie. Hidden, the value
  // is false, matching what the server will do. Health unknown → assume offered, the `hasGit`
  // rule above: the composer must not flicker its controls while health is in flight.
  const followupsToggleShown = health.data === undefined || health.data.capabilities.followups
  // Within an enabled server it stays opt-out: a draft choice wins, then the remembered UI
  // preference; absent state from older installs keeps the historical enabled behavior.
  const generateFollowupsOn = followupsToggleShown
    ? (draft.generateFollowups ?? uiState.data?.lastGenerateFollowups ?? true)
    : false

  // ---- plan mode (#383 + spec 008) ----------------------------------------------------------
  const [plan, setPlan] = useState<PendingPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [starting, setStarting] = useState(false)

  // ---- bookmarklet deep-link (spec 011 — legacy handleDeepLink, verbatim) -------------------
  // `auto=1` with a ref arms the unattended start; the composer stays hidden behind a
  // "Starting…" surface until the key check + POST settle (or fail into the prefill path).
  const [autoStarting, setAutoStarting] = useState(() => deepLink.auto && deepLink.ref !== '')
  const [notice, setNotice] = useState<DeepLinkNotice | null>(() =>
    !deepLink.auto && deepLink.ref !== '' ? { kind: 'prefill' } : null,
  )
  const deepLinkHandled = useRef(false)
  useEffect(() => {
    if (deepLinkHandled.current) return
    deepLinkHandled.current = true
    // Legacy cleans the URL FIRST (`history.replaceState({}, '', '/')` — before anything
    // async): the launch key never lingers in the address bar or history, and a reload can
    // never re-trigger the start. Same move here, staying on this route. (The router's own
    // search, not window.location — MemoryRouter under test never touches the window.)
    if (search.toString() !== '') void navigate('/new', { replace: true })
    if (!deepLink.auto || deepLink.ref === '') return
    void (async () => {
      let launchKey = ''
      try {
        launchKey = (await getLaunchKey()).key
      } catch {
        // key endpoint unreachable → the blocked path, exactly like legacy
      }
      if (launchKey !== '' && deepLink.key === launchKey) {
        try {
          const created = await createRun(bookmarkletRunBody(deepLink))
          clearDraftText()
          void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
          void navigate(startedRunPath(created))
          return
        } catch (error) {
          setNotice({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        // Wrong or missing key: a drive-by page guessing the URL gets a form, never a run.
        setNotice({ kind: 'blocked' })
      }
      setAutoStarting(false)
    })()
    // mount-only by design: deepLink is captured state and this must run exactly once
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // The prefill toast waits for the pickers' data: whether the skill exists decides the
  // wording, and the unknown-skill case rewrites the draft the way legacy did (intent into
  // the text, quick-task as the source — its planner resolves skills from prose).
  useEffect(() => {
    if (notice === null || !sourcesReady) return
    setNotice(null)
    const unknownSkill =
      deepLink.skill !== '' && !skillList.some((s) => s.name === deepLink.skill)
        ? deepLink.skill
        : ''
    if (unknownSkill !== '') {
      update({
        text: unknownSkillPrefillText(deepLink.skill, deepLink.ref),
        ...(workflowList.some((w) => w.name === 'quick-task')
          ? { source: { source: 'workflow', ref: 'quick-task' } as TaskSource }
          : {}),
      })
    }
    const { message, tone } = deepLinkToast(notice, unknownSkill)
    toast(message, { tone })
    // Legacy focused the Run button so a bare Enter submits the reviewed form.
    document
      .querySelector<HTMLButtonElement>(
        '[data-slot="composer"] button[aria-label="Start task"], [data-slot="composer"] button[aria-label="Plan task"]',
      )
      ?.focus()
  }, [notice, sourcesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (text: string, images: ImageInput[]) => {
    if (!sourcesReady) {
      // Rejection restores the draft — nothing typed is lost to a race with the pickers.
      throw new Error('Still loading workflows and skills — try again in a second.')
    }
    if (draft.planFirst) {
      // Plan mode: submit means PLAN. A rejection propagates — the composer toasts and
      // restores the draft; a success restores the text ourselves (the composer already
      // cleared optimistically) so Discard hands back exactly what was typed. The review
      // overlay is deliberate: it's where steps are edited and saved as a reusable chain.
      setPlanning(true)
      try {
        setPlan(pendingPlanOf(text, images, await postPlan(text)))
        update({ text })
      } finally {
        setPlanning(false)
      }
      return
    }
    const created = await createRun(
      buildCreateRunBody({
        task: text,
        source,
        model,
        runner,
        runnerCount: runners.length,
        variants,
        images,
        worktree: worktreeOn,
        autonomous: autonomousOn,
        generateFollowups: generateFollowupsOn,
        // #374: when the Inbox's "Run" sent us here, hand the entry's id back so the server
        // records this run on it and it leaves the inbox — the audit trail the old
        // POST /api/todos/:id/start kept, minus the blind launch. Empty otherwise.
        // Deliberately not gated on generateFollowupsOn (#444): turning off follow-up
        // generation for THIS task must not stop the entry it came from being marked started.
        todoId: deepLink.todo,
      }),
    )
    // Remember what was actually run so the next visit preselects it (legacy
    // `saveLastTaskSource`) and float it to the top of the picker next time
    // (recency sort) — fire-and-forget: a failed write only costs the convenience.
    void putUiState({
      lastTask: source,
      recentSources: pushRecentSource(recentSources, source),
      ...(worktreeToggleShown ? { lastWorktree: worktreeOn } : {}),
      lastAutonomous: autonomousOn,
      ...(followupsToggleShown ? { lastGenerateFollowups: generateFollowupsOn } : {}),
      // Frequency sort (#408): only a SKILL pick counts — the map is keyed by skill name, and a
      // workflow choice here doesn't select one directly. Gated on the CURRENT map being known:
      // the PUT merge is shallow, so bumping off an errored ui-state query (`sourcesReady` only
      // rules out `isPending`, not a failed fetch) would send a one-entry map and wipe every
      // accumulated count.
      ...(source.source === 'skill' && uiState.data !== undefined
        ? { skillUsage: bumpSkillUsage(uiState.data.skillUsage, source.ref) }
        : {}),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
      .catch(() => {})
    clearDraftText()
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    navigate(startedRunPath(created))
  }

  /** ▶ Start on the reviewed plan: the (possibly edited) steps go INLINE, with the composer's
   *  current picker choices — legacy `startPlannedRun` semantics on the new surface. */
  const startPlanned = async () => {
    if (plan === null || plan.steps.length === 0 || starting) return
    setStarting(true)
    try {
      const created = await createRun(
        buildPlannedRunBody({
          task: plan.task,
          steps: plan.steps,
          model,
          runner,
          runnerCount: runners.length,
          variants,
          images: plan.images,
          generateFollowups: generateFollowupsOn,
          todoId: deepLink.todo, // #374: planning first must not lose the inbox entry
        }),
      )
      // Only remember a choice the user was actually offered (#471, the `lastWorktree` rule):
      // persisting the forced `false` would overwrite their real preference, so turning
      // CEZ_FOLLOWUPS back on later would silently come up off.
      if (followupsToggleShown) {
        void putUiState({ lastGenerateFollowups: generateFollowupsOn })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
          .catch(() => {})
      }
      clearDraftText()
      setPlan(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      navigate(startedRunPath(created))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      setStarting(false)
    }
  }

  // The unattended bookmarklet start in flight: no composer, no params echoed anywhere —
  // just an honest "working on it" until the POST answers (success navigates to the thread;
  // failure drops back to the prefilled composer with a toast).
  if (autoStarting) {
    return (
      <div
        data-route="new"
        className="relative isolate flex min-h-full flex-col items-center justify-center overflow-x-clip px-6"
      >
        <TwinkleBackdrop />
        <div data-slot="auto-starting" role="status" className="text-center">
          <h1 className="animate-pulse text-lg font-semibold tracking-tight">Starting task…</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            Launched from a bookmarklet — taking you to the run.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      data-route="new"
      className="relative isolate flex min-h-full flex-col items-center overflow-x-clip px-6 pt-[clamp(32px,7vh,84px)] pb-16 max-md:px-3.5 max-md:pt-7"
    >
      <TwinkleBackdrop />

      <div className="w-full max-w-[720px]">
        <header className="mb-6 text-center max-md:mb-4">
          <h1 className="text-lg font-semibold tracking-tight max-md:text-base">
            What should the agent work on?
          </h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground max-md:text-xs">
            Runs in an isolated worktree — review everything before it lands.
          </p>
        </header>

        <Composer
          ref={composerRef}
          onSubmit={submit}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          autoFocus
          placeholder="Describe a task for the agent — / for skills…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel={draft.planFirst ? 'Plan task' : 'Start task'}
          autocompleteSkills
          footerStart={
            <>
              <SourcePill
                source={source}
                ready={sourcesReady}
                skills={skillList}
                workflows={workflowList}
                onPick={(next) => update({ source: next })}
              />
              {/* Icon-only: this row already carries source/runner/model/variants/worktree/
                  autonomous/branch, and templates is the least-used of them. */}
              <PromptTemplateMenu
                templates={templates}
                iconOnly
                onInsert={(text) => composerRef.current?.insertAtCaret(text)}
              />
              {runners.length > 1 ? (
                <RunnerPill runners={runners} value={runner} onPick={(next) => update({ runner: next, model: null })} />
              ) : null}
              <PickerPill
                slot="model-pill"
                ariaLabel="Model"
                label={models.find((m) => m.id === model)?.label ?? 'auto'}
                value={model}
                onPick={(next) => update({ model: next })}
                options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
              />
              <PickerPill
                slot="variants-pill"
                ariaLabel="Parallel variants"
                label={variants > 1 ? `×${variants} variants` : '×1'}
                value={String(variants)}
                onPick={(next) => update({ variants: Number(next) })}
                disabled={!hasGit}
                hint="How many times to run this task in parallel — each variant gets its own worktree, and you pick the diff you keep. ×1 runs it once."
                disabledHint="Parallel variants need a git repository — each variant runs in its own worktree."
                options={[
                  { value: '1', label: '×1', desc: 'One run' },
                  { value: '2', label: '×2 variants', desc: 'Two competing runs — pick the diff you keep' },
                  { value: '3', label: '×3 variants', desc: 'Three competing runs — pick the diff you keep' },
                ]}
              />
              {worktreeToggleShown ? (
                <WorktreeToggle on={worktreeOn} onChange={(on) => update({ worktree: on })} />
              ) : null}
              <AutonomousToggle
                on={autonomousOn}
                disabled={draft.planFirst}
                onChange={(on) => update({ autonomous: on })}
              />
              {followupsToggleShown ? (
                <GenerateFollowupsToggle
                  on={generateFollowupsOn}
                  onChange={(on) => update({ generateFollowups: on })}
                />
              ) : null}
              {repo.data ? <BaseBranchPill repo={repo.data} /> : null}
            </>
          }
          footerEnd={
            <>
              <ModeSegment
                planFirst={draft.planFirst}
                planning={planning}
                onModeChange={(planFirst) => update({ planFirst })}
              />
              <kbd
                aria-hidden="true"
                className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
              >
                {submitShortcutHint()}
              </kbd>
            </>
          }
        />

        <SuggestedChips onPick={(text) => update({ text })} />
      </div>

      {plan !== null ? (
        <PlanReview
          plan={plan}
          starting={starting}
          onStepsChange={(steps) => setPlan((current) => (current ? { ...current, steps } : current))}
          onStart={() => void startPlanned()}
          onDiscard={() => setPlan(null)}
        />
      ) : null}
    </div>
  )
}

/** Worktree opt-out toggle (#worktree-toggle): a checkbox-style chip for single skill runs.
 *  Checked = isolated worktree (the default); unchecked = run in the repo working tree. */
function WorktreeToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-slot="worktree-toggle"
      onClick={() => onChange(!on)}
      title={
        on
          ? 'Runs in an isolated worktree — uncheck to run in the repo working tree'
          : 'Runs in the repo working tree — check to isolate in a worktree'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Worktree
    </button>
  )
}

/** Autonomous toggle (#autonomous): checked = the run never pauses for you, auto-continuing
 *  until the agent is done. No "needs you" is ever raised. */
function AutonomousToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot="autonomous-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? 'Plan-first runs are interactive — autonomous is unavailable'
          : on
            ? 'Autonomous — the agent runs to completion without pausing for you'
            : 'Runs interactively — check to let the agent finish without pausing for you'
      }
      className={cn(chipClass, on && !disabled && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Autonomous
    </button>
  )
}

/** Follow-up toggle: checked lets agents append newly discovered work to the task inbox.
 *  Handoff journaling remains active either way. */
function GenerateFollowupsToggle({
  on,
  onChange,
}: {
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-slot="generate-followups-toggle"
      onClick={() => onChange(!on)}
      title={
        on
          ? 'Agents can add newly discovered follow-up work to the task inbox'
          : 'Follow-up generation is off; agents still maintain the handoff journal'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Follow-ups
    </button>
  )
}

/** The mockup's `.chip`: a quiet bordered pill that darkens on hover. */
const chipClass =
  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55'

const chevron = <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #377's project-first ordering):
 * ONE pill for both kinds of source. Groups follow the mockup — Project skills (bold), Global,
 * then Workflows.
 */
function SourcePill({
  source,
  ready,
  skills,
  workflows,
  onPick,
}: {
  source: TaskSource
  ready: boolean
  skills: readonly Skill[]
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank in JS (cmdk's own score-sort does not re-order reliably here), then split the
  // ranked matches into the Project/Global groups so each group stays match-ordered.
  const matched = searchSkills(skills, search)
  const project = matched.filter(isProjectSkill)
  const global = matched.filter((skill) => !isProjectSkill(skill))
  const matchedWorkflows = searchWorkflows(workflows, search)
  const nothingMatches = project.length === 0 && global.length === 0 && matchedWorkflows.length === 0
  const pick = (next: TaskSource) => {
    onPick(next)
    setOpen(false)
  }

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => pick({ source: 'skill', ref: skill.name })}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {/* Read-only "View skill" (spec §Skills) — the Settings catalog's detail component
            as a dialog. stopPropagation: viewing must not pick the source. */}
        <button
          type="button"
          data-slot="source-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  return (
    <>
      <SkillPreviewDialog skill={preview} onClose={() => setPreview(null)} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="source-pill"
            aria-label="Choose a skill or workflow"
            disabled={!ready}
            className={cn(chipClass, 'border-foreground/60 font-mono text-[11.5px] font-semibold text-foreground')}
          >
            {source.source === 'skill' ? (
              <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            ) : (
              <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            )}
            <span className="max-w-44 truncate">{ready ? source.ref : '…'}</span>
            {chevron}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills & workflows…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            {/* The 3rem headroom is the CommandInput row: the popper's available-height var
                covers the whole popover, and the list must leave the search box visible. */}
            <CommandList
              ref={listRef}
              data-slot="source-menu"
              className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
              {/* Project skills lead, Global trails everything — the closer a skill lives
                  to the repo, the more likely it's the one being picked. */}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">
                  {project.map((skill) => skillItem(skill, true))}
                </CommandGroup>
              ) : null}
              {matchedWorkflows.length > 0 ? (
                <CommandGroup heading="Workflows">
                  {matchedWorkflows.map((workflow) => {
                    const selected = source.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => pick({ source: 'workflow', ref: workflow.name })}
                      >
                        <span className="shrink-0 font-mono text-xs">{workflow.name}</span>
                        {workflow.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                            {workflow.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ) : null}
              {global.length > 0 ? (
                <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** Runner choice — rendered only when the host offers more than one backend, so a claude-only
 *  machine keeps the simple form (legacy rule). */
function RunnerPill({
  runners,
  value,
  onPick,
}: {
  runners: readonly Runner[]
  value: Runner
  onPick: (runner: Runner) => void
}) {
  const options = RUNNERS.filter((r) => runners.includes(r.id))
  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={value}
      value={value}
      onPick={(next) => onPick(next as Runner)}
      options={options.map((r) => ({ value: r.id, label: r.label, desc: r.desc }))}
    />
  )
}

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  hint,
  disabledHint,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
}) {
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledHint : hint}
      className={chipClass}
    >
      {label}
      {chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span title={disabledHint} className="inline-flex">
        {trigger}
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={`${slot}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="text-[11.5px] text-muted-foreground">{option.desc}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Base-branch picker: worktrees fork from it and PRs target it. It is repo-level CONFIG
 *  (`PUT /api/config`, exactly the legacy Repo tab's picker), not a per-run flag — so it
 *  mutates the server and refetches, rather than living in the draft. Hidden without git. */
function BaseBranchPill({ repo }: { repo: RepoResponse }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(
        result.baseBranch
          ? `New tasks will branch off "${result.baseBranch}" (PRs target it too).`
          : 'Base branch cleared — tasks follow the current checkout.',
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!repo.info) return null
  const current = repo.baseBranch ?? repo.info.branch
  return (
    <PickerPill
      slot="base-pill"
      ariaLabel="Base branch"
      label={<span className="font-mono text-[11.5px]">base: {current}</span>}
      value={repo.baseBranch ?? ''}
      onPick={(value) => mutation.mutate(value === '' ? null : value)}
      options={[
        { value: '', label: `current checkout (${repo.info.branch})`, desc: 'Follow whatever is checked out' },
        ...repo.branches.map((branch) => ({ value: branch, label: branch })),
      ]}
    />
  )
}

/** The `Start | Plan first` segment (#383): a real toggle with an UNMISTAKABLE selected state.
 *  "Start" selected keeps the quiet card fill; "Plan first" selected takes the mockup's
 *  contrast fill + focus ring (`.seg .plan-active`) — plan mode must never be ambient. The
 *  active plan segment doubles as the busy indicator while `POST /api/plan` is in flight. */
function ModeSegment({
  planFirst,
  planning,
  onModeChange,
}: {
  planFirst: boolean
  planning: boolean
  onModeChange: (planFirst: boolean) => void
}) {
  return (
    <div
      data-slot="mode-seg"
      role="radiogroup"
      aria-label="Run mode"
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!planFirst}
        onClick={() => onModeChange(false)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          !planFirst
            ? 'bg-card font-semibold text-foreground shadow-xs'
            : 'font-medium text-muted-foreground hover:text-foreground',
        )}
      >
        Start
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={planFirst}
        aria-busy={planning || undefined}
        data-slot="mode-plan"
        onClick={() => onModeChange(true)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          planFirst
            ? 'bg-contrast font-semibold text-contrast-foreground ring-2 ring-ring/55'
            : 'font-medium text-muted-foreground hover:text-foreground',
          planning && 'animate-pulse',
        )}
      >
        {planning ? 'Planning…' : 'Plan first'}
      </button>
    </div>
  )
}

/** Honest static starters (the mockup's ghost chips): they only fill the textarea — the user
 *  still aims and submits. */
const SUGGESTIONS = [
  'Fix a failing or flaky test',
  'Summarize recent commits on this branch',
  'Update the README for recent changes',
]

function SuggestedChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mt-7 flex flex-wrap justify-center gap-2 max-md:justify-start">
      {SUGGESTIONS.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          data-slot="suggested-chip"
          onClick={() => onPick(suggestion)}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {suggestion}
        </button>
      ))}
    </div>
  )
}
