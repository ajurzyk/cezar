import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getConfig,
  getGithub,
  getGroup,
  getHealth,
  getLaunchKey,
  getOpenTargets,
  getRepo,
  getRunCommit,
  getRunCommits,
  getRepoChanges,
  getRepoCommit,
  getRun,
  getRunChanges,
  getRunDiff,
  getRunFile,
  getRunHandoff,
  getRuns,
  getSkills,
  getTodos,
  getUiState,
  getWorkflows,
  patchRun,
  sendMessage,
} from './client'
import type { MessageInput, PatchRunInput } from './types'

/**
 * Query keys, in one place and exported, because they are a contract rather than an
 * implementation detail: Step 3.2's stream handlers invalidate and reconcile *these* keys when
 * an event says the data behind them moved. A key spelled inline at a call site is a key
 * nothing can invalidate.
 *
 * Hierarchical on purpose — `queryKeys.runs.all` invalidates the list and every single-run
 * query under it in one call.
 */
export const queryKeys = {
  health: ['health'] as const,
  runs: {
    all: ['runs'] as const,
    list: () => ['runs', 'list'] as const,
    detail: (id: string) => ['runs', 'detail', id] as const,
    diff: (id: string) => ['runs', 'diff', id] as const,
    changes: (id: string) => ['runs', 'changes', id] as const,
    file: (id: string, path: string) => ['runs', 'files', id, path] as const,
    handoff: (id: string) => ['runs', 'handoff', id] as const,
    commits: (id: string) => ['runs', 'commits', id] as const,
    commit: (id: string, sha: string) => ['runs', 'commit', id, sha] as const,
  },
  groups: {
    detail: (groupId: string) => ['groups', groupId] as const,
  },
  todos: ['todos'] as const,
  workflows: ['workflows'] as const,
  skills: ['skills'] as const,
  launchKey: ['launch-key'] as const,
  repo: ['repo'] as const,
  /** Children of `repo` on purpose: invalidating `queryKeys.repo` (a branch switch, a new
   *  commit) prefix-matches the working-tree diff and every cached commit diff too. */
  repoChanges: ['repo', 'changes'] as const,
  repoCommit: (sha: string) => ['repo', 'commit', sha] as const,
  uiState: ['ui-state'] as const,
  /** The Settings → Agents knobs (`GET /api/config`, R6 1.5). */
  config: ['config'] as const,
  github: (params: { limit?: number } = {}) => ['github', params.limit ?? null] as const,
  openTargets: ['open-targets'] as const,
} as const

/** Version + update check + repo/branch + tool probes. Feeds the sidebar's repo and version
 *  chips and (Step 4.2) the Tools menu.
 *
 * Polled on a `useRunChanges`-style interval rather than left to reconnect/visibility alone
 * (#369): a `git checkout` in a terminal, in a foreground tab whose SSE connection never drops,
 * fires none of those triggers, so the branch chip would sit stale until something else woke the
 * query up. The stream still carries nothing for this — no server-side watcher on `.git/HEAD` —
 * so a light poll is the honest fix, the same trade `useRunChanges` already makes for the
 * Changes tab. `git rev-parse` is cheap enough that a few-second interval per open tab is not
 * worth a heavier watch mechanism. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => getHealth({ signal }),
    refetchInterval: 5000,
  })
}

/** The local "Open in…" targets (#open-in). Machine-level and stable, so it caches broadly;
 *  empty in hosted mode. */
export function useOpenTargets() {
  return useQuery({
    queryKey: queryKeys.openTargets,
    queryFn: ({ signal }) => getOpenTargets({ signal }),
    staleTime: 5 * 60_000,
  })
}

/** The authoritative run list. */
export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: ({ signal }) => getRuns({ signal }),
  })
}

/** One run, authoritative. `id` may be absent while a route param is still unresolved. */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.detail(id ?? ''),
    queryFn: ({ signal }) => getRun(id as string, { signal }),
    enabled: Boolean(id),
  })
}

export function useRunDiff(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.diff(id ?? ''),
    queryFn: ({ signal }) => getRunDiff(id as string, { signal }),
    enabled: Boolean(id),
  })
}

/** The structured worktree diff behind the Changes tab (R5). A 409 ("no worktree — …") is a
 *  real answer here, not a network hiccup — retrying cannot change it, so retries are off and
 *  the view renders the server's own reason. */
export function useRunChanges(id: string | undefined, live = false) {
  return useQuery({
    queryKey: queryKeys.runs.changes(id ?? ''),
    queryFn: ({ signal }) => getRunChanges(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    // While the run is active the agent is still writing — poll so the Changes tab keeps up
    // instead of showing a stale empty snapshot from before the first write (#changes-live).
    refetchInterval: live ? 4000 : false,
  })
}

/** One worktree path for the Files tab (R5): the root/dir listings the tree lazy-loads and
 *  the file entries the preview renders. `path` is '' for the worktree root and `undefined`
 *  while nothing is selected. Like /changes, a 409 ("no worktree — …") is an answer retries
 *  cannot change, so retries are off. Cached per (run, path) — re-expanding a folder is free. */
export function useRunFile(id: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.file(id ?? '', path ?? ''),
    queryFn: ({ signal }) => getRunFile(id as string, path as string, { signal }),
    enabled: Boolean(id) && path !== undefined,
    retry: false,
  })
}

/** The variant-compare data for `/compare/:groupId` (spec 010). Freshness while variants are
 *  still running is the ROUTE's concern: the group endpoint is not on the SSE stream, so the
 *  compare view invalidates this key when the run list (which IS stream-patched) shows a member
 *  changing state — no polling, per the sync doctrine. */
export function useGroup(groupId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.groups.detail(groupId ?? ''),
    queryFn: ({ signal }) => getGroup(groupId as string, { signal }),
    enabled: Boolean(groupId),
  })
}

/** A run's commit list (Commits tab). Polls while active so new commits appear as the agent
 *  autosaves. A 409 ("no worktree") is a real answer retries can't change. */
export function useRunCommits(id: string | undefined, live = false) {
  return useQuery({
    queryKey: queryKeys.runs.commits(id ?? ''),
    queryFn: ({ signal }) => getRunCommits(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: live ? 5000 : false,
  })
}

/** One of a run's commits, structured like the Changes tab. */
export function useRunCommit(id: string | undefined, sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.commit(id ?? '', sha ?? ''),
    queryFn: ({ signal }) => getRunCommit(id as string, sha as string, { signal }),
    enabled: Boolean(id) && Boolean(sha),
    retry: false,
  })
}

/** The handoff journal behind the header's Notes panel. `enabled` gates the fetch on the panel
 *  actually being open — notes are read on demand, not on every thread visit. */
export function useRunHandoff(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.runs.handoff(id ?? ''),
    queryFn: ({ signal }) => getRunHandoff(id as string, { signal }),
    enabled: Boolean(id) && enabled,
  })
}

/** The follow-up inbox. Drives the nav badge. */
export function useTodos() {
  return useQuery({
    queryKey: queryKeys.todos,
    queryFn: ({ signal }) => getTodos({ signal }),
  })
}

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => getWorkflows({ signal }),
  })
}

/** `enabled` gates the fetch for surfaces that need skills only once interacted with — the
 *  composer's `/` autocomplete fetches on first trigger, never on every thread visit. (The
 *  palette gets the same laziness structurally: its content mounts only while open.) */
export function useSkills(enabled = true) {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: ({ signal }) => getSkills({ signal }),
    enabled,
  })
}

/** The bookmarklet auto-start secret (spec 011). Mounted ONLY by the Settings → Skills
 *  bookmarklet panel, which bakes it into the generated `javascript:` links exactly like the
 *  legacy generator did. The key never renders as text and never goes back into a URL bar. */
export function useLaunchKey() {
  return useQuery({
    queryKey: queryKeys.launchKey,
    queryFn: ({ signal }) => getLaunchKey({ signal }),
    // The key is stable for the server's lifetime — refetching it buys nothing.
    staleTime: Infinity,
  })
}

export function useRepo() {
  return useQuery({
    queryKey: queryKeys.repo,
    queryFn: ({ signal }) => getRepo({ signal }),
  })
}

/** The main working tree's structured diff behind the repo view's Changes section (R5 1.7).
 *  Same 409 stance as `useRunChanges`: "not a git repository" is an answer, not a hiccup. */
export function useRepoChanges() {
  return useQuery({
    queryKey: queryKeys.repoChanges,
    queryFn: ({ signal }) => getRepoChanges({ signal }),
    retry: false,
  })
}

/** One commit's structured diff (R5 repo view). A 409 ("unknown commit") is an answer retries
 *  cannot change. Cached per sha — commit history is immutable, so revisits are free. */
export function useRepoCommit(sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.repoCommit(sha ?? ''),
    queryFn: ({ signal }) => getRepoCommit(sha as string, { signal }),
    enabled: Boolean(sha),
    retry: false,
  })
}

/** The Settings → Agents knobs (R6 1.5): base branch, default runner, system prompt, per-runner
 *  model presets. The composer reads it too — `defaultModels` preselects its Model pill. */
export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: ({ signal }) => getConfig({ signal }),
  })
}

export function useUiState() {
  return useQuery({
    queryKey: queryKeys.uiState,
    queryFn: ({ signal }) => getUiState({ signal }),
  })
}

/** Rename a run (#389): `PATCH /api/runs/:id`. Invalidates `runs.*` so the list and the detail
 *  view refetch the authoritative record. The run header's inline title edit sits on this. */
export function usePatchRun(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: PatchRunInput) => patchRun(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Deliver a reply into a live session (`POST /api/runs/:id/messages`). The transcript itself
 *  grows over SSE (`user-message`, then the agent's turn); the invalidation refreshes the
 *  record (status flips waiting → running). Errors are the CALLER's to surface — the composer
 *  restores the draft and toasts, so no toast fires here. */
export function useSendMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (message: MessageInput) => sendMessage(id, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Issues + PRs through the forge (`/api/github`). `enabled` exists for the GitHub tab's
 *  legacy two-shot load: the background everything-open fetch (limit 1000) waits until the
 *  fast default batch has proven the forge reachable — no point paying the big `gh` call
 *  twice just to learn "unavailable" twice. */
export function useGithub(params: { limit?: number } = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.github(params),
    queryFn: ({ signal }) => getGithub({ limit: params.limit }, { signal }),
    enabled,
  })
}
