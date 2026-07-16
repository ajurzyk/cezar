import { FileCogIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '@/api/client'
import { useAgentConfig, useAgentConfigFile, useHealth, usePutAgentConfigFile } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, Runner } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { availableRunners } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'

/**
 * Settings → Agent config (spec #404): read and edit the coding agents' OWN
 * config files — Claude/Codex/OpenCode settings, MCP and memory — raw, per
 * scope, highlighted. cezar never re-serializes; it shows each scope's file and
 * the vendor's own documented precedence, and never claims a merge it does not
 * perform. Writing is a local-machine capability: in hosted mode the whole
 * section is read-only (the server refuses every write regardless).
 */

const RUNNER_ORDER: Runner[] = ['claude', 'codex', 'opencode']
const RUNNER_LABEL: Record<Runner, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
const KIND_ORDER = ['settings', 'mcp', 'memory'] as const
const KIND_LABEL: Record<string, string> = { settings: 'Settings', mcp: 'MCP', memory: 'Memory & instructions' }

/** What this file actually governs for a run — the honest label the spec insists on. */
function effectLabel(file: AgentConfigFile): string {
  if (file.seeded) return 'Copied into each run’s worktree — takes effect on your next run.'
  if (file.tracked === 'tracked') return 'Runs read the committed copy — this edit applies after you commit it.'
  if (file.tracked === 'outside-repo') return 'Applies to every session on this machine.'
  return 'Personal, git-ignored.'
}

export function AgentConfigSection() {
  const listing = useAgentConfig()
  const health = useHealth()
  const installed = useMemo<Runner[]>(
    () => (health.data ? availableRunners(health.data.checks) : RUNNER_ORDER),
    [health.data],
  )

  if (listing.isPending) {
    return (
      <p data-slot="agent-config-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent config…
      </p>
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<FileCogIcon />}
        tone="danger"
        title="Agent config did not load"
        subtitle={listing.error.message}
        heading="h2"
      />
    )
  }
  return <AgentConfigView listing={listing.data} installed={installed} />
}

function AgentConfigView({ listing, installed }: { listing: AgentConfigListing; installed: Runner[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = listing.files.find((f) => f.id === selectedId) ?? null

  return (
    <div data-slot="agent-config" className="flex flex-col gap-4 p-4 md:p-6">
      {!listing.editable && (
        <div
          data-slot="agent-config-readonly"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-soft-foreground"
        >
          Read-only: agent config is edited from the machine that owns the checkout (this cockpit runs in hosted
          mode). You can still see every file and which one wins.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <nav data-slot="agent-config-nav" className="flex flex-col gap-5">
          {RUNNER_ORDER.map((runner) => {
            const files = listing.files.filter((f) => f.runners[0] === runner)
            if (files.length === 0) return null
            const isInstalled = installed.includes(runner)
            return (
              <section key={runner} data-slot="agent-config-runner" data-runner={runner}>
                <header className="mb-2 flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold">{RUNNER_LABEL[runner]}</h3>
                  {!isInstalled && (
                    <Badge variant="outline" className="text-[11px] text-soft-foreground">
                      not installed
                    </Badge>
                  )}
                </header>
                {runner !== 'claude' && (
                  <p className="mb-2 text-[12px] text-soft-foreground">
                    An editor-plus-commit: a saved change reaches a run after you commit it to the base branch.
                  </p>
                )}
                {KIND_ORDER.map((kind) => {
                  const ofKind = files.filter((f) => f.kind === kind)
                  if (ofKind.length === 0) return null
                  return (
                    <div key={kind} className="mb-3">
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-soft-foreground">
                        {KIND_LABEL[kind]}
                      </p>
                      <ul className="flex flex-col gap-1">
                        {ofKind.map((file) => (
                          <li key={file.id}>
                            <button
                              type="button"
                              data-slot="agent-config-file"
                              data-selected={file.id === selectedId}
                              onClick={() => setSelectedId(file.id)}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                                file.id === selectedId ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.label}</span>
                              {file.seeded && (
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  seeded
                                </Badge>
                              )}
                              {!file.exists && (
                                <span className="shrink-0 text-[11px] text-soft-foreground">absent</span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </section>
            )
          })}
        </nav>

        <div data-slot="agent-config-editor-pane">
          {selected ? (
            <FileEditor key={selected.id} file={selected} />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed border-border text-[13px] text-soft-foreground">
              Select a config file to view or edit it.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FileEditor({ file }: { file: AgentConfigFile }) {
  const fileQuery = useAgentConfigFile(file.id)
  const put = usePutAgentConfigFile(file.id)
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [formatError, setFormatError] = useState<string | null>(null)

  // Seed the draft from the server contents; re-seed when the file's version changes underneath.
  const loadedVersion = fileQuery.data?.version ?? null
  useEffect(() => {
    if (fileQuery.data) {
      setDraft(fileQuery.data.content)
      setConflict(false)
      setFormatError(null)
    }
  }, [fileQuery.data?.version, fileQuery.data])

  const content = draft ?? fileQuery.data?.content ?? ''
  const dirty = fileQuery.data ? content !== fileQuery.data.content : false
  const canWrite = file.writable

  const save = () => {
    setFormatError(null)
    setConflict(false)
    put.mutate(
      { content, version: loadedVersion },
      {
        onSuccess: () => {
          setDraft(null)
          toast(`${file.exists ? 'Saved' : 'Created'} ${file.label}`)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setConflict(true)
          else if (err instanceof ApiError && err.status === 400) setFormatError(err.message)
          else toast((err as Error).message, { tone: 'danger' })
        },
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{file.label}</span>
        <Badge variant="outline" className="text-[10px] uppercase">
          {file.format}
        </Badge>
        <a
          href={file.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-soft-foreground underline hover:text-foreground"
        >
          docs
        </a>
      </div>

      <p data-slot="agent-config-precedence" className="text-[12px] text-soft-foreground">
        {file.precedence}
      </p>
      <p data-slot="agent-config-effect" className="text-[12px] text-foreground/80">
        {effectLabel(file)}
        {file.hotReload ? ` ${file.hotReload}` : ''}
      </p>

      {fileQuery.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading file…</p>
      ) : fileQuery.isError ? (
        <p className="text-[13px] text-destructive">{fileQuery.error.message}</p>
      ) : (
        <CodeEditor
          value={content}
          language={file.format}
          readOnly={!canWrite}
          onChange={setDraft}
          aria-label={`${file.label} contents`}
          className="h-[26rem]"
        />
      )}

      {formatError && (
        <p data-slot="agent-config-format-error" className="text-[12px] text-destructive">
          {formatError}
        </p>
      )}
      {conflict && (
        <div
          data-slot="agent-config-conflict"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]"
        >
          <span>The file changed on disk since you opened it.</span>
          <Button size="sm" variant="outline" onClick={() => void fileQuery.refetch()}>
            Reload from disk
          </Button>
        </div>
      )}

      {canWrite && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || put.isPending}>
            {file.exists ? 'Save' : 'Create'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(null)}
            disabled={!dirty || put.isPending}
          >
            Revert
          </Button>
          {dirty && <span className="text-[12px] text-soft-foreground">Unsaved changes</span>}
        </div>
      )}
    </div>
  )
}
