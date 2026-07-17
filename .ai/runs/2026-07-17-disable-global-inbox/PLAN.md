# Execution plan — disable the global follow-up inbox by default (#471)

**Issue:** #471 — bug: disable global task list, and autosaves
**Branch:** `fix/disable-global-inbox`
**Base:** `main`
**Run folder:** `.ai/runs/2026-07-17-disable-global-inbox/`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Add the `followups` capability behind `CEZ_FOLLOWUPS` (opt-in) | done | 5448d70 |
| 1 | 1.2 | Force follow-up generation off and gate the inbox endpoints when the capability is off | done | a169dce |
| 1 | 1.3 | Enforce the ceiling in RunManager so the `cezar run` CLI is gated too | done | e4fad38 |
| 2 | 2.1 | Gate the Inbox nav item, badge and route on the capability | done | bf819b9 |
| 2 | 2.2 | Hide the composer's follow-up toggle when the capability is off | done | 0a41323 |
| 3 | 3.1 | Document the flag (.env.example, README, BACKWARD_COMPATIBILITY, spec 007) | done | 328dbb7 |

> **Review fixes (appended after `om-code-review`).** `4.1-review-fix` — merge `main` (six PRs
> landed mid-run; `app-shell.tsx` conflicted and cezar's autosaver committed it mid-resolution,
> markers and all). `4.2-review-fix` — normalize the record in `recover()`, stop the `/inbox`
> "Inbox empty" flash, correct the live-flip claim in `capabilities.ts`.

## Goal

Make the global follow-up inbox (the "global task list") **off by default**, re-enabled
with a single global env var `CEZ_FOLLOWUPS=1`. Per-task handoff and notes are untouched.

## Scope

Issue #471 says the global task list and its autosaves are a legacy of `GitHub janitor`,
make skill performance unpredictable, and should be *"re-enabled with default off global env"*,
while *"keeping the notes and handoffs per task as it's right now"*.

PR #444 (`feat/generate-followups-toggle`) already landed the mechanism: a per-run
`generateFollowups` flag, the `HANDOFF_ONLY_INSTRUCTIONS` / `FOLLOWUP_INSTRUCTIONS` split in
`src/handoff.ts`, and `CEZ_TODOS_FILE` shadowing in `RunManager.agentEnv`. That flag currently
**defaults to enabled** (`generateFollowups !== false`). This run flips the default to off and
lifts the switch from per-run to global.

In scope:
- `src/server/capabilities.ts` — new `followups` capability, `CEZ_FOLLOWUPS === '1'` (opt-in).
- `src/server/server.ts` — force `generateFollowups: false`, gate `startTodosWatch`, the three
  `/api/todos` endpoints and the `todos` SSE event.
- `web/app/src/**` — hide the Inbox nav item/badge/route and the composer toggle.
- Docs: `.env.example`, `README.md`, `BACKWARD_COMPATIBILITY.md`, `.ai/specs/007-handoff-file-todos.md`.

## Non-goals

- **The `cezar autosave` git commits** (`src/git-worktree.ts:105` `autosaveCommit`) stay exactly
  as they are. "autosave" in this repo means those commits, and they are the recovery point for a
  crashed run. Issue #471's body only complains about *"pre-saved or stalled handoffs"*, so
  removing crash recovery is out of scope. Raised with the user; not confirmed either way.
- **Per-task handoff and notes** — `src/handoff.ts:13-128` (`seedHandoffFile`,
  `appendHandoffHeartbeat`, `readHandoff`, `handoffProgressExcerpt`, `deleteHandoff`,
  `HANDOFF_ONLY_INSTRUCTIONS`) — explicitly kept per the issue.
- **The `CEZ:DONE` marker** — core engine contract, unaffected.
- **Deleting `src/todos.ts`, the endpoints or the Inbox route** — they stay and work when
  `CEZ_FOLLOWUPS=1`. This is a gate, not a removal.

## Risks

- **Backward-compatibility break (accepted, documented).** `BACKWARD_COMPATIBILITY.md` freezes the
  `/api/todos` endpoints (line 28) and `todos.json` (line 44), and requires a deprecation alias for
  env/default changes (line 13). Turning the inbox off by default breaks that contract as written.
  Issue #471 is an explicit instruction from the repo owner to do it, so the BC doc is updated in
  the same PR (Step 3.1) rather than the break being left silent. Flagged in the PR summary.
- `GET /api/todos` keeps returning `200 []` when off (rather than 404) so old clients degrade to an
  empty inbox instead of an error. The mutating endpoints 409 — the defense-in-depth precedent set
  by the `localHandoff` open-in-* handlers (`src/server/server.ts:701`).
- Existing `todos.json` entries are never deleted — flipping the env back on restores the inbox.

## External References

None — no `--skill-url` passed.

## Implementation Plan

### Phase 1 — server

**Step 1.1 — Add the `followups` capability behind `CEZ_FOLLOWUPS` (opt-in)**
Extend `Capabilities` in `src/server/capabilities.ts` with `followups: boolean`, resolved as
`env.CEZ_FOLLOWUPS === '1'`. Matches the house rule in `AGENTS.md:14` ("opt-in behind a `CEZ_*`
flag, off by default") and the injectable-env shape of `resolveCapabilities`. Unit tests.

**Step 1.3 — Enforce the ceiling in `RunManager` (added mid-run)**
Not in the original plan. A route-level gate leaves `src/index.ts:252` (`cezar run "<task>"`), the
inbox's own "▶ Run" and variants calling `manager.startRun` directly with no `generateFollowups`,
which `!== false` reads as enabled — so a headless run would still be told to write `todos.json`
with the flag off. `followupsEnabled()` moves to `src/handoff.ts` (neutral to both server and
workflows, and the feature's own module) as the single source of truth; `resolveCapabilities`
reports it, `RunManager` enforces it on start, on continue, and at each step. End-to-end tests
through the real engine cover it.

**Step 1.2 — Force follow-up generation off and gate the inbox endpoints**
In `src/server/server.ts`: force `generateFollowups: false` at run creation when the capability is
off (so the run record, the system prompt and `CEZ_TODOS_FILE` all follow from one decision);
skip `startTodosWatch`; `GET /api/todos` → `[]`; `DELETE /api/todos/:id` and
`POST /api/todos/:id/start` → 409; suppress the `todos` SSE event. Tests.

### Phase 2 — web

**Step 2.1 — Gate the Inbox nav item, badge and route on the capability**
Add `followups` to the web `Capabilities` type; mark the Inbox `NavItem` with an `inbox` flag and
extend `visibleNavItems(forgeAvailable, inboxAvailable)` — the exact precedent already used for the
forge-gated GitHub item. Sidebar, mobile drawer and ⌘K palette all render through it, so they cannot
disagree. Badge count only when on. Tests.

**Step 2.2 — Hide the composer's follow-up toggle when the capability is off**
`web/app/src/routes/new-task.tsx:145` currently defaults the toggle on
(`?? uiState.lastGenerateFollowups ?? true`). Hide the control and pin the effective value to
`false` when the capability is off; the server forces it anyway (Step 1.2), so this only keeps the
UI honest. Tests.

### Phase 3 — docs

**Step 3.1 — Document the flag**
`.env.example` (new `# ---- follow-up inbox ----` section), `README.md:95,264,403` (Inbox is
opt-in), `BACKWARD_COMPATIBILITY.md` (record the deliberate break + the new env var),
`.ai/specs/007-handoff-file-todos.md` (the defining spec).
