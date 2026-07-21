# Grouped sub-agent display within a single session

> FR: #474 · Slug: `grouped-subagent-display`

## TLDR

When an agent fans work out to sub-agents (claude `Task`/`Agent` tool, opencode
`subtask`, codex review mode), the cockpit today shows them only as streamed tool
cards inside the thread — correct, but easy to lose in the scroll, with no single
place that answers *"how many agents are running right now, and what is each one
doing?"*. claude-cli and codex-cli both ship a grouped live sub-agent display with
drill-down; this spec adds the cockpit equivalent: an **Agents dock** (a sibling of
the existing plan dock, pinned above the composer) that groups the current turn's
sub-agents with live status and a one-line activity readout, plus a **drill-down
sheet** showing any sub-agent's full nested transcript. The feature is almost
entirely **cockpit UI over data already on the wire**: claude and opencode mappers
already normalize sub-agent work to `toolKind: 'task'` items with children linked
via `parentItemId`, so those two backends light up with zero server change. Codex
carries no wire parent attribution today (`AGENT_PROTOCOL.md` §mapping) — its
review mode currently maps to two disjoint task items — so this spec includes one
small codex-mapper fix (fold review mode into a single task item with a lifecycle)
and is otherwise forward-compatible: any future codex sub-agent events plug in at
the mapper with no UI change.

## Resolved assumptions (autonomous defaults)

This spec was produced by an autonomous run (`om-auto-write-spec`); the Open
Questions below were answered with conservative defaults. Override any of them by
editing this section and re-running, or by correcting the implementation PR.

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Where should the grouped display live — dock above the composer, run-header pill, or sidebar? | **Dock above the composer**, a sibling of the plan dock, modeled on `PlanDock` | Established pattern (`plan-dock.tsx`, mockup `.plan-dock`); zero new navigation; the plan dock already proved the "pinned live status" surface |
| Q2 | Drill-down surface — side sheet, inline expansion only, or a separate route? | **shadcn `Sheet` side panel** reusing the existing thread renderers, filtered by `parentItemId` | The component exists (`components/ui/sheet.tsx`); no new route/state model; inline nesting already exists and stays |
| Q3 | What counts as a "sub-agent" per backend? | Any **parent-less** `toolKind: 'task'` item — claude `Task`/`Agent`, opencode `subtask`, codex review mode (after the one-item mapper fix below). No backend-specific UI code. | The protocol seam (`AGENT_PROTOCOL.md`) is the parity mechanism; future codex sub-agent events plug in at the mapper, and the UI needs no change |
| Q4 | Should the inline nested thread rendering change (e.g. hide children once the dock exists)? | **No** — the dock and sheet are additive; the thread keeps today's nesting | Least surprise, zero regression risk; the thread remains the permanent record |
| Q5 | Any new persistence, API, or protocol surface? | **None** — everything derives from already-persisted `UiEvent`s in the web reducer state; the only server-side touch is the codex-mapper review-mode fold, which changes no schema | Zero-config principle; no BC surface touched; rollback is a pure revert |
| Q6 | When is the dock visible? | Anchored to the **most recent turn containing parent-less task items**; shown while that turn is the latest **or** any of its task items is still unsettled; hidden once all are settled and a newer turn exists | Survives mid-run steering (a user message opens a new turn while sub-agents still run — the dock must not vanish then); still pure and testable; yields to the transcript once the fan-out is history |
| Q7 | One spec or split (dock vs drill-down)? | **One spec**, one capability ("see grouped sub-agents and inspect one"), phased so the dock ships alone first | Drill-down without the dock has no entry point; the dock alone is independently shippable (Phase 1) |

## Problem Statement

A cockpit run that fans out (e.g. four parallel review agents) currently renders
each sub-agent as one `Task:` tool card in the thread, with its child items nested
one level under the card (`groupThreadItems` Pass 1, `thread-groups.ts:103-121`;
`NestedEntry`, `thread-items.tsx:372-400`). That is a faithful record, but a poor
*live* surface:

- The cards sit at their stream position, so with any follow-up output they scroll
  out of view while the sub-agents are still working — there is no persistent
  answer to "what is running right now".
- Nothing aggregates: no count, no per-agent status roll-up, no "2 of 4 done".
- Inspecting one sub-agent means finding its card in the scroll and expanding it
  inline, interleaved with everything else — there is no focused view of a single
  sub-agent's work.

Both claude-cli and codex-cli treat this as a first-class display: a grouped list
of running sub-agents with live one-line activity, and a way to enter one agent's
transcript. Issue #474 asks for the cockpit equivalent, working across all three
backends.

**What already exists (and is reused, not rebuilt):**

- claude and opencode mappers emit sub-agent spawns as `UiToolItem`s with
  `toolKind: 'task'` and link child items via `parentItemId`: claude maps
  `parent_tool_use_id` (`claude-ui-mapper.ts:143-160`), opencode maps `subtask`
  parts and foreign-session parts (`opencode-ui-mapper.ts:204-243, :480`). Golden
  fixtures prove the shape (`__fixtures__/claude/subagent-task.ndjson`,
  `__fixtures__/opencode/subtask-nested.ndjson`). Codex is the outlier: it has no
  wire parent attribution, and its review mode currently maps to **two disjoint
  childless task items** (`enteredReviewMode`/`exitedReviewMode`,
  `codex-ui-mapper.ts:384-395`) — displayed naively that would read as two bogus
  "agents", so this spec folds them into one (below).
- The thread reducer (`thread-state.ts`) already folds these into `ThreadTurn[]`
  with live `item.delta` streaming; the grouping pass already computes the
  parent→children relation.
- The plan dock (`plan-dock.tsx`) is the exact pattern for a pinned, collapsible,
  live status surface above the composer.

**What is missing** is almost purely presentational: a grouped collector, a dock,
and a focused drill-down — plus the one codex-mapper normalization fix. No new
protocol vocabulary is needed from any backend.

## Proposed Solution

Two additive cockpit pieces, both derived from existing reducer state:

1. **Agents dock** — a `PlanDock`-style collapsible section pinned above the
   composer, shown while a fan-out is current per the Q6 visibility rule.
   Collapsed: `Agents · 1/3 — Reviewing store layer…` (done/total odometer plus
   the first still-running agent's live activity). Expanded: one row per
   sub-agent — status glyph (reusing the plan dock's glyph language), agent title,
   optional `subagent_type` badge, live one-line activity, child tool-call count,
   and a chevron opening the drill-down.
2. **Sub-agent sheet** — a right-side `Sheet` showing one sub-agent's header
   (title, type badge, status, tool-call count) and its full child stream in order,
   rendered with the existing `NestedEntry`/`ToolCard` components. Because it reads
   the same reducer state the thread does, it live-updates for free and works
   identically for a finished run (SSE replay rebuilds the same state).

**Alternatives considered.** (a) *Server-side aggregation* (a `subagents.updated`
event): rejected — the client already holds every needed fact; a new event type
would widen the protocol and the NDJSON format for a pure display concern.
(b) *Restructuring the thread* (hoisting sub-agent cards into a sticky cluster):
rejected — it would rewrite the record surface and regress the existing
scroll/fold behavior; the dock is additive instead. (c) *A separate route per
sub-agent*: rejected — sub-agents have no stable identity outside their run; a
sheet over the run's own state is simpler and keeps deep-linking out of scope.

## Research

- **claude-cli** groups parallel `Task` invocations into a live block — per-agent
  spinner, name, one-line current activity, token/tool counts — and lets the user
  expand an agent to watch its transcript. The grouped block accompanies the
  fan-out; the transcript remains the record. This spec mirrors exactly that
  split (dock = live surface, thread = record).
- **codex-cli** similarly surfaces spawned/review agents as a grouped set with
  drill-down into each agent's output.
- The cockpit's own precedent is the **plan dock** (#382): plan-kind tool cards
  were removed from the thread and given a pinned live surface. The Agents dock
  deliberately reuses that pattern — but, unlike the plan, sub-agent cards **stay**
  in the thread (Q4): the plan snapshot is state, while sub-agent output is
  transcript, and hiding transcript would lose information.

What leaders carry that this spec skips: cross-run agent trees (Amp-style
multi-session graphs), per-agent token accounting, and pause/steer controls for
individual sub-agents. All are out of scope — cezar's protocol does not carry
per-sub-agent usage or control channels today, and this feature must not invent
protocol to get a display.

## Architecture

All new display code lives in the cockpit (`web/app/`); the store, server routes,
and protocol vocabulary are untouched. One existing mapper (`codex-ui-mapper.ts`)
gets a normalization fix.

### Codex-mapper fix (`src/core/codex-ui-mapper.ts`)

Today `enteredReviewMode` and `exitedReviewMode` each mint a **separate**
completed task item (`:384-395`). Fold them into one lifecycle:
`enteredReviewMode` starts a task item with status `running`;
`exitedReviewMode` completes **that same item** (falling back to today's
behavior when no entered-item is open). This is a pure normalization improvement
at the seam `AGENT_PROTOCOL.md` defines — no schema change, and the golden-fixture
expectation for codex review mode is updated in the same commit. Codex still
attributes no child output (no wire parent ids), so a codex "Review" row shows
zero tool calls and the drill-down shows the empty state below.

### Collector (pure, new file `web/app/src/routes/task-thread/subagent-dock.ts`)

```ts
export interface SubagentSummary {
  id: string;              // the task tool item's id
  title: string;           // splitToolTitle(item.title).detail ?? item.title
  agentType?: string;      // input.subagent_type / subagentType, when present
  status: ToolStatus;      // pending | running | completed | failed | declined
  toolCalls: number;       // children of kind 'tool'
  activity?: string;       // latest child's one-line readout (see below)
}

export function collectSubagents(turns: ThreadTurn[]): SubagentSummary[]
export function subagentCounts(agents: SubagentSummary[]): { done: number; total: number }
```

`collectSubagents` finds the **anchor turn** — the most recent turn containing
**parent-less** tool items with `toolKind === 'task'` (a task item that itself
carries a `parentItemId` is a sub-agent's own spawn and never becomes a dock
row) — and returns summaries in stream order, or `[]` when the visibility rule
(Q6) says hidden: the anchor produces rows only while it is the latest turn or
any of its task items is still unsettled (`pending`/`running`). Children are
gathered by `parentItemId` across the anchor turn **and every later turn** — a
steering message mid-fan-out opens a new reducer turn, and late child items must
still attach to their agent. Derived per agent:

- `activity`: the most recent child item's single line — a tool child contributes
  its `title` ("Ran npm test"), a message/reasoning child its last non-empty text
  line, truncated. Absent children ⇒ `undefined` (the row renders "starting…").
- `agentType`: from the task item's `input` — `subagent_type` / `subagentType`
  (claude) or `agent` (opencode); absent for codex.
- `status`/`toolCalls` directly from the task item and its children.

### Agents dock (new `web/app/src/routes/task-thread/agents-dock.tsx`)

Modeled line-for-line on `PlanDock`: module-level per-run collapse memory,
desktop-open/mobile-collapsed default, `data-slot="agents-dock"`, the `--grad`
hairline top edge, semantic tokens only (design-guardian). Rows reuse the plan
dock's glyph language — pulsing half-disc for `running`/`pending` (stroke/fill
`pending`, amber-as-activity-only rule), ✓ `text-success` for `completed`, a
`text-danger` ✕ for `failed`/`declined` — plus `BotIcon` in the head (the existing
`task` tool icon, `thread-items.tsx:127-139`). Each row is a button opening the
sheet. Placement: rendered by `task-thread.tsx` directly above the `PlanDock`
mount, keyed by run id.

### Drill-down sheet (new `web/app/src/routes/task-thread/subagent-sheet.tsx`)

A controlled `Sheet` (`components/ui/sheet.tsx`); open-state is one
`useState<string | undefined>` (the selected task item id) in the task-thread
route — no new persistence. Content: header (title, `agentType` badge, status
pill, tool-call count) and the child entries of the selected parent (gathered by
the collector's cross-turn relation), in stream order, rendered via the existing
`NestedEntry` renderer (currently module-private in `thread-items.tsx` — exported
as part of this work) inside a `ScrollArea` with the thread's follow-tail
behavior. **Empty state** (no attributed children — a codex review row, or a
claude agent before its first child event): a muted "No attributed output —
see the thread card for this agent's result." Closing resets the id; the sheet
stays open across status changes (an agent finishing while inspected simply
flips its status pill).

### Cross-backend behavior (the issue's ask 3)

The dock and sheet consume only the normalized vocabulary
(`toolKind === 'task'` + `parentItemId`):

| Backend | Spawn item | Children | Notes |
|---|---|---|---|
| claude | `Task`/`Agent` `tool_use` → `toolKind:'task'`, title `Task: {description}` (`tool-display.ts:137-144`); `input` carries `subagent_type` | every item with `parent_tool_use_id` | parallel fan-out common |
| opencode | `subtask` part → task item; `input.agent` names the agent | foreign-session parts scoped to the active subtask | completion = foreign `session.idle` (`opencode-ui-mapper.ts:540`) |
| codex | review mode → **one** task item after the mapper fix above | none — codex has no wire parent attribution (`AGENT_PROTOCOL.md` §mapping) | a "Review" row with 0 tools and the sheet's empty state; future codex sub-agent events plug in at the mapper only |

No backend name ever reaches the new components — backend parity is inherited
from the protocol seam, per `AGENT_PROTOCOL.md`'s backend-parity requirement.
The honest cross-backend statement: **grouping + drill-down for claude and
opencode; grouping with an attribution-less row for codex**, upgradeable entirely
inside `codex-ui-mapper.ts` when codex grows parent attribution.

### Testability hook (dry-run mock)

`scripts/mock-claude.mjs` gains a `mock:subagents` trigger (same pattern as
`mock:md`): the reply replays a canned parallel-Task stream-json sequence —
2–3 `Task` tool_uses, interleaved child items carrying `parent_tool_use_id`,
then the tool_results — derived from the `subagent-task.ndjson` fixture. This
makes the dock reachable in `CEZ_DRY_RUN=1` for unit-independent QA, the e2e
smoke, and screenshots.

## Data Model

None. No `RunRecord`/`StepState`/store change, no new event type, no new env var
(pure display ⇒ no `CEZ_*` flag, `.env.example` untouched). The only new types
are the client-side `SubagentSummary` above.

## API Contracts

None. The existing `GET /api/runs/:id/events` SSE replay+live stream already
delivers everything the feature reads.

## UI/UX

- **Dock, collapsed:** `Agents · 1/3 — Reviewing store layer…` — bold "Agents",
  muted tabular odometer, truncated activity of the first non-completed agent;
  chevron rotates like the plan dock's. Hidden entirely when the Q6 rule yields
  no anchor — zero cost for the overwhelming majority of runs.
- **Dock, expanded:** one row per agent: glyph · title (truncating) ·
  `agentType` badge (`Badge` variant outline, uppercase 10.5px — the plan dock's
  tag styling) · muted activity line · `N tools` count · row-level chevron-right.
  Row click opens the sheet (Phase 2; in Phase 1 rows are static display, no
  chevron-right yet). Rows keep stream order; no re-sorting on completion
  (stable rows, no jumping).
- **Sheet:** right side, `sm:max-w-xl`, full-width on mobile. Header + scrollable
  child stream; live tail follows unless the user scrolled up (same affordance as
  the thread). Esc/overlay closes.
- **Visual references:** `assets/grouped-subagent-display/mockup-01-agents-dock.png`
  (dock collapsed + expanded over a live thread) and
  `assets/grouped-subagent-display/mockup-02-subagent-sheet.png` (drill-down
  sheet). Sources: sibling `.html` files, self-contained statics.
- **Accessibility:** dock head and rows are real buttons with `aria-expanded` /
  `aria-haspopup="dialog"`; the sheet is a Radix dialog (focus trap, Esc, labeled
  by the agent title); pulse animations honor `motion-reduce`; status is never
  conveyed by color alone (glyph shapes differ).
- **Theming:** semantic tokens only (`bg-card`, `text-muted-foreground`,
  `text-success`, `text-danger`, `stroke-pending`); enforced by
  `design-guardian.test.ts`.

## Edge Cases & Failure Scenarios

- **Task item with no children yet** (spawn seen, first child not yet): row shows
  "starting…" with the running glyph. No crash on `children === undefined`.
- **Orphaned children** (`parentItemId` names an item outside the turn): ignored
  by the collector, exactly as `groupThreadItems` renders them top-level — the
  two stay consistent because both key on the same relation.
- **Parallel agents finishing out of order:** rows keep stream order; the
  odometer counts `completed`; `failed`/`declined` rows count toward the
  denominator but never the numerator, and keep the danger glyph visible.
- **Reload / finished run:** SSE replay rebuilds the same reducer state, so a
  historical run whose *last* turn was a fan-out shows the dock in its settled
  state; `item.delta` frames are live-only and never persisted
  (`ui-event-sink.ts:78`), so the activity line after reload falls back to the
  last persisted child snapshot — accepted, documented here.
- **Streak/context folding:** unaffected — task cards that adopted children are
  already exempt from context-grouping (`thread-groups.ts:146`), and the dock is
  independent of thread folding.
- **Agent completes while its sheet is open:** the sheet stays open; the status
  pill flips. Closing and reopening later shows the same settled content.
- **Mid-run steering:** a user message during a live fan-out opens a new reducer
  turn. The dock stays (Q6: its anchor's task items are still unsettled), and
  late child items landing in the new turn still attach via the collector's
  cross-turn child gathering. Once every agent settles and a newer turn exists,
  the dock yields to the transcript.
- **A settled fan-out followed by a new turn:** the dock disappears (Q6); the
  fan-out remains inspectable via its thread cards.
- **Overlapping opencode subtasks:** the mapper holds a single active-subtask
  slot (`opencode-ui-mapper.ts`), so a second subtask starting before the first's
  `session.idle` leaves the first `running` — the dock would show it stuck. This
  is a pre-existing mapper limitation the dock makes visible; noted as a known
  limitation here, with optional mapper hardening (settle the previous subtask
  when a new one starts) in Phase 3.
- **Backend emits no sub-agents ever** (typical codex/opencode runs): the dock
  never mounts; zero overhead beyond one selector call per reduce.
- **Malformed/adversarial input strings** (agent-controlled `description`,
  activity text): rendered as plain text (React escaping), truncated with CSS —
  never interpolated into markup or links.

## Risks & Impact Review

- **Blast radius:** three new files (collector, dock, sheet), one mount point in
  `task-thread.tsx`, one mock trigger, and the codex-mapper review-mode fold (one
  mapper + its fixture expectation). No protocol-schema, store, or route change;
  no BC surface from `BACKWARD_COMPATIBILITY.md` touched.
- **Performance:** `collectSubagents` is linear in the anchor-and-later turns'
  entries, called from the
  same memoized derivation that already runs `groupThreadItems`; no new
  subscriptions.
- **Behavioral regression risk:** none for runs without sub-agents (dock renders
  `null`); the thread rendering path is untouched.
- **Rollback:** revert the PR — no data or protocol residue.

## Phasing

- **Phase 1 — collector + Agents dock (+ mock trigger):** grouped live display
  ships alone; drill-down not yet available. Independently shippable and already
  answers "what is running right now".
- **Phase 2 — drill-down sheet:** row click opens the focused transcript.
- **Phase 3 — polish & docs:** design-mockup sync (`docs/mockups/thread.html`),
  e2e smoke over `mock:subagents`, spec/docs cross-references.

## Implementation Plan

### Phase 1 — Collector + Agents dock

1. **Collector.** Add `subagent-dock.ts` with `collectSubagents` /
   `subagentCounts` as specified (anchor turn, parent-less task items only,
   cross-turn child gathering, Q6 visibility).
   *Test:* unit — parent-less task items collected in stream order; nested task
   items excluded; children counted across later turns (steering scenario);
   activity derived from last child (tool title vs text line, truncation);
   `agentType` from `subagent_type`/`subagentType`/`agent`; no-children ⇒
   `activity: undefined`; orphaned `parentItemId` ignored; settled anchor + newer
   turn ⇒ `[]`; non-task turns ⇒ `[]`.
2. **Codex-mapper fold.** `enteredReviewMode` starts one running task item;
   `exitedReviewMode` completes it (fallback to today's shape when unpaired).
   *Test:* golden fixture — the codex review-mode expectation updates to one
   task item with a running→completed lifecycle; unpaired exit still maps.
3. **Mock trigger.** `mock:subagents` in `scripts/mock-claude.mjs` replaying a
   canned parallel-Task sequence (2 running → interleaved children → results).
   *Test:* existing mock harness — the trigger emits `Task` tool_uses and
   children with `parent_tool_use_id`; reducer state from the sequence yields 2
   `SubagentSummary` rows.
4. **AgentsDock component.** `agents-dock.tsx` modeled on `PlanDock` (collapse
   memory, glyphs, tokens, `data-slot`); mounted in `task-thread.tsx` above the
   plan dock, keyed by run id, fed from the reduced turns.
   *Test:* component — hidden with no task items; collapsed head shows odometer +
   first-running activity; expanded rows show glyph/title/badge/count; a
   completed fan-out shows `N/N`; `design-guardian` stays green.

### Phase 2 — Drill-down sheet

5. **SubagentSheet.** `subagent-sheet.tsx` (controlled `Sheet`, header + child
   stream via a newly-exported `NestedEntry`, follow-tail scroll, empty state);
   dock rows become
   `aria-haspopup` buttons setting the selected id.
   *Test:* component — row click opens the sheet with exactly that parent's
   children in order; the empty state shows for a childless agent; live append
   while open renders; Esc/overlay closes and
   resets; agent completing while open flips the status pill only.
6. **Finished-run parity.** Ensure the sheet renders from replayed state.
   *Test:* reduce a full fixture-derived event list (subagent-task fixture ⇒
   client shape), open each agent, assert content matches the expected children.

### Phase 3 — Polish & docs

7. **e2e smoke + mapper hardening + design mockup sync.** Add one `web/app/e2e` spec driving
   `mock:subagents` (dock appears → expand → open sheet → agent content visible);
   extend `docs/mockups/thread.html` with the dock per the shipped styling;
   optionally harden the opencode mapper for overlapping subtasks; link
   this spec from the component headers (house `spec §` comment style).
   *Test:* the e2e spec itself; full validation gate green.
