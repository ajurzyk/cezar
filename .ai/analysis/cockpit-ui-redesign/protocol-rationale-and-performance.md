# Protocol v2 — rationale Q&A and performance analysis

Companion to the spec (`.ai/specs/2026-07-14-cockpit-ui-redesign.md`, § "Normalized agent-event protocol v2") and the protocols study (`agent-event-protocols.md`). Captures the design-review Q&A from 2026-07-14.

## 1. How does v2 compare to the vendor protocols, paseo, and ACP?

| | Claude Code `stream-json` | Codex app-server | OpenCode SSE | ACP | paseo |
|---|---|---|---|---|---|
| Nature | API mirror — NDJSON of raw Anthropic message envelopes | real UI protocol — JSON-RPC, thread → turn → **item** | HTTP+SSE, message → **part** | neutral standard — JSON-RPC, `session/update` stream | internal zod protocol package over WebSocket |
| Tool lifecycle | implicit, 2 states (`tool_use` → `tool_result`) | `inProgress/completed/failed/declined` | `pending/running/completed/error` | `pending/in_progress/completed/failed` + semantic `kind` | `executing/running/completed/failed/canceled` |
| Plan/todo | convention (TodoWrite tool input) | first-class `todoList`/`plan` items | `todowrite` tool | first-class `plan` update | first-class plan cards |
| Adoption | Claude Code only | Codex surfaces + partners | OpenCode only | Gemini CLI native, JetBrains, ~50 agents in registry (Claude Code & Codex via adapters) | paseo only |

Key observation: all of these converged independently on the same shape — *an item/part with an explicit lifecycle as the atomic UI unit, a small tool-status enum, full-replacement plan checklists, and blocking permission asks*. **ACP is the vendor-neutral articulation of that shape and the closest thing to an emerging industry standard** (Zed's `claude-code-acp` adapter proves stream-json maps onto it cleanly). paseo is not a standard, but its *architecture* — one shared protocol layer that also computes the tool-call display model — is adopted by this spec.

## 2. Why not adopt ACP wholesale?

ACP models *one editor driving one agent session*. cezar is an orchestrator: it needs runs, workflow steps and check steps, variants, worktree/branch context, queue positions, token/cost accounting, and NDJSON persistence/replay — none of which ACP covers (usage/cost is not even in ACP core). The spec therefore uses **ACP vocabulary wherever the choice is arbitrary** (tool status, `ToolKind`, plan entry shape, diff shape, stop reasons, permission options) and adds the orchestrator layer on top.

## 3. Where does translation happen?

In the runners — the same seam as today:

```
claude CLI ── stream-json NDJSON ──▶ claude-cli-runner ──┐
codex ────── app-server JSON-RPC ──▶ codex-runner ───────┼──▶ UiEvent v2 ──▶ RunManager ──▶ NDJSON + SSE ──▶ UI
opencode ─── HTTP + SSE parts ─────▶ opencode-runner ────┘        (adds stepId/seq/ts, persists, fans out)
```

- The UI consumes **only** v2 — this is what makes the backend-parity rule enforceable, and the per-runner mapping is what the golden-fixture tests pin down (recorded vendor transcripts in → exact v2 sequence out).
- Where a vendor lacks a signal (claude has no live command-output delta), the runner simply never emits it and the UI degrades per capability — never per backend.
- Engine-level events (worktree notes, `step-start`/`step-end`, check outputs, lifecycle) belong to the RunManager, above the runner seam — unchanged from today.
- Adding a backend = one new runner emitting v2. An `acp-runner` would be the thinnest of all (mostly field renames), which is the cheap path to Gemini CLI and every other ACP agent.

## 4. Which is the superset — v2 or ACP?

**v2 is a superset of ACP's update vocabulary** (not of the whole ACP RPC protocol):

- **Shared 1:1**: tool lifecycle/status (+ `declined`), `ToolKind` (+ `task`, `plan`), plan entries with full-replacement semantics, `{path, oldText, newText}` diffs, stop reasons, permission-request shape (reserved), streamed text/reasoning chunks.
- **v2 adds**: the run/workflow envelope (steps, checks, lifecycle, queue), variants and worktree context, usage/cost + context-window telemetry, persistence fields (`seq`/`ts`/`stepId`) for replay, image events with persisted URLs, title summaries / diff stats.
- **Not taken from ACP**: the JSON-RPC method surface (`initialize`, `session/new`, capability negotiation) and the fs/terminal extensions — cezar's runners already own process lifecycle per backend.

This containment keeps two future moves cheap: an ACP *backend* fills only the shared core; an ACP *server mode* (editors driving cezar) projects v2 down to the shared core.

## 5. Is the design performant? (SSE, streaming, replay)

**Transport — SSE is the right fit.** The stream is strictly server→client (client input rides normal POSTs). `EventSource` gives auto-reconnect for free; cezar's reconnect doctrine (full-list resync on the global stream, per-run replay with `seq` dedup, authoritative refetch) already assumes it. The HTTP/1.1 six-connections-per-origin limit — the classic SSE objection — does not bite: the cockpit holds exactly two streams (global + selected run). WebSocket would add bidirectionality cezar doesn't need (paseo needs it for voice PCM streaming).

**Event volume.** Agent events are human-paced (tool calls, step transitions, ~2 s usage ticks) — trivial. The one new pressure point is `item.delta` (token-level text/reasoning/command-output streaming), which can reach 50–100 raw events/s. Guardrails, stated in the spec:

1. **Coalesce deltas in the RunManager**: flush per item at ~30–50 ms boundaries to the SSE wire.
2. **Persist snapshots, not deltas**: NDJSON gets `item.started`/`item.updated`/`item.completed` snapshots (plus the v1-style aggregated text), keeping the sync append-only write rate at today's frequency and files replayable without delta reduction.

**Replay size.** The per-run stream replays the full transcript on connect. On localhost this is negligible; in hosted mode a 10k-event session is a few MB, once, gzip-friendly. The renderer is indifferent (virtua windows the DOM regardless of payload). If hosted mode makes it matter, paged catch-up (fetch authoritative history in pages, stream live on top — paseo's timeline-sync doctrine) is the documented follow-up; it changes no event shapes.

**Render path** (where streaming UIs actually lose their 60fps): block-memoized streaming markdown (only the growing tail block re-renders), Shiki fine-grained core + JS regex engine off the critical path with plaintext-first paint at final line height (no reflow jumps when highlight lands), virtualized thread with bottom-anchor + user-scroll detection, deferred mounting of collapsed tool-card bodies (newest first), `content-visibility: auto` before virtualization kicks in. Details and package choices: `diff-highlight-tech.md`.

**Server cost.** Hono + Node handles this shape trivially: a handful of concurrent runs × two SSE streams × coalesced events. Process-usage sampling stays at ~2 s ticks and is never persisted. No new server infrastructure is required by the redesign.
