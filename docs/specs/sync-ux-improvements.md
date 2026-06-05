# Spec — Sync UX Improvements

Status: **Draft / proposal**
Owner: TBD
Related: unified sync (PR #255, migrations `0029_sync_status` → `0038_workspace_sync_settings`)

## Context

The unified sync (`/api/cron/sync` → deduped `sync` job → dispatch worker →
`lib/sync/run-workspace-sync.ts`) reconciles issues + PRs + digests + comments
into Supabase and reports progress through the per-workspace `sync_status` row
(`packages/gui/supabase/migrations/0029_sync_status.sql`). A global header dot
(`components/sync-indicator.tsx`) reflects that row over Realtime and offers a
"sync now" trigger; the Automation settings tab exposes auto/manual mode +
interval.

The **GitHub App webhook** (`app/api/github/webhook/route.ts`) is the real-time
path — `issues` / `pull_request` deliveries upsert immediately; the cron sync is
the **reconcile + missed-delivery backstop**. Most remaining friction is that
this distinction, and the freshness/health of the data, is invisible to users.

This doc specs five improvements. They are independent and can ship in any
order; a suggested sequencing is in [Rollout](#rollout).

---

## North-star principle

> **Cezar is live, and quietly self-heals.** The UI should always answer three
> questions at a glance: *Is my data fresh? How is it kept fresh (live vs.
> polling)? If something's wrong, what do I do?*

---

## 1. Webhook health — "⚡ Live" vs "⏱ Polling"

### Problem
A workspace with a healthy webhook updates in seconds; one whose App was
uninstalled or whose `GITHUB_APP_WEBHOOK_SECRET` is unset silently falls back to
the cron interval. Today both look identical, and the interval setting *looks*
authoritative when for live repos it's nearly irrelevant.

### Current facts
- `app/api/github/webhook/route.ts` returns **503** when `GITHUB_APP_WEBHOOK_SECRET`
  is unset (global, all workspaces), and records delivery ids into
  `webhook_deliveries (delivery_id pk, received_at)` for dedup only — there is
  **no per-workspace "last delivery" signal**.
- `workspaces.installation_id` (bigint, migration 0029) is set/cleared by the
  `installation` / `installation_repositories` events in `handleInstallation()`.
  Non-null ⇒ the App is installed on that repo.

### Proposed behavior
Derive a per-workspace **webhook health** from three inputs:
1. **Receiver active** — `GITHUB_APP_WEBHOOK_SECRET` is set (server-side boolean).
2. **App installed** — `workspaces.installation_id is not null`.
3. **Recently delivering** — `workspaces.last_webhook_received_at` within a
   freshness window (e.g. 24h; configurable).

Health states:
| State | Condition | Indicator copy |
|---|---|---|
| **Live** | receiver active + installed + recent delivery | "⚡ Live — updates arrive in real time" |
| **Installed, quiet** | installed, no recent delivery | "⚡ Live (no recent activity)" — treat as Live; low-traffic repos are normal |
| **Polling** | receiver inactive OR not installed | "⏱ Polling every {interval} — install the GitHub App for real-time updates" |

When **Polling**, the interval setting is presented as primary; when **Live**,
it's de-emphasized ("reconcile cadence — a safety net").

### Data model
Migration `00XX_workspace_webhook_signal.sql`:
```sql
alter table workspaces
  add column last_webhook_received_at timestamptz,
  add column last_webhook_event       text;
```
(Per-workspace timestamp avoids scanning `webhook_deliveries`, which is global +
GC'd at 48h.)

### Backend
- `app/api/github/webhook/route.ts`: in `resolveWorkspaces()` (after a delivery
  is matched to workspace rows), best-effort `update workspaces set
  last_webhook_received_at = now(), last_webhook_event = <event>` for each
  matched workspace. Cheap; one indexed update per delivery.
- Expose receiver-active to the client: add a small server helper
  `getWebhookConfigured(): boolean` = `!!process.env.GITHUB_APP_WEBHOOK_SECRET`,
  read in `layout.tsx`.

### UI
- `layout.tsx`: fetch `installation_id`, `last_webhook_received_at` alongside the
  existing `sync_mode` query; compute a `webhookHealth: 'live' | 'polling'` and
  pass to `TopBar` → `SyncIndicator`.
- `sync-indicator.tsx`: add a tooltip line for health; optionally a tiny ⚡/⏱
  glyph next to the dot. "Polling" copy links to settings / App install.

### Edge cases
- Self-hosted single-tenant (no GitHub App, `GITHUB_TOKEN` only): always
  "Polling" — correct and honest.
- App installed but secret unset: receiver returns 503, so deliveries never
  land → "Polling" even though installed. Correct.

### Effort
S–M (1 migration, ~1 receiver update, indicator/layout wiring).

---

## 2. First-sync progress — a determinate "Importing" experience

### Problem
The initial connect runs an **all-states backfill** + digests of potentially
hundreds of issues — the one genuinely slow moment. Today it shows an
indeterminate "Syncing issues…" with no sense of scale or progress.

### Current facts
- First sync is identifiable: `store.getMeta().fullSyncedAt == null`
  (`run-workspace-sync.ts` phase 1).
- `SyncCounts` has no totals; the digest call
  `LLMService.generateDigests(issues, batchSize, onProgress?)` already accepts an
  `onProgress(completed, total)` callback that is **currently unused**.
- `sync_status` already streams over Realtime; the indicator subscribes.

### Proposed behavior
- Mark the first sync distinctly: a determinate progress bar + "Importing your
  repo — {n}/{total} issues digested".
- Subsequent syncs stay subtle (the existing dot), since they're fast.

### Data model
Extend `SyncCounts` (type-only; `counts` is `jsonb`, no migration needed):
```ts
export interface SyncCounts {
  issuesFetched?: number; issuesCreated?: number; issuesUpdated?: number;
  digestsCreated?: number; digestsTotal?: number;   // NEW
  commentsFetched?: number; prsUpdated?: number;
}
```
Add a boolean to `sync_status` to flag the initial import (optional — can also be
derived from `fullSyncedAt`, but storing it avoids a second read in the client):
```sql
alter table sync_status add column initial boolean not null default false;
```

### Backend (`run-workspace-sync.ts`)
- Phase 1: capture whether this is the first sync (`fullSync` already computed);
  write `initial: fullSync` to `sync_status` on the first status write.
- Phase 2 (digests): set `digestsTotal` and wire the existing `onProgress`
  callback to `writeSyncStatus` (throttled, e.g. every batch) so
  `digestsCreated` advances live. Phase message: "Digesting {completed}/{total}…".

### UI (`sync-indicator.tsx`)
- When `status.initial && status.status === 'syncing'`: render a small
  determinate bar (width = `digestsCreated/digestsTotal`, fallback to
  `issuesCreated/issuesFetched` during phase 1) plus the count text — either in
  the tooltip or a compact inline pill next to the dot.
- Consider a one-time, dismissible "Setting up {repo}…" banner on first import so
  new users understand the wait.

### Edge cases
- Throttle progress writes (per batch, not per issue) to avoid Realtime spam.
- Backfill of historical *closed* issues is intentionally **not** digested
  (digests scope to open + `hasDigest:false`); base the bar on what will
  actually be digested, not raw `issuesFetched`.

### Effort
S–M (type + optional column, progress wiring already half-present via `onProgress`).

---

## 3. Stale & actionable states — distinct "stale" and "fix this"

### Problem
Idle-healthy and idle-stale both render grey; errors are red but show a raw
message with no recovery path. The most common real failure — an expired/revoked
token or uninstalled App — should tell the user exactly what to do.

### Current facts
- `github.service.ts#handleError` normalizes **401** (invalid token), **403**
  (rate limit / forbidden), **404** (repo not found).
- `github-app.service.ts#getInstallationToken` throws "GitHub App is not
  installed on …" when the install is gone.
- OAuth tokens (`user_github_tokens`) have **no refresh logic** — revocation
  surfaces as a 401 on the next call.
- The indicator already has interval available *in settings* but **not** passed
  to the component; "fresh" = synced < 5 min ago, else grey.

### Proposed behavior
**Staleness (amber):** when the last *successful* sync is older than
`max(2 × sync_interval_minutes, 30 min)` (and not currently syncing), show an
**amber** dot + "Data may be stale — last synced {rel}".

**Actionable errors:** classify the failure and show a CTA:
| `error_kind` | Cause | Indicator copy + CTA |
|---|---|---|
| `auth` | 401 / App uninstalled | "GitHub access expired — **Reconnect**" → OAuth re-auth / App install |
| `rate_limit` | 403 rate limit | "GitHub rate limit — will retry automatically" (transient, no CTA) |
| `not_found` | 404 repo | "Repo not accessible — check the GitHub App's repo access" |
| `unknown` | other | raw message (today's behavior) |

### Data model
```sql
alter table sync_status
  add column error_kind text
    check (error_kind in ('auth','rate_limit','not_found','unknown'));
```

### Backend
- `lib/execute-sync-job.ts` + `run-workspace-sync.ts` error paths: classify the
  caught error (string-match the normalized messages from `handleError` /
  `getInstallationToken`, or thread a typed error) and write `error_kind`
  alongside `status:'error'`.
- Pass `sync_interval_minutes` to the indicator (already loaded in `layout.tsx`'s
  workspaces query — add the column) for the staleness threshold.

### UI (`sync-indicator.tsx`)
- Add an **amber** dot state (`bg-tertiary` or a warning token) for stale.
- Error tooltip renders the mapped copy; for `auth`, render a real link/button
  (Reconnect → existing OAuth flow; Install → GitHub App install URL).
- Distinguish transient (`rate_limit`) visually from permanent (`auth`) — e.g.
  amber vs red.

### Edge cases
- Don't show "stale" while a sync is in progress or queued.
- Manual-mode workspaces are *expected* to be stale; suppress the amber warning
  there (manual already has its own tooltip line) or soften the copy.

### Effort
M (1 column, error classification, indicator states + CTA wiring).

---

## 4. "What changed" — deltas, not cumulative totals

### Problem
The tooltip shows cumulative totals ("346 issues · 65 PRs"), which never conveys
that *this* sync did anything. Trust comes from deltas.

### Current facts
- `issuesCreated` / `issuesUpdated` are already true per-run deltas
  (`run-workspace-sync.ts` phase 1, derived from upsert action).
- `prsUpdated` is the **count fetched** (500-cap window), **not** a delta — PR
  created/closed/merged deltas are not computed.
- The indicator already calls `router.refresh()` on `done`; no toast today.

### Proposed behavior
On sync completion, surface a brief, dismissible **toast**: e.g.
"Synced — 3 new issues · 1 reopened · 2 PRs merged · 1 PR opened". Falls back to
"No changes" (or stays silent) when all deltas are zero.

### Data model
Extend `SyncCounts` with PR deltas (type-only, `jsonb`):
```ts
prsCreated?: number; prsClosed?: number; prsMerged?: number; prsReopened?: number;
issuesClosed?: number; issuesReopened?: number;   // optional finer issue deltas
```

### Backend (`run-workspace-sync.ts`)
- Phase 4: the `pull_requests` upsert currently overwrites blindly. To compute
  deltas, fetch the existing `(number, state, draft)` for the affected PRs first
  (one indexed select), diff against incoming, and tally
  created/closed/merged/reopened. (Merged ⇒ incoming `state==='closed'` with a
  merge signal; if merge isn't tracked, treat closed transitions as "closed".)
- Phase 1: optionally split `issuesUpdated` into closed/reopened using prior
  state, same diff approach.

### UI
- `sync-indicator.tsx`: on the syncing→`done` transition, build a delta string
  from `counts` and fire a toast (reuse any existing toast system; else a small
  transient popover anchored to the dot). Keep `router.refresh()`.
- Suppress toast when all deltas are 0 to avoid noise on routine no-op syncs.

### Edge cases
- The PR diff select adds one query per sync — bounded by the 500-cap window;
  acceptable. Skip it entirely on the initial import (everything is "new" — a
  toast of "340 new" is noise; the first-sync experience in §2 covers that).
- Don't toast for cron-driven background syncs the user didn't initiate? →
  Decision: toast only when the **user clicked "sync now"** (the component knows
  via its `pending`/`wasSyncing` state), so background reconciles stay silent.

### Effort
M (PR delta computation + toast).

---

## 5. Decouple metadata sync from AI digests (cost + cadence control)

### Problem
Issue/PR metadata is cheap to pull; **digests are LLM spend**. Bundling them
means "sync more often" silently means "spend more often", and the interval
setting is implicitly a billing dial. `generateDigests` surfaces **no token/cost
data** today, so spend is invisible.

### Current facts
- Phases 1/3/4 (issues, comments, PRs) are cheap API I/O; phase 2 (digests) is
  the only LLM cost, scoped to open + un-digested issues.
- No usage/cost is returned by `LLMService.generateDigests`.

### Proposed behavior
Treat **data sync** and **digest generation** as two cadences:
- **Data sync** (issues + PRs + comments): the fast reconcile cadence
  (`sync_interval_minutes`), unchanged.
- **Digests**: a separate control — `auto` on a slower cadence
  (`digest_interval_minutes`, default e.g. 60), `on-demand` only, or `off`.

This makes the frequent cadence cheap and gives cost-conscious workspaces an
explicit lever, without losing always-fresh metadata.

### Data model
```sql
alter table workspaces
  add column digest_mode text not null default 'auto'
    check (digest_mode in ('auto','manual','off')),
  add column digest_interval_minutes integer not null default 60
    check (digest_interval_minutes >= 15);
```

### Backend
- `run-workspace-sync.ts`: gate phase 2 on `digest_mode` + a digest-cadence
  check. Two options:
  - **(a)** Keep one job; inside `runSyncPhases`, skip digests unless
    `digest_mode==='auto'` and the last digest run is older than
    `digest_interval_minutes` (track `last_digested_at` in `sync_status` or
    workspaces).
  - **(b)** Split into a separate `digest` job kind enqueued on its own cadence
    by the sweep. Cleaner separation, more moving parts. **Recommend (a)** first.
- "Generate digests now" action for `manual`/`on-demand` mode (admin-only),
  reachable from settings and/or the inbox.
- **Cost visibility (stretch):** have `generateDigests` return token usage
  (`@anthropic-ai/sdk` responses include `usage`); thread it into `counts`
  (`digestTokens`) and show an estimate ("~{n}k tokens this run") — the start of
  real spend transparency.

### UI (`settings/automation-section.tsx`)
- Add a "AI digests" sub-block under the sync controls: a mode select
  (Auto / On-demand / Off) and, for Auto, a digest-frequency select. Mirror the
  existing toggle+select pattern.
- Copy clarifies the cost tradeoff: "Digests are AI-generated summaries (uses
  your Anthropic key). Metadata sync stays on your sync schedule regardless."

### Edge cases
- `digest_mode='off'`: inbox shows raw issue titles/bodies without summaries —
  ensure the UI degrades gracefully (it already tolerates missing digests).
- Initial import: still digest once on first sync regardless of cadence (so a new
  workspace isn't empty), then follow `digest_mode`.

### Effort
M–L (2 columns, phase gating, on-demand action, settings UI; cost surfacing is a
stretch add-on).

---

## Cross-cutting notes

- **No new heavy infra**: every item reuses `sync_status` + Realtime + the
  indicator + the Automation settings pattern. New columns are small and
  additive.
- **Indicator is getting busy.** After §1–§4 the dot encodes: syncing / fresh /
  stale / error(auth|rate|other) / live-vs-polling / manual. Consider promoting
  it from a bare dot to a small status chip ("⚡ Synced 4m ago") on wide screens
  for discoverability, collapsing to the dot on narrow ones.
- **Settings self-containment**: add "Sync now" + "Last synced …" to the
  Automation tab (cheap, complements §1/§5).

## Migrations summary (if all five ship)
| # | Migration | For |
|---|---|---|
| 1 | `workspaces.last_webhook_received_at`, `last_webhook_event` | §1 |
| 2 | `sync_status.initial` (optional) | §2 |
| 3 | `sync_status.error_kind` | §3 |
| 4 | — (SyncCounts type-only) | §2, §4 |
| 5 | `workspaces.digest_mode`, `digest_interval_minutes` | §5 |

(§3 also needs `sync_interval_minutes` passed to the indicator — already a
column, just plumb it through `layout.tsx` → `TopBar` → `SyncIndicator`.)

## Rollout

Suggested order by trust-per-effort:

1. **§1 Webhook health** — reframes the feature; highest trust-per-effort.
2. **§3 Stale & actionable states** — covers the "is it fresh / why broken"
   moments; pairs naturally with §1.
3. **§2 First-sync progress** — fixes the scariest single moment (onboarding).
4. **§4 What changed** — ongoing trust/delight once the basics are solid.
5. **§5 Digest decoupling** — the cost lever; larger, do once usage is real.

Each is independently shippable behind the existing `sync_status` plumbing.
