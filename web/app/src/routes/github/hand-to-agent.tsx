import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  PlayIcon,
  SparklesIcon,
  WorkflowIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'

import { createRun, putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import type { GithubItem, Skill, WorkflowDef } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SkillPreviewDialog } from '@/components/skill-detail'
import { githubRunBody } from '@/lib/github-task'
import {
  autoApplyText,
  insertTemplate,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import {
  bumpSkillUsage,
  isProjectSkill,
  partitionSkillsForDisplay,
  searchSkills,
  searchWorkflows,
  skillKeywords,
} from '@/lib/skills'
import { isSubmitShortcut, submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import { readFollowupPrompt, writeFollowupPrompt } from './hand-to-agent-draft'

/**
 * The detail pane's "Hand this to the agent" panel: the legacy chip walls replaced by
 * searchable cmdk dropdowns (#385) — one single-select for the workflow, one multi-select for
 * skills, project skills first and bold (#377), the same grammar as the /new composer's
 * source picker. The run body is `githubRunBody`'s three-way rule (lib/github-task.ts), so
 * the POST is exactly the legacy tab's.
 *
 * Picker state lives in the ROUTE, not here (legacy parity: your workflow/skill selection
 * survives switching between issues — it is a way of working, not a property of one item) —
 * `github.tsx` also persists it to localStorage (#408) so it survives a reload and pre-fills a
 * hand-off you have never touched (`hand-to-agent-draft.ts`). `skills` arrives already ordered
 * most-used → project → global (`orderSkillsByUsage`, #519) — this component just renders it.
 *
 * The selected skills render as an always-visible chip row OUTSIDE the dropdown — the legacy
 * invariant "the filter can't hide your selection", carried over: cmdk may filter the list,
 * never the selection.
 *
 * The custom prompt persists per-item to localStorage as you type (#408 — keyed by `item.url`
 * so distinct hand-off targets never collide) and submits on ⌘/Ctrl+Enter — deliberately NOT
 * on a bare Enter, unlike the thread composer's `isSubmitShortcut`: this is a multi-line
 * instructions box, so Enter alone inserts a newline (the textarea's own default).
 */
export function HandToAgent({
  item,
  workflows,
  skills,
  workflow,
  onWorkflowChange,
  selectedSkills,
  onSkillsChange,
  queuedRunId,
  onQueued,
}: {
  item: GithubItem
  workflows: readonly WorkflowDef[]
  skills: readonly Skill[]
  workflow: string | null
  onWorkflowChange: (workflow: string | null) => void
  selectedSkills: readonly string[]
  onSkillsChange: (skills: readonly string[]) => void
  /** The run already queued from this item, if any — renders the "✓ queued" affordance. */
  queuedRunId: string | null
  onQueued: (url: string, runId: string) => void
}) {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  // A skill deleted since it was toggled must not reach the server (legacy rule).
  const validSkills = selectedSkills.filter((name) => skills.some((skill) => skill.name === name))
  // Optional custom prompt (#gh-custom-prompt): empty → the default "Fix GitHub issue #N …"
  // text. The route remounts this component per item (key={item.url}); the DRAFT — not plain
  // component state (#408) — restores whatever was typed for THIS item, so switching away and
  // back (or a page refresh) never loses it.
  const [prompt, setPrompt] = useState(() => readFollowupPrompt(item.url))
  const promptRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    writeFollowupPrompt(item.url, prompt)
  }, [item.url, prompt])

  // Follow-up prompt templates (#413): built-in unless the user has edited them in Settings →
  // Prompt templates (`ui-state.json`'s `promptTemplates`).
  const templates = useMemo(
    () => normalizePromptTemplates(uiState.data?.promptTemplates),
    [uiState.data?.promptTemplates],
  )
  const insertPromptTemplate = (snippet: string) => {
    const el = promptRef.current
    const caret = el?.selectionStart ?? prompt.length
    const result = insertTemplate(prompt, caret, snippet)
    setPrompt(result.text)
    // Restore focus + caret after the state update repaints the textarea. The menu's Popover
    // suppresses its own focus-return (`onCloseAutoFocus`), so this is the last word on focus.
    requestAnimationFrame(() => {
      promptRef.current?.focus()
      promptRef.current?.setSelectionRange(result.caret, result.caret)
    })
  }

  // Auto-apply (#413 follow-up): picking a skill fills the prompt with the templates assigned to
  // it — but only while the box is untouched, per `resolveAutoApply`. Deselecting takes the
  // auto-applied text back out again, so the box always reflects the current selection until the
  // moment the user types, after which it is theirs.
  const autoText = autoApplyText(templates, validSkills)
  const promptRefValue = useRef(prompt)
  promptRefValue.current = prompt
  const autoAppliedRef = useRef('')
  useEffect(() => {
    // Reads/writes go through refs, never a setState updater: StrictMode double-invokes those in
    // dev, which would double-apply the ref bookkeeping (the composer's #double-paste hazard).
    const resolved = resolveAutoApply(promptRefValue.current, autoAppliedRef.current, autoText)
    autoAppliedRef.current = resolved.applied
    if (resolved.text !== promptRefValue.current) setPrompt(resolved.text)
    // `autoText` is a derived STRING, so this fires only when the assigned set really changes —
    // not on every render that rebuilds the skills array.
  }, [autoText])

  const start = useMutation({
    mutationFn: () => createRun(githubRunBody(item, workflow, validSkills, prompt)),
    onSuccess: (created) => {
      // The GitHub tab never starts variants, so the answer is a single record.
      const run = 'runs' in created ? created.runs[0] : created
      if (run) onQueued(item.url, run.id)
      // Frequency sort (#408): every hand-off skill counts, mirroring the /new composer.
      // Only bump once the CURRENT map is actually known (`uiState.data` present). The PUT
      // merge is shallow (`uiStateSchema` passthrough, src/server/server.ts), so the client
      // must send the WHOLE map — bumping off an unresolved or errored query would send a
      // one-entry map and REPLACE every count the user has accumulated. Skipping the bump
      // costs one count; sending it would cost the whole history. Fire-and-forget either way.
      if (validSkills.length > 0 && uiState.data !== undefined) {
        const nextUsage = validSkills.reduce(
          (usage, name) => bumpSkillUsage(usage, name),
          uiState.data.skillUsage,
        )
        void putUiState({ skillUsage: nextUsage })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
          .catch(() => {})
      }
      // The prompt is spent; the picker choices remain (legacy keeps its pills too, #408).
      // Clear BOTH the store and the state: the persist effect keys on `prompt`, so spending
      // only the store would leave the textarea showing text that no longer exists anywhere —
      // text that then vanishes on the next remount.
      writeFollowupPrompt(item.url, '')
      setPrompt('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const submitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const shouldSubmit =
      isSubmitShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      }) && (event.metaKey || event.ctrlKey) // multi-line box: bare Enter inserts a newline
    if (!shouldSubmit) return
    event.preventDefault()
    if (!start.isPending) start.mutate()
  }

  const toggleSkill = (name: string) =>
    onSkillsChange(
      selectedSkills.includes(name)
        ? selectedSkills.filter((existing) => existing !== name)
        : [...selectedSkills, name],
    )

  return (
    <section data-slot="gh-hand" className="mt-7 rounded-lg border border-border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
        <ZapIcon aria-hidden="true" className="size-3.5 text-violet" />
        Hand this to the agent
      </h3>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <WorkflowPicker workflows={workflows} value={workflow} onChange={onWorkflowChange} />
        <SkillsPicker
          skills={skills}
          skillUsage={uiState.data?.skillUsage}
          selected={validSkills}
          onToggle={toggleSkill}
        />
        <PromptTemplateMenu templates={templates} onInsert={insertPromptTemplate} />
      </div>

      {/* Chips and the trigger's count render from `validSkills`, not `selectedSkills`: the run
          POSTs `validSkills`, so showing a deleted skill here would promise the run a skill it
          will not use. What the composer shows and what it sends are the same list. */}
      {validSkills.length > 0 ? (
        <div data-slot="gh-skill-chips" className="mt-2.5 flex flex-wrap gap-1.5">
          {validSkills.map((name) => (
            <button
              key={name}
              type="button"
              data-slot="gh-skill-chip"
              data-skill={name}
              onClick={() => toggleSkill(name)}
              title="Remove this skill"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-px font-mono text-[11px] font-medium text-foreground transition-colors hover:bg-danger/10 hover:text-danger"
            >
              {name}
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          ))}
        </div>
      ) : null}

      <Textarea
        ref={promptRef}
        data-slot="gh-custom-prompt"
        aria-label="Custom prompt"
        aria-keyshortcuts="Control+Enter Meta+Enter"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={submitShortcut}
        placeholder={`Add instructions for the agent… (empty uses the default "${item.kind === 'pr' ? 'Address' : 'Fix'} #${item.number}" prompt)`}
        className="mt-3 min-h-20 text-[13px]"
      />

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button
          variant="contrast"
          data-action="gh-run"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          <PlayIcon aria-hidden="true" className="size-3.5" />
          Run agent on this {item.kind === 'pr' ? 'PR' : 'issue'}
        </Button>
        <kbd
          aria-hidden="true"
          className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
        >
          {submitShortcutHint()}
        </kbd>
        {queuedRunId ? (
          <>
            <span data-slot="gh-queued" className="flex items-center gap-1 text-xs font-medium text-success">
              <CheckIcon aria-hidden="true" className="size-3.5" />
              queued
            </span>
            <Link
              to={`/tasks/${queuedRunId}`}
              data-slot="gh-view-run"
              className="text-xs font-semibold text-violet hover:underline"
            >
              View task →
            </Link>
          </>
        ) : null}
      </div>
    </section>
  )
}

/** The pickers' shared trigger chip — the /new footer's pill grammar. */
const triggerClass =
  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/**
 * The workflow dropdown: single-select, and — legacy parity — selecting the chosen workflow
 * again deselects it (no workflow means the toggled skills, or quick-task, drive the run).
 */
function WorkflowPicker({
  workflows,
  value,
  onChange,
}: {
  workflows: readonly WorkflowDef[]
  value: string | null
  onChange: (workflow: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank matches in JS rather than trusting cmdk's built-in score-sort.
  const matched = searchWorkflows(workflows, search)
  return (
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
          data-slot="gh-workflow-trigger"
          aria-label="Choose a workflow"
          className={cn(triggerClass, value && 'border-foreground/60 font-mono text-[11.5px] font-semibold text-foreground')}
        >
          <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
          <span className="max-w-44 truncate">{value ?? 'workflow'}</span>
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[320px] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="search workflows…"
            value={search}
            onValueChange={setSearch}
            onInput={() => listRef.current?.scrollTo(0, 0)}
          />
          <CommandList ref={listRef} data-slot="gh-workflow-menu" className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            {matched.length === 0 ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
            <CommandGroup>
              {matched.map((workflowDef) => {
                const selected = value === workflowDef.name
                return (
                  <CommandItem
                    key={workflowDef.name}
                    value={`workflow ${workflowDef.name}`}
                    keywords={skillKeywords(workflowDef.name, workflowDef.description)}
                    data-slot="gh-workflow-option"
                    data-workflow={workflowDef.name}
                    onSelect={() => {
                      onChange(selected ? null : workflowDef.name)
                      setOpen(false)
                    }}
                  >
                    <span className="shrink-0 font-mono text-xs">{workflowDef.name}</span>
                    {workflowDef.description ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                        {workflowDef.description}
                      </span>
                    ) : null}
                    {selected ? (
                      <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The skills dropdown: multi-select — toggling keeps it open, because picking a chain is
 * several toggles — grouped Most used (#519), then Project skills (bold) before Global, per
 * #377. Every row carries a read-only "View skill" eye (spec §Skills): it opens the SAME
 * detail component the Settings catalog renders, as a dialog, without toggling the row.
 */
function SkillsPicker({
  skills,
  skillUsage,
  selected,
  onToggle,
}: {
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  selected: readonly string[]
  onToggle: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank matches in JS, then split into the #519 tiers (cmdk's own sort is unreliable here).
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const isSelected = selected.includes(skill.name)
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="gh-skill-option"
        data-skill={skill.name}
        data-selected={isSelected ? 'true' : undefined}
        onSelect={() => onToggle(skill.name)}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>{skill.name}</span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span>
        ) : null}
        <button
          type="button"
          data-slot="gh-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          // stopPropagation: the eye must never toggle the row it sits on.
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {isSelected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  if (skills.length === 0) return null
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
            data-slot="gh-skills-trigger"
            aria-label="Choose skills"
            className={cn(triggerClass, selected.length > 0 && 'border-foreground/60 font-semibold text-foreground')}
          >
            <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            skills{selected.length > 0 ? ` · ${selected.length}` : ''}
            <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-[336px] max-w-[calc(100vw-2rem)] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            <CommandList ref={listRef} data-slot="gh-skill-menu" className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
              {mostUsed.length === 0 && project.length === 0 && global.length === 0 ? (
                <CommandEmpty>Nothing matches.</CommandEmpty>
              ) : null}
              {mostUsed.length > 0 ? (
                <CommandGroup heading="Most used">
                  {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">{project.map((skill) => skillItem(skill, true))}</CommandGroup>
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
