import { PlugIcon } from 'lucide-react'
import { useState } from 'react'

import { useAgentConfig } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, Runner } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FileEditor } from './agent-config-section'

/**
 * Settings → MCP (spec #404): a filtered view of the same config-file editor,
 * scoped to whichever file holds each runner's MCP servers. Only Claude has a
 * dedicated `.mcp.json`; Codex and OpenCode keep their servers inside their main
 * config — the same file the Agent config section opens — so the section says so
 * plainly rather than implying three parallel files. Claude's user/local MCP
 * scopes live in `~/.claude.json` (Claude's own state file) and are listed
 * read-only; cezar never edits it.
 */

const RUNNER_ORDER: Runner[] = ['claude', 'codex', 'opencode']
const RUNNER_LABEL: Record<Runner, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
const WHERE: Record<Runner, string> = {
  claude: 'A dedicated .mcp.json (key: mcpServers), shared via version control.',
  codex: 'Inside config.toml under [mcp_servers.<id>] — the same file as Codex’s settings.',
  opencode: 'Under the "mcp" key in opencode.json — the same file as OpenCode’s settings.',
}

export function McpSection() {
  const listing = useAgentConfig()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (listing.isPending) {
    return (
      <p data-slot="mcp-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading MCP config…
      </p>
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<PlugIcon />}
        tone="danger"
        title="MCP config did not load"
        subtitle={listing.error.message}
        heading="h2"
      />
    )
  }
  return <McpView listing={listing.data} selectedId={selectedId} onSelect={setSelectedId} />
}

function McpView({
  listing,
  selectedId,
  onSelect,
}: {
  listing: AgentConfigListing
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const mcpFiles = listing.files.filter((f) => f.holdsMcp)
  const selected = mcpFiles.find((f) => f.id === selectedId) ?? null

  return (
    <div data-slot="mcp" className="flex flex-col gap-4 p-4 md:p-6">
      <p className="text-[13px] text-soft-foreground">
        MCP servers give agents extra tools. Each runner stores them differently — cezar edits the real file
        in place.
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <nav data-slot="mcp-nav" className="flex flex-col gap-4">
          {RUNNER_ORDER.map((runner) => {
            const files = mcpFiles.filter((f) => f.runners[0] === runner)
            if (files.length === 0) return null
            return (
              <section key={runner} data-slot="mcp-runner" data-runner={runner}>
                <h3 className="mb-1 text-[13px] font-semibold">{RUNNER_LABEL[runner]}</h3>
                <p className="mb-2 text-[12px] text-soft-foreground">{WHERE[runner]}</p>
                <ul className="flex flex-col gap-1">
                  {files.map((file) => (
                    <McpFileRow key={file.id} file={file} selected={file.id === selectedId} onSelect={onSelect} />
                  ))}
                </ul>
              </section>
            )
          })}

          {listing.userMcp && (
            <section data-slot="mcp-user-claude">
              <h3 className="mb-1 text-[13px] font-semibold">Claude — user &amp; local scopes</h3>
              <p className="mb-2 text-[12px] text-soft-foreground">
                Managed by <code className="font-mono">claude mcp add</code> in {listing.userMcp.path} — cezar does
                not edit Claude’s state file.
              </p>
              {listing.userMcp.readable ? (
                listing.userMcp.servers.length > 0 ? (
                  <ul className="flex flex-wrap gap-1">
                    {listing.userMcp.servers.map((name) => (
                      <li key={name}>
                        <Badge variant="outline" className="font-mono text-[11px]">
                          {name}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-soft-foreground">No user-scoped MCP servers.</p>
                )
              ) : (
                <p className="text-[12px] text-soft-foreground">Could not read the file.</p>
              )}
            </section>
          )}
        </nav>

        <div data-slot="mcp-editor-pane">
          {selected ? (
            <FileEditor key={selected.id} file={selected} />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed border-border text-[13px] text-soft-foreground">
              Select a file to view or edit its MCP servers.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function McpFileRow({
  file,
  selected,
  onSelect,
}: {
  file: AgentConfigFile
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        data-slot="mcp-file"
        data-selected={selected}
        onClick={() => onSelect(file.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          selected ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.label}</span>
        {!file.exists && <span className="shrink-0 text-[11px] text-soft-foreground">absent</span>}
      </button>
    </li>
  )
}
