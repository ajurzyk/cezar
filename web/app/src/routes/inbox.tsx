import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, InboxIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { removeTodo, startTodo } from '@/api/client'
import { queryKeys, useRuns, useTodos } from '@/api/queries'
import type { TodoItem } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { EnginePills, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'

/**
 * `/inbox` — the follow-up inbox rebuilt in React (R6 Step 1.2, spec §"Skills, Workflows,
 * Inbox"): the card list the legacy `renderInbox()` drew, restyled to the design system.
 *
 * Functional parity with the legacy view (web/app.js, spec 007):
 *  - entries already turned into a task (`startedTaskId`) are hidden — they stay in
 *    `todos.json` as an audit trail (the legacy `visibleTodos()` rule);
 *  - Run → `POST /api/todos/:id/start`, then straight to the new task's thread (the legacy
 *    `showRunsView()` + `selectRun()` hop, expressed as navigation);
 *  - Dismiss → `DELETE /api/todos/:id` — check off, gone;
 *  - the meta row keeps age / action / source-task link (or the honest "source task
 *    deleted") / PR link / suggested skill.
 *
 * The nav badge is NOT this view's business: the global-events reducer maintains the todos
 * query from the SSE `todos` event and the shell derives the badge from it — this route only
 * reads the same query, so the two can never disagree.
 *
 * Every card wears the attention grammar's "needs you" rung (`deriveAttention` on `waiting`):
 * an inbox entry is by definition an agent waiting on a human decision, so the dot is the
 * same amber pulse a waiting run shows — one grammar, not a second dialect.
 */

/** The one attention rung an inbox entry can be on — see the doc block above. */
const CARD_ATTENTION = deriveAttention({ status: 'waiting' })

/** The legacy `visibleTodos()` rule: started entries are the audit trail, not the inbox. */
export function visibleTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.filter((todo) => !todo.startedTaskId)
}

/** Explicit intent wins; old todos infer actionability from an executable suggestion. */
export function isTodoRunnable(todo: TodoItem): boolean {
  return todo.runnable ?? Boolean(todo.suggestedSkill || todo.suggestedPrompt)
}

export function InboxRoute() {
  const todosQuery = useTodos()
  // Only to tell "source task" links from "source task deleted" — the legacy check against
  // its run map. The overview keeps this query warm, so revisits cost nothing.
  const runs = useRuns()

  const todos = todosQuery.data === undefined ? undefined : visibleTodos(todosQuery.data)

  return (
    <div data-route="inbox" className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Inbox". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Inbox</h1>
        <p className="text-[13px] text-soft-foreground">
          Follow-ups agents suggested when they finished a task.
        </p>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {todos === undefined ? (
          todosQuery.isError ? (
            <CenteredState
              icon={<TriangleAlertIcon />}
              tone="danger"
              title="Could not load the inbox"
              subtitle={todosQuery.error.message}
              heading="h2"
            />
          ) : null
        ) : todos.length === 0 ? (
          <CenteredState
            icon={<InboxIcon />}
            tone="neutral"
            title="Inbox empty"
            subtitle="Agents drop follow-up suggestions here when they finish a task."
            heading="h2"
          />
        ) : (
          <ul data-slot="todo-list" className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
            {todos.map((todo) => (
              <TodoCard
                key={todo.id}
                todo={todo}
                sourceTaskExists={
                  todo.taskId === undefined
                    ? null
                    : (runs.data?.some((run) => run.id === todo.taskId) ?? false)
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TodoCard({
  todo,
  /** null: no source task at all; false: it existed once but was deleted. */
  sourceTaskExists,
}: {
  todo: TodoItem
  sourceTaskExists: boolean | null
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Per card, not per route (#401): each card starts its OWN run, so "run this one on codex"
  // must not silently re-aim the card below it. Reset is free — a started card leaves the list.
  const [engine, setEngine] = useState<EnginePick>({ runner: null, model: null })
  const resolved = useResolvedEngine(engine)

  const start = useMutation({
    // A single-backend host sends no runner, and auto ('') stays implicit — the composer's
    // two body rules, so an Inbox run and a /new run of the same thing reach the same server.
    mutationFn: () =>
      startTodo(todo.id, {
        runner: resolved.runnerCount > 1 ? resolved.runner : undefined,
        model: resolved.model || undefined,
      }),
    onSuccess: ({ run }) => {
      // The server rewrote todos.json (SSE will confirm); the invalidations just refuse to
      // wait for the file watcher's debounce.
      void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void navigate(`/tasks/${run.id}`)
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const dismiss = useMutation({
    mutationFn: () => removeTodo(todo.id),
    onSuccess: () => {
      // Drop the card now (the legacy local filter) — the SSE `todos` broadcast is the
      // authoritative confirmation moments later.
      queryClient.setQueryData<TodoItem[]>(queryKeys.todos, (existing) =>
        existing?.filter((item) => item.id !== todo.id),
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const busy = start.isPending || dismiss.isPending
  const runnable = isTodoRunnable(todo)

  return (
    <li
      data-slot="todo-card"
      data-id={todo.id}
      className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-xs"
    >
      <StatusDot
        tone={CARD_ATTENTION.tone}
        pulse={CARD_ATTENTION.pulse}
        title={CARD_ATTENTION.label}
        className="mt-[5px]"
      />
      <div className="min-w-0 flex-1">
        <p data-slot="todo-summary" className="text-sm leading-snug font-medium text-foreground">
          {todo.summary}
        </p>
        <div
          data-slot="todo-meta"
          className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-soft-foreground"
        >
          {todo.ts ? <span>{shortAge(todo.ts)} ago</span> : null}
          {todo.action ? <span>{todo.action}</span> : null}
          {todo.taskId !== undefined ? (
            sourceTaskExists ? (
              <Link
                to={`/tasks/${todo.taskId}`}
                data-slot="todo-source"
                className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
              >
                source task
              </Link>
            ) : (
              <span data-slot="todo-source-gone">source task deleted</span>
            )
          ) : null}
          {todo.prUrl ? (
            <a
              href={todo.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-slot="todo-pr"
              className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
            >
              PR
            </a>
          ) : null}
          {todo.suggestedSkill ? (
            <span data-slot="todo-skill" className="font-mono">
              skill: {todo.suggestedSkill}
            </span>
          ) : null}
        </div>
        {/* Only a runnable card gets pills — an acknowledge-only note has no run to aim. */}
        {runnable ? (
          <div data-slot="todo-engine" className="mt-2.5 flex flex-wrap items-center gap-2">
            <EnginePills pick={engine} onChange={setEngine} disabled={busy} />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 self-center">
        {runnable ? (
          <>
            <Button
              type="button"
              variant="contrast"
              size="sm"
              data-action="todo-run"
              title="Start a task from this follow-up"
              disabled={busy}
              onClick={() => start.mutate()}
            >
              <PlayIcon aria-hidden="true" className="size-3" />
              Run
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="todo-dismiss"
              title="Check off (remove)"
              disabled={busy}
              onClick={() => dismiss.mutate()}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="contrast"
            size="sm"
            data-action="todo-acknowledge"
            title="Acknowledge and remove this note"
            disabled={busy}
            onClick={() => dismiss.mutate()}
          >
            <CheckIcon aria-hidden="true" className="size-3" />
            Acknowledge
          </Button>
        )}
      </div>
    </li>
  )
}
