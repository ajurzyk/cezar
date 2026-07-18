/**
 * The shape of the cockpit's HTTP surface (`src/server/server.ts`), hand-mirrored for the
 * browser bundle.
 *
 * Why a mirror and not an import: the server is Node ESM under NodeNext (`.js` relative
 * specifiers, `node:*` imports, zod at runtime). Importing its modules here would either drag
 * Node built-ins into the bundle or force two module-resolution modes into one file. The types
 * are the contract; the code behind them is not.
 *
 * The mirror is *checked*, not trusted: `src/server/api-types.test.ts` asserts type-exactness
 * between these declarations and the server's own (it is a server test on purpose — that is the
 * suite `npm run typecheck` and `npm test` both cover, so drift fails the gate rather than
 * hiding until runtime). Anything below without a guard there carries a real drift risk; keep
 * the guard list in step with this file.
 *
 * This module MUST stay import-free so the guard can reach it from the NodeNext side.
 */

// ---- runs (src/runs/store.ts) ------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/** The agent backends a run can use. `runner` is optional on old records — they predate the
 *  choice and are Claude by definition (see `resumeCommand` in the server). */
export type Runner = 'claude' | 'codex' | 'opencode'

export interface StepState {
  id: string
  name: string
  kind: 'agent' | 'check'
  status: StepStatus
  iterations: number
  tokensUsed: number
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Latest agent session id — `claude --resume <id>` and friends. */
  sessionId?: string
  costUsd?: number
}

/** Aggregate diff numbers of a run's worktree vs its base (#389). */
export interface DiffStat {
  adds: number
  dels: number
  files: number
}

export interface RunRecord {
  id: string
  title: string
  /** Display title (#389): auto-derived from the first agent turn, or the user's inline edit
   *  (`PATCH /api/runs/:id` sets it together with `title`). Show `titleSummary ?? title`. */
  titleSummary?: string
  /** Refreshed on every turn-end; absent until the first turn ends (and on worktree-less runs). */
  diffStat?: DiffStat
  workflow: string
  task: string
  /** URLs of images attached to the initial task prompt (#image-display). */
  taskImages?: string[]
  model?: string
  runner?: Runner
  /** Echo of the extra system prompt the run used (POST override or config default). */
  systemPrompt?: string
  /** false when the run deliberately disabled follow-up todo generation. Absent means enabled. */
  generateFollowups?: boolean
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  tokensUsed: number
  costUsd?: number
  pullRequestUrl?: string
  /** The PR this task is ABOUT (#407) — auto-discovered from conversation references.
   *  Display tier only: `pullRequestUrl` (the PR this task CREATED) wins, and the
   *  Draft-PR / Create-PR action gates ignore it. Read via `taskPrUrl()`. */
  referencedPullRequestUrl?: string
  /** The PR/issue number this task is ABOUT (task auto-naming spec) — display tier only. */
  prNumber?: number
  issueNumber?: number
  /** 'user' = renamed via PATCH, never auto-overwritten; 'auto' = namer-owned. */
  titleOrigin?: 'user' | 'auto'
  /** The referenced tier's working set (distinct PR URLs spotted, capped server-side). */
  referencedPrCandidates?: string[]
  /** Absent when the run executed in the repo working tree rather than its own worktree. */
  worktreePath?: string
  branch?: string
  baseBranch?: string
  /** Parallel variants (spec 010): runs sharing a groupId are one group. */
  groupId?: string
  /** Variant letter within the group — 'A' | 'B' | 'C'. */
  variant?: string
  peakRssBytes?: number
  peakProcCount?: number
  archived: boolean
  archivedAt?: string
  currentStepId?: string
  error?: string
  steps: StepState[]
  /** Persisted workflow definition; kept loose server-side, so loose here too. */
  workflowDef?: Record<string, unknown>
}

/** One aggregated sample of a run's live process tree (src/core/process-usage.ts). */
export interface ProcessUsage {
  cpuPct: number
  rssBytes: number
  procCount: number
}

/**
 * What `GET /api/runs` and `GET /api/runs/:id` actually answer: the stored record plus the
 * live `usage` sample the server attaches on the way out (`withUsage`). Absent for finished
 * runs and wherever `ps` yields nothing — never persisted.
 */
export type ApiRun = RunRecord & { usage?: ProcessUsage }

/**
 * One line of a run's NDJSON transcript. `type` mirrors the agent events plus engine
 * lifecycle, and the payload keys vary by type — hence the index signature. `seq` is the
 * dedup key the reducers key on (Step 3.2).
 */
export interface RunEvent {
  seq: number
  ts: string
  stepId?: string
  type: string
  [key: string]: unknown
}

// ---- parallel variants (spec 010, `GET /api/groups/:groupId`) ------------------------------

/**
 * One variant column of the compare view. CAREFUL: `diffStat` here is the raw `git diff --stat`
 * TEXT the server runs in the variant's worktree (legacy compare semantics) — a different thing
 * from the numeric `RunRecord.diffStat`. `''` when the worktree is gone.
 */
export interface GroupVariant {
  id: string
  /** 'A' | 'B' | 'C' in practice; `'?'` for a record that lost its letter. */
  variant: string
  title: string
  status: RunStatus
  archived: boolean
  tokensUsed: number
  costUsd?: number
  diffStat: string
  /** First lines of the handoff journal's "## Progress log" section, as markdown. */
  handoffExcerpt: string
}

export interface GroupResponse {
  groupId: string
  runs: GroupVariant[]
}

/** `POST /api/groups/:groupId/pick` — the winner (parked at `review` when it has a diff);
 *  the losers were cancelled if alive, archived, and their worktrees + branches removed. */
export interface PickVariantResponse {
  winner?: RunRecord
}

// ---- health / environment (src/core/backend-detect.ts, src/server/git.ts) -----------------

export interface BackendCheck {
  name: 'claude' | 'codex' | 'opencode' | 'gh' | 'git'
  available: boolean
  version?: string
  /** Human setup hint — shown verbatim; the server writes these for people, not for parsing. */
  hint?: string
}

export interface RepoInfo {
  root: string
  branch: string
  remote?: string
}

/** How `/api/health` serializes the resolved forge driver (R5, src/server/forge/):
 *  `{ kind, ...detect() }`. Null means plain-git features only — no PR/issue surfaces. */
export interface ForgeInfo {
  kind: 'github'
  available: boolean
  /** Human-readable hint when unavailable (`gh` missing, offline…). */
  reason?: string
}

/** Server capabilities (src/server/capabilities.ts). `localHandoff: false` means
 *  hosted mode (`CEZ_REMOTE` / non-loopback bind) — every open-on-my-machine affordance
 *  (Terminal, editor, `cd …` hints) must disappear, not disable.
 *  `followups: false` (the default — the inbox is opt-in via `CEZ_FOLLOWUPS=1`, #471) means
 *  this server has no follow-up inbox: the Inbox nav item and the composer's follow-up
 *  toggle disappear the same way. The per-task handoff journal is unrelated and always on. */
export interface Capabilities {
  localHandoff: boolean
  followups: boolean
}

export interface HealthResponse {
  version: string
  /** Only once the npm-registry check answers with something newer (#368). */
  latestVersion?: string
  repoRoot: string
  /** Null when cezar was started outside a git repository. */
  repo: RepoInfo | null
  checks: BackendCheck[]
  defaultRunner: Runner
  /** R5 additive fields (BACKWARD_COMPATIBILITY.md §2 keeps the pre-forge shape intact). */
  forge: ForgeInfo | null
  capabilities: Capabilities
}

/** `GET /api/launch-key` — the bookmarklet auto-start secret (spec 011). Fetched to COMPARE
 *  against the `?key=` query param (/new deep link) and to bake into the `javascript:` links
 *  the Settings → Skills bookmarklet panel generates (the legacy generator's exact use). The
 *  value never renders as text, never logs, and never goes back into the address bar. */
export interface LaunchKeyResponse {
  key: string
}

// ---- session git view (src/server/git-changes.ts, R5) ---------------------------------------

/** One changed file of `GET /api/runs/:id/changes` / `GET /api/repo/changes`. Assignable to
 *  the diff facade's `DiffFileChange` (components/diff/types.ts) by construction. */
export interface ChangedFile {
  path: string
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  adds: number
  dels: number
  /** Binary per numstat — there is no text patch to render. */
  binary: boolean
  /** This file's unified-diff section; possibly `… (patch truncated)`, possibly empty. */
  patch: string
}

/** `GET /api/runs/:id/changes` — the structured worktree-vs-base diff. 409 (+ reason) when
 *  the run has no worktree or git itself refuses; never HTML. */
export interface ChangesPayload {
  files: ChangedFile[]
  stat: { adds: number; dels: number; files: number }
}

/** `GET /api/runs/:id/files?path=` — a directory listing or one file (size-capped, binary
 *  flagged). `content` is absent exactly when `binary` or `tooLarge`. */
export interface WorktreeDirEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}

export type WorktreeEntry =
  | { type: 'dir'; path: string; entries: WorktreeDirEntry[] }
  | { type: 'file'; path: string; size: number; binary: boolean; tooLarge: boolean; content?: string }

/** `POST /api/runs/:id/git/commit` — commit -A in the run's worktree. */
export interface GitCommitResponse {
  committed: boolean
  sha: string
}

/** `POST /api/runs/:id/git/push` — push the worktree's branch, setting upstream if none. */
export interface GitPushResponse {
  pushed: boolean
  branch: string
  remote: string
  upstreamSet: boolean
}

// ---- repo view (src/server/git.ts) ---------------------------------------------------------

export interface StatusEntry {
  status: string
  path: string
}

export interface LogEntry {
  hash: string
  subject: string
  author: string
  when: string
}

export interface RepoResponse {
  info: RepoInfo | null
  status: StatusEntry[]
  log: LogEntry[]
  branches: string[]
  baseBranch: string | null
}

/** `GET /api/repo/commit/:sha?structured=1` (R5 Step 1.7) — one commit's metadata plus the
 *  same `{files, stat}` shape the /changes routes serve. 409 (+ reason) for unknown shas;
 *  a merge commit honestly answers zero files. The bare route keeps its legacy text shape. */
export interface RepoCommitPayload {
  sha: string
  subject: string
  author: string
  /** Relative time ("3 hours ago") — same `%cr` format as the /api/repo log. */
  when: string
  files: ChangedFile[]
  stat: { adds: number; dels: number; files: number }
}

/** A commit a run made on its worktree branch (`GET /api/runs/:id/commits`). */
export interface RunCommit {
  sha: string
  subject: string
  author: string
  when: string
}

export interface RunCommitsResponse {
  commits: RunCommit[]
}

/** `POST /api/repo/branch` — switch to an existing branch or create one (from `from` or HEAD)
 *  and switch. Every predictable git failure (invalid name, unknown `from`, dirty-tree
 *  checkout conflict) is a 409 whose ApiError speaks git's words. */
export interface RepoBranchResponse {
  branch: string
  created: boolean
}

// ---- workflows (src/workflows/types.ts, src/workflows/load.ts) ------------------------------

export interface WorkflowStepDef {
  id: string
  name?: string
  prompt?: string
  skill?: string
  model?: string
  runner?: Runner
  allowedTools?: string[]
  bashAllowlist?: string[]
  command?: string
  onFail?: { retry: string; max: number }
}

export interface WorkflowDef {
  name: string
  description?: string
  steps: WorkflowStepDef[]
  source: 'built-in' | 'file'
  path?: string
}

export interface WorkflowLoadIssue {
  path: string
  message: string
}

export interface WorkflowsResponse {
  workflows: WorkflowDef[]
  /** Files that failed to load. The catalog still returns — bad files are reported, not fatal. */
  issues: WorkflowLoadIssue[]
}

/** `POST /api/plan` (spec 008): the proposed chain for a task. Never a hard failure server-side —
 *  a missing CLI, a timeout or an unparseable answer degrade to the one-step quick-task plan
 *  with `fallback: true`, which the UI surfaces as a dim note. */
export interface PlanResponse {
  steps: WorkflowStepDef[]
  rationale: string
  fallback: boolean
}

/** `POST /api/workflows`: save a chain as `.ai/cezar/workflows/<slug>.yaml`. Exactly one of
 *  `steps` / the portable `skills` shorthand — the server's schema refines on the XOR. Without
 *  `overwrite` an existing file answers 409 with `exists: true` (see ApiError) — the UI
 *  confirms, then retries with `overwrite: true`. */
export interface SaveWorkflowInput {
  name: string
  description?: string
  steps?: WorkflowStepDef[]
  skills?: string[]
  overwrite?: boolean
}

export interface SaveWorkflowResponse {
  path: string
  name: string
}

/** `POST /api/workflows/parse` (spec 012): pasted YAML → the normalized definition. The
 *  server owns YAML parsing and validation; a bad paste is a 400 whose ApiError carries the
 *  zod/YAML reason verbatim. */
export interface ParsedWorkflow {
  name: string
  description?: string
  steps: WorkflowStepDef[]
}

/** `DELETE /api/workflows/:name` — file workflows only; built-ins answer 400. */
export interface DeleteWorkflowResponse {
  ok: boolean
  path: string
}

// ---- skills (src/skills.ts) -----------------------------------------------------------------

export interface Skill {
  name: string
  description?: string
  body: string
  path: string
  source: 'ai' | 'cezar' | 'agents' | 'global' | 'team'
  /** Team skills only: where the definition lives in its skills repo. */
  team?: {
    repo: string
    ref: string
    path: string
    dir: boolean
  }
}

// ---- inbox (src/todos.ts) --------------------------------------------------------------------

export interface TodoItem {
  id: string
  ts?: string
  taskId?: string
  summary: string
  action?: string
  prUrl?: string
  suggestedSkill?: string
  suggestedArgs?: string
  suggestedPrompt?: string
  /** Explicit intent; missing infers from suggestedSkill/suggestedPrompt for old files. */
  runnable?: boolean
  /** Set by the server when "▶ Run" turned this entry into a task. */
  startedTaskId?: string
}

/** `DELETE /api/todos/:id` — Dismiss checks the entry off. */
export interface RemoveTodoResponse {
  removed: boolean
}

/** `POST /api/todos/:id/start` — Run turns the entry into a task (201 with the new run). */
export interface StartTodoResponse {
  run: RunRecord
}

// ---- GitHub tab (src/server/github.ts) --------------------------------------------------------

export interface GithubItem {
  kind: 'issue' | 'pr'
  number: number
  title: string
  author: string
  createdAt: string
  labels: string[]
  body: string
  url: string
  comments: number
  /** PRs only. */
  isDraft?: boolean
  additions?: number
  deletions?: number
  checks?: 'passing' | 'failing' | 'pending' | null
}

export interface GithubData {
  available: boolean
  /** Why it is unavailable (`gh` missing, no remote, offline…). Never an error — a hint. */
  reason?: string
  /** owner/name, when known. */
  repo?: string
  syncedAt?: string
  issues: GithubItem[]
  prs: GithubItem[]
  /** Repo-wide label name → 6-hex color (no `#`); lets chips tint like GitHub. Additive. */
  labelColors?: Record<string, string>
}

// ---- GUI prefs (`PUT /api/ui-state`) -----------------------------------------------------------

/** The keys the server's schema names. It is a passthrough schema, so unknown keys round-trip
 *  untouched — future prefs need no server change, which is why this stays open. */
export interface UiState {
  lastTask?: { source: 'workflow' | 'skill'; ref: string }
  /** Most-recently-run sources, newest first (deduped, capped). Feeds the composer picker's
   *  recency sort so the skills you actually use float to the top of their locality group. */
  recentSources?: { source: 'workflow' | 'skill'; ref: string }[]
  /** The last worktree choice for a single-skill run — remembered so the checkbox re-opens where
   *  you left it. Absent → the default (isolated worktree). */
  lastWorktree?: boolean
  /** The last autonomous choice — remembered like lastWorktree. Absent → off. */
  lastAutonomous?: boolean
  /** Whether new runs should ask agents to append follow-up work. Absent → on. */
  lastGenerateFollowups?: boolean
  runsView?: 'list' | 'table'
  /** The GitHub tab's last-selected sub-tab (#417) — issues or PRs. Absent → issues. */
  githubView?: 'issues' | 'prs'
  /** Settings → Appearance (redesign R6): accent + density. Theme itself stays in
   *  localStorage (`cez-theme`) — it must pre-paint, and it is per-browser by design. */
  appearance?: { accent?: 'lime' | 'violet'; density?: 'comfortable' | 'compact' | 'ultra' }
  /** Settings → Notifications (redesign R6 1.7): the browser-notification toggle. Off unless
   *  literally `true`. Permission itself is per-browser and never persisted. */
  notifications?: { enabled?: boolean }
  /** Follow-up prompt templates (#413): reusable snippets insertable into the GitHub hand-over,
   *  Inbox, and /new composers. Absent → the built-in defaults (`lib/prompt-templates.ts`);
   *  present (even `[]`) is the user's own edited list from Settings → Prompt templates.
   *  `skills` (optional) are the skill names the template auto-applies for. */
  promptTemplates?: { id: string; label: string; text: string; skills?: string[] }[]
  /** The open-mercato/skills promo banner (#391), dismissed for good. Set once true, never
   *  unset — server-persisted rather than a cookie so "shown once" holds across browsers. */
  dismissedSkillsBanner?: boolean
  [key: string]: unknown
}

// ---- request bodies ------------------------------------------------------------------------------

/** An inline image, base64 — the same shape `POST /api/runs` and the message endpoint take
 *  (≤4 images, ~5 MB each once decoded). */
export interface ImageInput {
  mediaType: string
  data: string
}

/** `POST /api/runs`. Exactly one of `workflow` / `steps` — the server rejects both or neither. */
export interface CreateRunInput {
  task: string
  workflow?: string
  steps?: WorkflowStepDef[]
  model?: string
  runner?: Runner
  /** 1–3. Above 1 the response is `{ runs }` rather than a single record. */
  variants?: number
  images?: ImageInput[]
  /** false → run in the repo working tree instead of an isolated worktree (read-only skills).
   *  Omit for the default. Ignored server-side when variants > 1. */
  worktree?: boolean
  /** true → autonomous run: never parks at "waiting" for the user; auto-continues until done. */
  autonomous?: boolean
  /** false → keep the handoff journal but do not expose or request a follow-up todos file.
   *  Omit for the default (enabled). */
  generateFollowups?: boolean
}

export interface MessageInput {
  text?: string
  images?: ImageInput[]
}

/** `PATCH /api/runs/:id` (#389). `title`: trimmed server-side, 1–300 chars. The edit sets both
 *  `title` and `titleSummary`, so it wins over any auto-summary. Answers the updated record. */
export interface PatchRunInput {
  title?: string
}

/** Per-runner default model preset (Settings → Agents, R6 1.5): the composer preselects this
 *  model id for the runner. Absent = auto (the runner decides). */
export type RunnerModels = Partial<Record<Runner, string>>

/** `GET /api/config` (additive R6 route): every Settings → Agents knob in one read. */
export interface ConfigResponse {
  baseBranch: string | null
  defaultRunner: Runner
  systemPrompt: string | null
  defaultModels: RunnerModels
  /** How many tasks run at once (1–16). */
  maxParallel: number
  /** Per-task memory ceiling in MiB (whole process tree); null = no limit. */
  memoryLimitMb: number | null
  /** Keep the last N finished worktrees on disk (#483); 0 = unlimited. Older
   *  ones are reclaimed (directory only — branch kept, so work is recoverable). */
  worktreeRetention: number
  /** Live title updates (task auto-naming): null = no config key, the
   *  CEZ_TITLE_UPDATES env default (ON) decides. */
  liveTitleUpdates: boolean | null
  /** Optional review gate (#489): null = no config key, the CEZ_REVIEW_GATE env
   *  default (OFF) decides. */
  reviewGate: boolean | null
}

/** `PUT /api/config` (Settings → Agents; the Repo tab's base-branch picker). `baseBranch: null`
 *  clears the setting back to "current checkout"; `systemPrompt` and per-runner `defaultModels`
 *  entries clear on `null` (or `''`) too. Merged into the raw config.json server-side —
 *  `defaultModels` merges per runner, so one write never clobbers another runner's preset. */
export interface SetConfigInput {
  baseBranch?: string | null
  defaultRunner?: Runner
  systemPrompt?: string | null
  defaultModels?: Partial<Record<Runner, string | null>>
  maxParallel?: number
  /** null or 0 clears the ceiling back to "no limit". */
  memoryLimitMb?: number | null
  /** Keep last N finished worktrees (#483); 0 = unlimited, null clears back to
   *  the default (10). */
  worktreeRetention?: number | null
  /** null clears the key back to the env-default behavior. */
  liveTitleUpdates?: boolean | null
  /** null clears the key back to the env-default behavior (OFF). */
  reviewGate?: boolean | null
}

/** The PUT answer: the same shape GET serves (the pre-R6 fields stayed, the rest is additive). */
export type SetConfigResponse = ConfigResponse

/** One materialized task worktree in the management panel (#483). `sizeBytes` is
 *  null when `du` is unavailable (Windows / missing). `reclaimable` = finished,
 *  has a directory, not yet reclaimed (retention's rule). */
export interface WorktreeInfo {
  runId: string
  title: string
  status: string
  branch: string | null
  sizeBytes: number | null
  finishedAt: string | null
  reclaimable: boolean
}

/** `GET /api/worktrees` (#483): the worktrees on disk, their total size (null when any
 *  degraded), and the current keep-limit (0 = unlimited). */
export interface WorktreesResponse {
  worktrees: WorktreeInfo[]
  totalBytes: number | null
  keep: number
}

/** `POST /api/worktrees/reclaim` (#483): the run ids whose directory was reclaimed. */
export interface ReclaimWorktreesResponse {
  reclaimed: string[]
}

/** `POST /api/runs/:id/remove-worktree`: per-row delete in the worktrees panel. */
export interface RemoveWorktreeResponse {
  removed: boolean
}

/** A local app a worktree can be opened in (#open-in): editor, file manager, or terminal. */
export interface OpenTarget {
  id: string
  label: string
  /** A stable icon key (#361) the UI maps to a concrete icon — `openInIcon` in run-header.tsx.
   *  Optional: an older server omitting it just renders the generic fallback icon. */
  icon?: string
}

/** `GET /api/open-targets` — the detected local apps; empty in hosted mode (CEZ_REMOTE). */
export interface OpenTargetsResponse {
  targets: OpenTarget[]
}

// ---- mutation responses ---------------------------------------------------------------------------

/** `POST /api/runs` — one record for ×1, a group for ×2/×3. */
export type CreateRunResponse = ApiRun | { runs: RunRecord[] }

export interface CancelResponse {
  cancelled: boolean
}

/** `POST /api/runs/archive-finished` — how many runs the sweep archived. */
export interface ArchiveFinishedResponse {
  archived: number
}

export interface DeleteRunResponse {
  deleted: boolean
}

export interface FinishResponse {
  finished: boolean
}

export interface ContinueResponse {
  continued: boolean
}

/** `POST /api/runs/:id/pr` (spec 009) — the draft PR's URL; `dryRun` marks the CEZ_DRY_RUN
 *  fake (no push, no gh). On failure the server answers 409 and the `ApiError` carries the
 *  `manual` merge command instead. */
export interface CreatePrResponse {
  url: string
  dryRun?: boolean
}

export interface MessageResponse {
  delivered: boolean
}

/** `POST /api/runs/:id/open-in-cli` — a terminal was spawned with `command` running in it.
 *  When no terminal emulator exists the server answers 409 instead, and the `ApiError` carries
 *  the full `cd … && <command>` in its `command` field for the clipboard fallback. */
export interface OpenInCliResponse {
  opened: boolean
  command: string
}
