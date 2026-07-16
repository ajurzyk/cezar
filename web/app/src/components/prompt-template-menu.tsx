import { ChevronDownIcon, NotebookPenIcon } from 'lucide-react'
import { Link } from 'react-router'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PromptTemplate } from '@/lib/prompt-templates'
import { cn } from '@/lib/utils'

/**
 * "Insert a template" — the trigger shared by the GitHub hand-over (#gh-custom-prompt) and
 * Inbox (#413) follow-up composers. A dropdown of reusable prompt snippets; picking one calls
 * `onInsert` with the snippet text and the composer decides where it lands (caret position via
 * `lib/prompt-templates.ts#insertTemplate`).
 *
 * Renders nothing when the list is empty — a user who cleared every template in Settings gets
 * no trigger, not an empty menu.
 */
export function PromptTemplateMenu({
  templates,
  onInsert,
  triggerClassName,
  disabled,
}: {
  templates: readonly PromptTemplate[]
  onInsert: (text: string) => void
  triggerClassName?: string
  disabled?: boolean
}) {
  if (templates.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="prompt-template-trigger"
          aria-label="Insert a prompt template"
          title="Insert a prompt template"
          disabled={disabled}
          className={cn(
            'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            triggerClassName,
          )}
        >
          <NotebookPenIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
          templates
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-slot="prompt-template-menu" className="w-[300px]">
        <DropdownMenuLabel className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
          Insert a template
        </DropdownMenuLabel>
        {templates.map((template) => (
          <DropdownMenuItem
            key={template.id}
            data-slot="prompt-template-option"
            data-template={template.id}
            title={template.text}
            className="flex-col items-start gap-0.5"
            onSelect={() => onInsert(template.text)}
          >
            <span className="text-[12.5px] font-medium text-foreground">{template.label}</span>
            <span className="line-clamp-1 text-[11px] text-soft-foreground">{template.text}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/settings/prompt-templates"
            data-slot="prompt-template-settings"
            className="text-[12px] text-muted-foreground"
          >
            Edit templates…
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
