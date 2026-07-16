import { useMutation, useQueryClient } from '@tanstack/react-query'
import { NotebookPenIcon, PlusIcon, XIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import {
  DEFAULT_PROMPT_TEMPLATES,
  makeTemplateId,
  normalizePromptTemplates,
  type PromptTemplate,
} from '@/lib/prompt-templates'

/**
 * Settings → Prompt templates (#413): "add the settings pane for editing these prompt templates
 * so I can make sure it always start as I wanted" — the issue's own words. The list here is
 * exactly the one the GitHub hand-over and Inbox follow-up composers read
 * (`PromptTemplateMenu` / `normalizePromptTemplates`), so an edit here reshapes both at once.
 *
 * Zero-config: an untouched repo shows `DEFAULT_PROMPT_TEMPLATES` with nothing persisted yet.
 * The first Save writes the full (possibly edited-in-place) list to `ui-state.json`'s additive
 * `promptTemplates` key — same "edit locally, explicit Save" shape as Settings → Agents' system
 * prompt, because a PUT on every keystroke would be a worse control, not a simpler one.
 */
export function PromptTemplatesSection() {
  const uiState = useUiState()

  if (uiState.isPending) {
    return (
      <p data-slot="prompt-templates-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading prompt templates…
      </p>
    )
  }
  if (uiState.isError) {
    return (
      <CenteredState
        icon={<NotebookPenIcon />}
        tone="danger"
        title="Prompt templates did not load"
        subtitle={uiState.error.message}
        heading="h2"
      />
    )
  }
  // Keyed on whether the server has ever written this key: an untouched repo (undefined) and an
  // explicitly-cleared one ([]) both come through `normalizePromptTemplates` correctly already,
  // so the form below never has to know the difference.
  return <PromptTemplatesForm initial={normalizePromptTemplates(uiState.data.promptTemplates)} />
}

function PromptTemplatesForm({ initial }: { initial: PromptTemplate[] }) {
  const queryClient = useQueryClient()
  const [templates, setTemplates] = useState<PromptTemplate[]>(initial)
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')

  const save = useMutation({
    mutationFn: (next: PromptTemplate[]) => putUiState({ promptTemplates: next }),
    onSuccess: (merged) => {
      queryClient.setQueryData(queryKeys.uiState, merged)
      toast('Prompt templates saved')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const dirty = JSON.stringify(templates) !== JSON.stringify(initial)
  const invalid = templates.some((t) => t.label.trim() === '' || t.text.trim() === '')

  const updateTemplate = (id: string, patch: Partial<Pick<PromptTemplate, 'label' | 'text'>>) =>
    setTemplates((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  const removeTemplate = (id: string) =>
    setTemplates((current) => current.filter((t) => t.id !== id))

  const addTemplate = () => {
    const label = newLabel.trim()
    const text = newText.trim()
    if (!label || !text) return
    setTemplates((current) => [...current, { id: makeTemplateId(), label, text }])
    setNewLabel('')
    setNewText('')
  }

  const resetToDefaults = () => setTemplates(DEFAULT_PROMPT_TEMPLATES.map((t) => ({ ...t })))

  return (
    <div
      data-slot="prompt-templates-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <Field
        title="Prompt templates"
        hint="Reusable snippets you can insert into a follow-up — the GitHub hand-over and the Inbox's “Add instructions” box both offer this list."
      >
        <div data-slot="prompt-template-list" className="flex flex-col gap-3">
          {templates.length === 0 ? (
            <p data-slot="prompt-templates-empty" className="text-[13px] text-soft-foreground">
              No templates. Add one below, or reset to the built-ins.
            </p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                data-slot="prompt-template-row"
                data-template={template.id}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Label for ${template.label || 'this template'}`}
                    data-slot="prompt-template-label-input"
                    value={template.label}
                    maxLength={80}
                    onChange={(event) => updateTemplate(template.id, { label: event.target.value })}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-action="prompt-template-remove"
                    title="Remove this template"
                    onClick={() => removeTemplate(template.id)}
                  >
                    <XIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                </div>
                <Textarea
                  aria-label={`Text for ${template.label || 'this template'}`}
                  data-slot="prompt-template-text-input"
                  value={template.text}
                  maxLength={2000}
                  onChange={(event) => updateTemplate(template.id, { text: event.target.value })}
                  className="min-h-14 text-[13px]"
                />
              </div>
            ))
          )}
        </div>

        <div
          data-slot="prompt-template-new"
          className="flex flex-col gap-1.5 rounded-md border border-dashed border-border p-3"
        >
          <Input
            aria-label="New template label"
            data-slot="prompt-template-new-label"
            placeholder='Label (e.g. "Add tests")'
            value={newLabel}
            maxLength={80}
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <Textarea
            aria-label="New template text"
            data-slot="prompt-template-new-text"
            placeholder="The instructions to insert…"
            value={newText}
            maxLength={2000}
            onChange={(event) => setNewText(event.target.value)}
            className="min-h-14 text-[13px]"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="prompt-template-add"
            disabled={!newLabel.trim() || !newText.trim()}
            onClick={addTemplate}
            className="self-start"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            Add template
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="contrast"
            size="sm"
            data-action="prompt-templates-save"
            disabled={!dirty || invalid || save.isPending}
            onClick={() => save.mutate(templates)}
          >
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="prompt-templates-reset"
            disabled={save.isPending}
            onClick={resetToDefaults}
          >
            Reset to defaults
          </Button>
          {invalid ? (
            <p data-slot="prompt-templates-invalid" className="text-[11px] text-danger">
              Every template needs both a label and text.
            </p>
          ) : null}
        </div>
      </Field>
    </div>
  )
}

/** The Appearance/Agents sections' field chassis — same rhythm, so Settings reads as one surface. */
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
