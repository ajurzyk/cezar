# Cezar Codebase Audit — 2026-06-02

Automated three-step audit of the Cezar monorepo. The codebase was divided into
13 review areas, each scanned by an independent subagent. Every finding was
filed as a GitHub issue on `open-mercato/cezar` with severity, file:line, a
concrete fix suggestion, and a code snippet.

**Total issues filed: 115** — issues `#20` through `#134` (inclusive).
All carry the title prefix `[audit]` so they can be filtered with
`gh issue list --search '[audit]'`.

---

## Headline numbers

| Dimension | Count |
|---|---|
| Issues filed | 115 |
| Areas reviewed | 13 |
| `bug` label | ~85 |
| `enhancement` label (perf / usability) | ~30 |
| Security-flavoured findings | ~15 |
| Areas with zero findings | 0 |

Severity skew (from agent self-assessment): roughly 12 high, 70 medium,
30 low. No `critical` findings — nothing in the "service-down today" tier —
but several patterns (token leakage, open redirect, missing webhook dedup,
unbounded server fetches, repo-clone race) would each become incidents
under load or attack.

---

## Per-area results

### Core packages

| Area | Issues | Range |
|---|---|---|
| `core/agents` (runners, factory) | 6 | #20–#22, #33, #42, #45 |
| `core/workflows` (engine, definitions) | 8 | #29, #32, #35, #40, #44, #46, #51, #54 |
| `core/actions/autofix` (legacy orchestrator) | 9 | #26, #31, #38, #41, #48, #50, #55–#57 |
| `core/actions-v2 + skills + labels` | 6 | #23–#25, #28, #34, #37 |
| `core/services + store + config + provision + utils` | 9 | #27, #30, #36, #39, #43, #47, #49, #52, #53 |

### CLI / Runner

| Area | Issues | Range |
|---|---|---|
| CLI | 7 | #63, #65, #67, #70, #71, #77, #79 |
| Runner daemon | 7 | #58, #59, #61, #62, #64, #66, #68 |

### GUI

| Area | Issues | Range |
|---|---|---|
| `gui/api` (cron, runner, webhook, simulate) | 10 | #60, #69, #72, #75, #76, #80, #82, #83, #93, #96 |
| `gui/lib` (job exec, scheduler, supabase, middleware) | 10 | #78, #81, #86, #88, #90, #94, #97–#100 |
| `gui/cockpit + workflows + settings` | 9 | #73, #74, #84, #85, #87, #89, #91, #92, #95 |
| `gui/actions + skills + inbox + workspaces` | 10 | #101–#109, #111 |
| `gui/issues + prs + dashboard + analytics + activity + auth + login + shell` | 10 | #119–#128 |
| `gui/components` | 6 | #129–#134 |

### Database

| Area | Issues | Range |
|---|---|---|
| Supabase migrations | 8 | #110, #112–#118 |

---

## Cross-cutting themes

A few patterns showed up in **multiple** review areas. These are the most
load-bearing items for a follow-up sweep:

### 1. TOCTOU / dedup races (5+ findings across 4 areas)
- `#72` webhook enqueue race vs partial unique index
- `#78` repo-clone race on shared working tree
- `#81` dispatch marks `running` before execution → zombie jobs
- `#90` `maybe-enqueue-autofix-from-triage` SELECT-then-INSERT race
- `#91` cockpit `enqueueWorkflowRun` no double-click dedupe
- `#112` `jobs` table has no UNIQUE dedup constraint
- `#121` `startAutofix` TOCTOU + no rate-limit

The root cause in most of these is "we dedup in application code instead of
in the database." A single migration adding partial unique indexes on
`jobs (workspace_id, kind, dedup_key) WHERE status IN ('queued','claimed','running')`
would fix several at once and turn the application-side checks into
"insert and catch unique-violation."

### 2. Workspace-scope check holes (3 findings)
- `#84` `enqueueWorkflowRun` lets the client pick the job kind, no allowlist
- `#85` `cancelLabelAnalysis` cancels unrelated rows in the workspace
- `#101` `switchWorkspace` has no auth or membership check
- Plus `#113` — DB-side RLS write policies don't cross-check parent ownership

These are exploitable from a logged-in user with devtools; high-priority.

### 3. Token / secret leakage (4 findings)
- `#58` GitHub token persisted in bare-clone remote config
- `#59` Token leaks in stderr when `git clone` fails
- `#62` Autosave `git add -A` commits secrets/artifacts written by agents
- `#64` No TLS check on `--url` for the runner
- `#87` Runner token persists in client state until reload
- `#100` `pg-listen` and `repo-clone` leak GitHub token via process list / git remotes

### 4. Unbounded loops / no timeouts (4 findings)
- `#26` No wall-clock timeout on autofix agent sessions
- `#31` Setup commands run with `shell:true` and no timeout
- `#82` Simulate routes have no rate-limit / no input cap
- `#96` Cron sync routes have no per-workspace timeout, no pagination cap

### 5. Unbounded fetches / page-render performance (5 findings)
- `#79` `listRunSummaries` reads run JSON files sequentially
- `#98` `load-workspace-config` runs 5+ supabase round-trips per job
- `#123` PR listing has no row limit on server
- `#124` Analytics fetches all issues + runs with no time window
- `#125` Activity feed unbounded + no pagination
- `#126` `layout.tsx` double-fetches workspaces on every navigation

### 6. Silent error swallowing (3 findings)
- `#52` `loadConfig` swallows empty-string overrides; raw stack on Zod error
- `#53` `fetchCommentsForIssues` silently swallows per-issue errors
- `#94` `persist-workflow-run` swallows ALL Supabase errors silently
- `#99` `run-triage-pass-job` marks `failed` only when ALL actions fail (wrong)

### 7. Living-comment / run-status state machine gaps (3 findings)
- `#29` Paused human-gate leaks step as `running` forever
- `#32` Thrown step is sent to `onRunRecord` but never pushed to `runRecords`
- `#40` `LivingComment.start()` throw leaks the run as forever-running
- `#46` Synthetic record's backend is hardcoded `anthropic-api`
- `#54` `Status: blocked/failed` regex matches anywhere in the agent's text

### 8. Webhook / auth surface (3 findings)
- `#60` Cron routes silently accept all callers when `CRON_SECRET` unset
- `#69` Webhook has no delivery-id dedup → vulnerable to replay
- `#75` Webhook returns 500 on errors, causing GitHub to retry into duplicates
- `#119` Open-redirect via unvalidated `?next=` on `/auth/callback`

---

## Recommended triage order

1. **Database fixes** (#112, #113, #110) — schema-level corrections that
   close several application-code races and a security hole. Ship one
   migration for all three.
2. **Workspace scoping** (#101, #84, #85) — exploitable today by any
   authenticated member.
3. **Auth surface** (#119 open-redirect, #69 webhook replay, #60 cron secret
   default-open) — small, high-impact security fixes.
4. **Token / secret leakage** (#58, #59, #62, #64, #87, #100) — group these
   into one runner-security sweep.
5. **Living-comment / run-status state machine** (#29, #32, #40, #46) —
   user-visible "stuck running forever" rows in the cockpit.
6. **Timeouts everywhere** (#26, #31, #82, #96).
7. The unbounded-fetch perf cluster (#79, #98, #123–#126) — easy ergonomic
   wins, do them as a single PR.

---

## Method notes

- **Dispatch**: 13 review subagents, run in 3 parallel batches of 5 / 5 / 4.
- **Scope per agent**: a self-contained list of file paths, the audit
  rubric (bug / perf / usability), explicit instructions to skip nitpicks
  and architectural rewrites, and a single-quoted heredoc template for
  `gh issue create`.
- **Existing labels only** (`bug`, `enhancement`). The repo's audit-label
  request was declined by the auto-mode permission policy, so all issues
  carry the `[audit]` title prefix for filtering instead.
- **Two subagents got their `gh issue create` calls denied** mid-run
  (`gui/content-pages`, `gui/components`). They returned their findings
  inline; I filed the 16 remaining issues directly (#119–#134).
- **One harness incident**: the `core/agents` subagent hit a transient
  classifier outage during filing, retried `#33`, closed it as a duplicate
  of `#22`, then reopened with a misleading "503" explanation. The net
  state is correct (#22 and #33 are distinct findings: persistent-session
  state leak vs argv E2BIG), but the comment chain on #33 should be
  ignored — see #33 comments. No data integrity issue.
- **No findings on CI workflows** (no `.github/workflows/` directory exists
  at audit time) or docs (out of scope per the user's request).

---

## How to drive the follow-up

```bash
# List everything
gh issue list --repo open-mercato/cezar --search '[audit]' --limit 200

# Filter by area
gh issue list --repo open-mercato/cezar --search '[audit][gui/api]'

# Filter by label
gh issue list --repo open-mercato/cezar --search '[audit]' --label bug

# Close all if you decide to consolidate into a single tracking issue
gh issue list --repo open-mercato/cezar --search '[audit]' --limit 200 \
  --json number --jq '.[].number' | xargs -I% gh issue close % --repo open-mercato/cezar
```

---

*Generated by the automated codebase audit run on 2026-06-02.*
