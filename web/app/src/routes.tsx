import { Suspense, lazy } from 'react'
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router'

import { useHealth, useProjects } from './api/queries'
import { ProjectScopeProvider } from './api/project-scope-context'
import { Navigate as ScopedNavigate } from './lib/project-router'
import { CompareLoading } from './routes/compare-loading'
import { GithubLoading } from './routes/github/github-loading'
import { InboxRoute } from './routes/inbox'
import { NewTaskRoute } from './routes/new-task'
import { NotFoundRoute } from './routes/not-found'
import { RepoGitLoading } from './routes/repo-git/repo-git-loading'
import { SkillsLoading } from './routes/skills-loading'
import { UnknownProjectRoute } from './routes/unknown-project'
import { WorkflowsLoading } from './routes/workflows/workflows-loading'
import { GitTabLoading } from './routes/task-git/git-tab-loading'
import { ThreadLoading } from './routes/task-thread/thread-loading'
import { visibleSettingsSections } from './routes/settings/registry'
import { SettingsIndexRoute, SettingsSectionRoute } from './routes/settings/settings-shell'
import { TasksOverviewRoute } from './routes/tasks-overview'

/** Lazy ON PURPOSE: the thread view carries the markdown stack (Streamdown + remark/rehype,
 *  ~140 KB gz) — as a static import it would sit in the main bundle every visitor pays for
 *  before any route renders. The Suspense fallback is the same loading state the route itself
 *  shows while fetching, so the split is invisible to the user. */
const TaskThreadRoute = lazy(() =>
  import('./routes/task-thread/task-thread').then((m) => ({ default: m.TaskThreadRoute })),
)

/** Lazy for the same reason: the compare view renders Progress excerpts through Streamdown and
 *  full diffs through the Shiki singleton — thread-chunk weight the home screen must not pay. */
const CompareVariantsRoute = lazy(() =>
  import('./routes/compare-variants').then((m) => ({ default: m.CompareVariantsRoute })),
)

/** Lazy because both tabs render the shared run header, which lives in the thread chunk
 *  (markdown stack and all) — a static import here would pull that into the main bundle. */
const TaskChangesRoute = lazy(() =>
  import('./routes/task-git/task-changes').then((m) => ({ default: m.TaskChangesRoute })),
)
const TaskFilesRoute = lazy(() =>
  import('./routes/task-git/task-files').then((m) => ({ default: m.TaskFilesRoute })),
)
const TaskCommitsRoute = lazy(() =>
  import('./routes/task-git/task-commits').then((m) => ({ default: m.TaskCommitsRoute })),
)

/** Lazy because the repo view renders through the `<Diff>` facade and the Shiki singleton —
 *  the same heavy chunk the task git tabs ride; the home screen must not pay for it. */
const RepoGitRoute = lazy(() =>
  import('./routes/repo-git/repo-git').then((m) => ({ default: m.RepoGitRoute })),
)

/** Lazy because the GitHub detail pane renders issue/PR bodies through the same markdown
 *  stack the thread carries — thread-chunk weight the home screen must not pay. */
const GithubRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubRoute })),
)
/** `/github`'s index (#417) — restores the last-selected tab. Same chunk as `GithubRoute`,
 *  just a second named export off the same lazy import. */
const GithubIndexRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubIndexRoute })),
)

/** Lazy because the builder carries dnd-kit (R6 Step 1.6) — drag machinery only this surface
 *  uses, so only this surface pays for it. */
const WorkflowsRoute = lazy(() =>
  import('./routes/workflows/workflows').then((m) => ({ default: m.WorkflowsRoute })),
)

/** Lazy because the skill detail renders the skill body through the same markdown stack the
 *  thread carries — thread-chunk weight the home screen must not pay (it used to ride the main
 *  bundle as a static Settings section). */
const SkillsRoute = lazy(() => import('./routes/skills').then((m) => ({ default: m.SkillsRoute })))

/** `/settings/skills` moved to the top-level `/skills` (out of the Settings shell). Redirect —
 *  preserving the `?skill=` selection — so pasted links and saved bookmarklets still land.
 *  The scoped Navigate keeps the redirect inside the active project. */
function SettingsSkillsRedirect() {
  const location = useLocation()
  return <ScopedNavigate to={{ pathname: '/skills', search: location.search }} replace />
}

/** What renders while a redirect target is still being resolved (the boot id from `/api/health`,
 *  the registry from `/api/projects`). Deliberately quiet: the answer arrives in one local round
 *  trip, and any real screen here would flash the WRONG screen (spec, "URL scheme"). */
function ScopeResolving() {
  return (
    <div data-route="scope-resolving" className="flex min-h-full flex-col">
      <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
    </div>
  )
}

/**
 * The `/p/:projectId` layout gate (multi-project spec, step 3.2) — the ONE place the URL's
 * project id becomes the app's project scope:
 *
 *  - `/p/default/…` is the reserved alias for the boot project (never an allocated slug):
 *    normalized to the real slug with a `replace` navigation, so the address bar always names
 *    the project. Params, query and hash survive byte-for-byte.
 *  - an id the registry doesn't know renders the "not registered here" screen — the cockpit
 *    twin of the API's 404;
 *  - a known id mounts `ProjectScopeProvider`, which scopes the API client and the query
 *    cache for the whole routed subtree (`<Outlet />`).
 *
 * When `/api/projects` itself errors (server unreachable), the gate mounts the scope anyway:
 * known-ness cannot be verified, and the routed views' own error states are the honest surface
 * for an unreachable server — a permanent "Loading…" here would not be.
 */
function ProjectScopeRoute() {
  const { projectId = '' } = useParams()
  const location = useLocation()
  const projects = useProjects()

  if (projectId === 'default') {
    const boot = projects.data?.bootProject
    if (boot === undefined) return <ScopeResolving />
    const rest = location.pathname.replace(/^\/p\/default(?=\/|$)/, '')
    return (
      <Navigate
        to={`/p/${encodeURIComponent(boot)}${rest || '/'}${location.search}${location.hash}`}
        replace
      />
    )
  }

  if (projects.data) {
    const known =
      projects.data.bootProject === projectId ||
      projects.data.projects.some((project) => project.id === projectId)
    if (!known) return <UnknownProjectRoute projectId={projectId} registry={projects.data} />
  } else if (!projects.isError) {
    return <ScopeResolving />
  }

  // The BOOT project mounts UNSCOPED (projectId null): the step-3.1 invariant keeps its API
  // requests byte-identical to the single-project cockpit — the protected legacy `/api/*`
  // surface — and its cache under the same `'default'`-led keys the shell chrome (which
  // renders outside this provider) already uses. Only non-boot projects pay the `/api/p/<id>`
  // prefix. Links carry the URL prefix either way (project-router falls back to the URL).
  const scopeId = projects.data?.bootProject === projectId ? null : projectId

  return (
    <ProjectScopeProvider projectId={scopeId}>
      <Outlet />
    </ProjectScopeProvider>
  )
}

/**
 * Legacy flat URLs — every pre-multi-project path, `/tasks/:id` bookmarks and the `/new?...`
 * bookmarklet grammar included — redirect to the boot project's scoped twin, preserving path,
 * query and hash byte-for-byte (BACKWARD_COMPATIBILITY.md protects the bookmarklet contract).
 * The boot id comes from `/api/health` (`bootProject`); until it answers, the quiet resolving
 * state — never a flashed wrong screen. `replace` keeps Back from bouncing off the redirect.
 */
function LegacyPathRedirect() {
  const location = useLocation()
  const health = useHealth()
  if (health.data === undefined) return <ScopeResolving />
  // Health always names the boot project; the alias is a just-in-case fallback that still
  // lands (the gate above normalizes `default` from the registry, which always answers one).
  const boot = health.data.bootProject ?? 'default'
  // A bare `/p` (or `/p/`) names no project — send it to the boot project's home rather than
  // minting a nonsense `/p/<boot>/p` path.
  const path = location.pathname === '/p' || location.pathname === '/p/' ? '/' : location.pathname
  return (
    <Navigate
      to={`/p/${encodeURIComponent(boot)}${path}${location.search}${location.hash}`}
      replace
    />
  )
}

/** The route map from the spec's "Routing — every surface is a URL" section.
 *
 *  Real URLs, not hash routes: the Hono server serves the built index.html for
 *  every non-/api GET (src/server/static-ui.ts `resolveGetRequest`), so each of
 *  these cold-loads and survives a refresh — `/p/…` paths included.
 *
 *  Every path lives under `/p/:projectId/` (multi-project spec, step 3.2) via the one
 *  `ProjectScopeRoute` layout above; the flat spellings below are relative to that prefix and
 *  stay stable — they are what teammates paste, and the legacy flat URLs redirect onto them.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:projectId" element={<ProjectScopeRoute />}>
        <Route index element={<TasksOverviewRoute />} />
        <Route path="new" element={<NewTaskRoute />} />

        <Route
          path="tasks/:id"
          element={
            <Suspense fallback={<ThreadLoading />}>
              <TaskThreadRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/changes"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskChangesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/files"
          element={
            <Suspense fallback={<GitTabLoading tab="files" />}>
              <TaskFilesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits/:sha"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="compare/:groupId"
          element={
            <Suspense fallback={<CompareLoading />}>
              <CompareVariantsRoute />
            </Suspense>
          }
        />

        {/* The repo view (R5 Step 1.7): each segment is a URL — /git (working-tree changes),
            /git/commits (+ /:sha for one commit's diff), /git/branches. */}
        <Route
          path="git"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="changes" />
            </Suspense>
          }
        />
        <Route
          path="git/commits"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/commits/:sha"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/branches"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="branches" />
            </Suspense>
          }
        />
        {/* The GitHub tab (R6 Step 1.1): issues and PRs are separate list URLs, each item a
            deep link. The nav item is forge-gated in the shell; the routes stay reachable so a
            pasted link renders the honest unavailable explainer instead of a 404. The bare
            `/github` is the one URL that restores the last-selected tab (#417) — `/github/prs`
            and the `:n` deep links are always exactly what they say. */}
        <Route
          path="github"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubIndexRoute />
            </Suspense>
          }
        />
        <Route
          path="github/prs"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />
        <Route
          path="github/issues/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="issues" />
            </Suspense>
          }
        />
        <Route
          path="github/prs/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />

        {/* The skills catalog (R6 Step 1.4) — its own top-level surface, no settings sub-nav.
            `/settings/skills` redirects here (below) so pasted links keep working. */}
        <Route
          path="skills"
          element={
            <Suspense fallback={<SkillsLoading />}>
              <SkillsRoute />
            </Suspense>
          }
        />

        {/* The follow-up inbox (R6 Step 1.2): light — no markdown stack — so it rides the main
            bundle like the overview does. */}
        <Route path="inbox" element={<InboxRoute />} />

        {/* The workflow builder (R6 Step 1.6): /workflows opens the canvas on the repo's first
            saved chain, /workflows/:name deep-links a specific one. */}
        <Route
          path="workflows"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowsRoute />
            </Suspense>
          }
        />
        <Route
          path="workflows/:name"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowsRoute />
            </Suspense>
          }
        />

        {/* Settings (R6 Step 1.3): registry-driven — the section list, nav and routes all come
            from routes/settings/registry.tsx. Hidden sections are NOT routed, so their URLs are
            honest 404s until the section ships (notifications unhides in Step 1.7). */}
        <Route path="settings" element={<SettingsIndexRoute />} />
        <Route path="settings/skills" element={<SettingsSkillsRedirect />} />
        {visibleSettingsSections().map((section) => (
          <Route
            key={section.id}
            path={`settings/${section.id}`}
            element={<SettingsSectionRoute section={section} />}
          />
        ))}

        <Route path="*" element={<NotFoundRoute />} />
      </Route>

      {/* Everything else IS a legacy flat URL — the boot-project redirect owns it. The 404 for
          truly unknown paths still renders, scoped, after the redirect. */}
      <Route path="*" element={<LegacyPathRedirect />} />
    </Routes>
  )
}
