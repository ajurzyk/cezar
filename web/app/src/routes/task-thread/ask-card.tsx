import { useState } from 'react'

import { useSendMessage } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@/protocol/ui-events'

/** Format one answered question the way the agent reads it back (mirrors the
 *  human-readable text the composer would carry). */
function formatAnswer(question: UiAskQuestion, labels: string[]): string {
  return `${question.header}: ${labels.join(', ')}`
}

/**
 * The AskUser card (#473): the agent asked a structured multiple-choice question
 * via `CEZ:ASK`; render each option as a clickable chip. A single-select
 * question resolves on click; a multi-select one collects toggles and resolves
 * on Send. Either way the answer rides the normal reply seam
 * (`useSendMessage` → `POST /api/runs/:id/messages`), and the composer below
 * stays enabled for a free-form "Other". Once resolved (the reducer flips it
 * when the next user message lands), the card collapses to a compact summary.
 */
export function AskCard({ ask, runId }: { ask: ThreadAsk; runId: string }) {
  const sendMessage = useSendMessage(runId)

  if (ask.resolved) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <span className="text-soft-foreground">Answered</span>
        {ask.answer ? <span className="ml-1.5 text-foreground">{ask.answer}</span> : null}
      </div>
    )
  }

  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      className="rounded-lg border border-primary/25 bg-primary/[0.04] px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-primary">The agent is asking</span>
      </div>
      <div className="flex flex-col gap-4">
        {ask.questions.map((question, index) => (
          <AskQuestionBlock
            key={question.id ?? index}
            question={question}
            disabled={sendMessage.isPending}
            onAnswer={(labels) =>
              void sendMessage.mutateAsync({ text: formatAnswer(question, labels) })
            }
          />
        ))}
      </div>
    </div>
  )
}

function AskQuestionBlock({
  question,
  disabled,
  onAnswer,
}: {
  question: UiAskQuestion
  disabled: boolean
  onAnswer: (labels: string[]) => void
}) {
  const multiSelect = question.multiSelect === true
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (label: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <div role="group" aria-label={question.question}>
      <div className="mb-0.5 flex items-center gap-2">
        <span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
          {question.header}
        </span>
        {multiSelect ? (
          <span className="ml-auto text-[10.5px] text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      <p className="mb-2.5 text-sm font-semibold text-foreground">{question.question}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((option) => {
          const isSelected = selected.has(option.label)
          return (
            <button
              key={option.label}
              type="button"
              disabled={disabled}
              aria-pressed={multiSelect ? isSelected : undefined}
              onClick={() => (multiSelect ? toggle(option.label) : onAnswer([option.label]))}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md border px-3.5 py-2.5 text-left transition-colors',
                'hover:border-primary/50 hover:bg-primary/[0.06] disabled:pointer-events-none disabled:opacity-50',
                isSelected ? 'border-primary/60 bg-primary/[0.06]' : 'border-border bg-card',
              )}
            >
              <span className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
                {multiSelect ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 items-center justify-center rounded border text-[10px]',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-soft-foreground',
                    )}
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                ) : null}
                {option.label}
              </span>
              {option.description ? (
                <span className="text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      {multiSelect ? (
        <div className="mt-2.5 flex items-center gap-2.5">
          <Button
            size="sm"
            disabled={disabled || selected.size === 0}
            onClick={() => onAnswer([...selected])}
          >
            Send answer
          </Button>
          <span className="text-[11.5px] text-soft-foreground">
            {selected.size} selected — or type a reply below
          </span>
        </div>
      ) : null}
    </div>
  )
}
