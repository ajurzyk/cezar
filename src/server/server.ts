import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { detectEnvironment } from '../core/backend-detect.js';
import type { ContentBlock } from '../core/agent-runner.js';
import { currentUsage, onUsage } from '../core/process-usage.js';
import { WORKFLOWS_DIR, loadWorkflows } from '../workflows/load.js';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
  workflowStepSchema,
  type WorkflowDef,
} from '../workflows/types.js';
import { planChain, slugify } from '../planner.js';
import { discoverSkills } from '../skills.js';
import { refreshTeamSkills } from '../skills-remote.js';
import { appendHandoffHeartbeat, handoffProgressExcerpt, readHandoff } from '../handoff.js';
import { markStarted, onTodosChanged, readTodos, removeTodo, startTodosWatch, type TodoItem } from '../todos.js';
import type { RunEvent, RunRecord, RunStatus, RunStore } from '../runs/store.js';
import { isV2WireEventType } from '../runs/ui-event-sink.js';
import type { RunManager } from '../workflows/run.js';
import { removeWorktree, worktreeDiff, worktreeDiffStat } from '../git-worktree.js';
import { getBranches, getCommit, getDiff, getLog, getRepoInfo, getStatus } from './git.js';
import {
  collectChanges,
  collectCommitChanges,
  collectRunCommits,
  commitAll,
  createOrSwitchBranch,
  imageMimeType,
  pushCurrentBranch,
  readWorktreePath,
} from './git-changes.js';
import { loadConfig, type CezConfig } from '../config.js';
import { readUiState, uiStatePath } from '../ui-state.js';
import { resolveCapabilities } from './capabilities.js';
import { resolveForge } from './forge/index.js';
import { fetchGithub } from './github.js';
import { ensureLaunchKey } from './launch-key.js';
import { openInTerminal } from './open-in-terminal.js';
import { agentCliRunner, detectOpenTargets, openInApp } from './open-in-app.js';
import { createDraftPr } from './pr.js';
import { ASSET_CACHE_CONTROL, BUILD_HINT_HTML, assetContentType, isSafeAssetFilename, resolveGetRequest } from './static-ui.js';

export interface ServerDeps {
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
  /** Host the HTTP server binds (default 127.0.0.1). A non-loopback host
   *  implies hosted mode — `capabilities.localHandoff:false`. */
  bindHost?: string;
}

// ---- variant-compare response shapes (spec 010) ----------------------------
// Named and exported so `api-types.test.ts` can drift-guard the cockpit's
// hand-mirrored copies (`web/app/src/api/types.ts`) against the real thing.

/** One column of `GET /api/groups/:groupId`. NOTE: `diffStat` here is the raw
 *  `git diff --stat` text (worktreeDiffStat), NOT the numeric `RunRecord.diffStat`. */
export interface GroupVariant {
  id: string;
  variant: string;
  title: string;
  status: RunStatus;
  archived: boolean;
  tokensUsed: number;
  costUsd?: number;
  diffStat: string;
  handoffExcerpt: string;
}

export interface GroupResponse {
  groupId: string;
  runs: GroupVariant[];
}

/** `POST /api/groups/:groupId/pick` — the winner, parked at `review` when it has a diff. */
export interface PickVariantResponse {
  winner?: RunRecord;
}

// A run starts from a named workflow OR an inline chain of steps (spec 008 —
// the approved plan is posted as-is, never written to a file).
const startRunSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    task: z.string().min(1),
    model: z.string().optional(),
    // Agent backend for this task (falls back to config `defaultRunner`).
    runner: z.enum(['claude', 'codex', 'opencode']).optional(),
    // Parallel variants (spec 010): ×2/×3 runs the task as 2–3 competing
    // agents in separate worktrees; the user compares diffs and picks one.
    variants: z.number().int().min(1).max(3).optional(),
    // Composer worktree opt-out (#worktree-toggle): false runs in the repo
    // working tree (read-only skills). Ignored when variants > 1.
    worktree: z.boolean().optional(),
    // Autonomous mode (#autonomous): the run never parks at `waiting` — it
    // auto-continues until the agent signals done. No "needs you" is raised.
    autonomous: z.boolean().optional(),
    // Generate follow-up inbox entries (spec 007, #444). Omitted means enabled
    // for old clients — the handoff journal is unaffected either way.
    generateFollowups: z.boolean().optional(),
    // Per-run system-prompt override (R2 2.3) — programmatic callers only
    // (bookmarklets, scripts); deliberately NOT a composer-UI control. Wins
    // over the config.json default; whitespace-only degrades to absent.
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'systemPrompt must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    // Screenshots pasted into the new-task form — same shape and limits as a
    // live-session message; delivered with the first agent step's opening.
    images: z
      .array(
        z.object({
          mediaType: z.string().regex(/^image\//),
          // ~5 MB per image once base64-decoded.
          data: z.string().min(1).max(7_000_000),
        }),
      )
      .max(4)
      .optional(),
  })
  .refine((b) => Boolean(b.workflow) !== Boolean(b.steps), {
    message: 'provide either "workflow" or "steps", not both',
  });

const pickSchema = z.object({
  runId: z.string().min(1),
});

const planSchema = z.object({
  task: z.string().trim().min(1),
});

// A saved workflow carries full `steps` OR the builder's `skills` stack
// (spec 012). `overwrite: true` is the builder's Save on an existing file —
// the GUI asks first; a plain POST still refuses to clobber.
const saveWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });

const parseWorkflowSchema = z.object({
  yaml: z.string().min(1).max(100_000),
});

// Small GUI preferences persisted in `.ai/cezar/ui-state.json` (files, not a
// DB): today just the last-used task source, so the form preselects what you
// actually run. Unknown keys pass through — future prefs won't need a schema
// dance.
const uiStateSchema = z
  .object({
    lastTask: z
      .object({ source: z.enum(['workflow', 'skill']), ref: z.string().min(1).max(200) })
      .optional(),
    // Composer picker recency (newest first, capped) + the remembered worktree
    // choice for single-skill runs. Additive prefs, like the rest of ui-state.
    recentSources: z
      .array(z.object({ source: z.enum(['workflow', 'skill']), ref: z.string().min(1).max(200) }))
      .max(50)
      .optional(),
    lastWorktree: z.boolean().optional(),
    lastAutonomous: z.boolean().optional(),
    lastGenerateFollowups: z.boolean().optional(),
    // Runs area presentation (#348): the sidebar-list + detail pane, or the
    // full-width table ("task manager") view.
    runsView: z.enum(['list', 'table']).optional(),
    // Settings → Appearance (redesign R6): accent + density. ADDITIVE — the theme itself
    // stays in the browser (`cez-theme` localStorage, pre-paint). The cockpit always PUTs
    // the whole object because the top-level merge below is shallow.
    appearance: z
      .object({
        accent: z.enum(['lime', 'violet']).optional(),
        density: z.enum(['comfortable', 'compact', 'ultra']).optional(),
      })
      .optional(),
    // Skills promo banner (#391): set once the cockpit banner is dismissed, never unset.
    // Server-persisted (not a cookie) so the "shown once" promise holds across browsers.
    dismissedSkillsBanner: z.boolean().optional(),
  })
  .passthrough();

// Editable titles (#389). `title` is the only editable field for now.
const patchRunSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
});

// Session commit (redesign R5 — §"Git/session API additions").
const gitCommitSchema = z.object({
  message: z.string().trim().min(1, 'commit message must not be empty').max(5_000),
});

const messageSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z
      .array(
        z.object({
          mediaType: z.string().regex(/^image\//),
          // ~5 MB per image once base64-decoded.
          data: z.string().min(1).max(7_000_000),
        }),
      )
      .max(4)
      .default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one image',
  });

export function createApp(deps: ServerDeps): Hono {
  const { repoRoot, store, manager, version, update, bindHost } = deps;
  const dataDir = join(repoRoot, '.ai/cezar');
  // Hosted-mode gate (spec §"Deployment modes") — read per request so
  // CEZ_REMOTE flips take effect live (and tests can toggle it).
  const capabilities = () => resolveCapabilities(process.env, bindHost);
  startTodosWatch(dataDir); // inbox live updates (spec 007)
  const launchKey = ensureLaunchKey(dataDir); // bookmarklet auto-start secret (spec 011)
  const app = new Hono();

  // ---- static GUI ----------------------------------------------------------
  const webDir = resolveWebDir();
  const distDir = join(webDir, 'dist');
  const HTML_TYPE = 'text/html; charset=utf-8';
  const staticFile = (name: string, type: string) => (): Response => {
    // Read per request — the files are tiny and this keeps dev iteration live.
    const body = readFileSync(join(webDir, name));
    return new Response(body, { headers: { 'content-type': type } });
  };

  let hintLogged = false;
  const serveShell = (c: Context): Response | undefined => {
    const distIndex = join(distDir, 'index.html');
    // existsSync per request, like the reads below: `npm run build:web` in a
    // running cockpit takes effect on the next reload, no restart.
    const target = resolveGetRequest({ path: c.req.path, distExists: existsSync(distIndex) });
    if (target === 'passthrough') return undefined;
    if (target === 'build-hint') {
      // Dev-only state (the tarball ships web/dist): serve the built-in hint
      // page instead of the app — the legacy fallback UI was deleted in R7.
      if (!hintLogged) {
        hintLogged = true;
        console.log('cezar: web/dist is missing — run `npm run build:web` to build the cockpit');
      }
      return new Response(BUILD_HINT_HTML, { headers: { 'content-type': HTML_TYPE } });
    }
    return new Response(readFileSync(distIndex), { headers: { 'content-type': HTML_TYPE } });
  };

  // Hashed bundles/fonts of the built app. Vite fingerprints every name, so
  // the bytes behind a URL never change — cache them hard. Only plain
  // filenames are served: `basename('..')` is `'..'` (it resolves to the
  // assets dir itself and readFileSync would throw EISDIR), so dot-segments
  // and separator-bearing params get a 404, not a 500.
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    if (!isSafeAssetFilename(file)) return c.json({ error: 'not found' }, 404);
    const path = join(distDir, 'assets', file);
    if (!existsSync(path) || !statSync(path).isFile()) return c.json({ error: 'not found' }, 404);
    return new Response(readFileSync(path), {
      headers: { 'content-type': assetContentType(file), 'cache-control': ASSET_CACHE_CONTROL },
    });
  });

  // The favicon web/app/index.html points at (`../open-mercato.svg`).
  app.get('/open-mercato.svg', staticFile('open-mercato.svg', 'image/svg+xml'));

  // ---- meta ----------------------------------------------------------------
  // CORS — deliberately for /api/health ONLY (spec 011): the bookmarklets
  // fetch it cross-origin from github.com to discover which local ports run a
  // cockpit and which repo each serves. Health exposes no secrets beyond the
  // repo path/remote; every other endpoint stays same-origin.
  app.use('/api/health', async (c, next) => {
    c.header('access-control-allow-origin', '*');
    if (c.req.method === 'OPTIONS') {
      // Preflight (e.g. Chrome Private Network Access) — allow the plain GET.
      c.header('access-control-allow-methods', 'GET');
      c.header('access-control-allow-private-network', 'true');
      return c.body(null, 204);
    }
    await next();
  });
  app.get('/api/health', async (c) => {
    const [checks, repo, config] = await Promise.all([
      detectEnvironment(),
      getRepoInfo(repoRoot),
      loadConfig(repoRoot),
    ]);
    // Additive fields only below — the pre-forge shape is the most
    // externally-depended-on JSON in the app (BACKWARD_COMPATIBILITY.md §2).
    const forge = resolveForge(repo);
    return c.json({
      version,
      latestVersion: update?.latest,
      repoRoot,
      repo,
      checks,
      defaultRunner: config.defaultRunner,
      // Non-blocking: cached availability or null-until-warm — health must never pay a `gh`
      // shell-out (the bookmarklet aborts its port probe at 800 ms). See detectGithubCached.
      forge: forge ? { kind: forge.kind, ...(forge.detectCached() ?? {}) } : null,
      capabilities: capabilities(),
    });
  });

  // The bookmarklet generator bakes this key into the `javascript:` URLs —
  // `/new?auto=1` is honored only with it (spec 011). Same-origin only.
  app.get('/api/launch-key', (c) => c.json({ key: launchKey }));

  app.get('/api/skills', async (c) => c.json(await discoverSkills(repoRoot)));

  // ---- GUI prefs (ui-state.json) --------------------------------------------
  // The read path is shared with the CLI (`src/ui-state.ts`) so `cezar serve` can honour a
  // preference set here — #391's dismissed skills banner — from one notion of the file.
  app.get('/api/ui-state', async (c) => c.json(await readUiState(repoRoot)));
  app.put('/api/ui-state', async (c) => {
    const parsed = uiStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const merged = { ...(await readUiState(repoRoot)), ...parsed.data };
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(uiStatePath(repoRoot), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return c.json(merged);
  });

  // Refresh team skills (spec 005): clone/fetch the configured skills repos,
  // then return the merged catalog. Degrades quietly — offline just means the
  // team entries stay as they were (or absent).
  app.post('/api/skills/refresh', async (c) => {
    await refreshTeamSkills(repoRoot);
    return c.json(await discoverSkills(repoRoot));
  });

  app.get('/api/workflows', async (c) => c.json(await loadWorkflows(repoRoot)));

  // Save an approved plan as a reusable chain (spec 008): YAML in
  // `.ai/cezar/workflows/<slug>.yaml` — from then on it's in the dropdown
  // like any other workflow.
  app.post('/api/workflows', async (c) => {
    const parsed = saveWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const steps = parsed.data.steps ?? skillsToSteps(parsed.data.skills ?? []);
    const issue = stepsIssue(steps);
    if (issue) return c.json({ error: issue }, 400);
    const slug = slugify(parsed.data.name) || 'chain';
    const dir = join(repoRoot, WORKFLOWS_DIR);
    const path = join(dir, `${slug}.yaml`);
    // Pure skill stacks are written in the portable compact form (spec 012) —
    // `name` + `skills:` — so the file imports cleanly in any repo.
    const stack = skillStackOf(steps);
    const doc = {
      name: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(stack ? { skills: stack } : { steps }),
    };
    try {
      await mkdir(dir, { recursive: true });
      // `wx` = fail if the file exists — no silent overwrite of a chain.
      await writeFile(path, stringifyYaml(doc), {
        encoding: 'utf8',
        flag: parsed.data.overwrite ? 'w' : 'wx',
      });
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        return c.json({ error: `workflow file already exists: ${path}`, exists: true }, 409);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
    return c.json({ path, name: parsed.data.name }, 201);
  });

  // Delete a saved workflow (spec 012 follow-up): file workflows only —
  // built-ins have no file and always come back.
  app.delete('/api/workflows/:name', async (c) => {
    const name = c.req.param('name');
    const { workflows } = await loadWorkflows(repoRoot);
    const wf = workflows.find((w) => w.name === name);
    if (!wf) return c.json({ error: `unknown workflow: ${name}` }, 404);
    if (wf.source !== 'file' || !wf.path) {
      return c.json({ error: 'built-in workflows cannot be deleted' }, 400);
    }
    const dir = resolve(repoRoot, WORKFLOWS_DIR);
    const target = resolve(wf.path);
    if (!target.startsWith(dir + sep)) {
      return c.json({ error: 'refusing to delete a file outside the workflows dir' }, 400);
    }
    try {
      await unlink(target);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return c.json({ ok: true, path: target });
  });

  // Import support for the builder (spec 012): parse + validate a pasted
  // workflow YAML (either form) and hand back the normalized definition. The
  // server owns YAML parsing — the GUI stays dependency-free.
  app.post('/api/workflows/parse', async (c) => {
    const parsed = parseWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    let raw: unknown;
    try {
      raw = parseYaml(parsed.data.yaml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `not valid YAML: ${message}` }, 400);
    }
    const doc = workflowFileSchema.safeParse(raw);
    if (!doc.success) {
      return c.json({ error: doc.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const normalized = normalizeWorkflowDoc(doc.data);
    const issue = stepsIssue(normalized.steps);
    if (issue) return c.json({ error: issue }, 400);
    return c.json(normalized);
  });

  // Chain-from-prompt (spec 008): one cheap claude call proposes a chain of
  // steps for the task. Never blocks — degraded answers come back as a
  // one-step quick-task plan with `fallback: true`.
  app.post('/api/plan', async (c) => {
    const parsed = planSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    return c.json(await planChain(repoRoot, parsed.data.task));
  });

  // ---- runs ----------------------------------------------------------------

  // Additive `usage` field (#348): the latest CPU/RSS/proc-count sample of the
  // run's live process tree — absent for finished runs and when `ps` yields
  // nothing. The stored record itself is never touched.
  const withUsage = (run: RunRecord): RunRecord & { usage?: ReturnType<typeof currentUsage> } => {
    const usage = currentUsage(run.id);
    return usage ? { ...run, usage } : run;
  };

  app.get('/api/runs', (c) => c.json(store.listRuns().map(withUsage)));

  // Registered before the `/:id/...` routes so "archive-finished" never
  // matches as a run id.
  app.post('/api/runs/archive-finished', (c) => c.json({ archived: store.archiveFinished() }));

  app.post('/api/runs/:id/archive', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    const run = store.setArchived(id, body.archived !== false);
    return run ? c.json(run) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/runs', async (c) => {
    const parsed = startRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    let workflow: WorkflowDef | undefined;
    if (parsed.data.steps) {
      // Inline chain (spec 008): an approved plan runs as an ad-hoc workflow.
      const issue = stepsIssue(parsed.data.steps);
      if (issue) return c.json({ error: issue }, 400);
      workflow = { name: '(planned)', source: 'built-in', steps: parsed.data.steps };
    } else {
      const { workflows } = await loadWorkflows(repoRoot);
      workflow = workflows.find((w) => w.name === parsed.data.workflow);
      if (!workflow) return c.json({ error: `unknown workflow: ${parsed.data.workflow}` }, 404);
    }
    const images = parsed.data.images?.map(
      (img): ContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }),
    );
    const input = {
      task: parsed.data.task,
      model: parsed.data.model,
      runner: parsed.data.runner,
      images,
      systemPrompt: parsed.data.systemPrompt,
      worktree: parsed.data.worktree,
      autonomous: parsed.data.autonomous,
      generateFollowups: parsed.data.generateFollowups,
    };
    const variants = parsed.data.variants ?? 1;
    if (variants > 1) {
      // Variants live in worktrees — without git there's nothing to isolate
      // them with, so this degrades to a clear 400 instead of stepping on
      // one shared working tree.
      const repo = await getRepoInfo(repoRoot);
      if (!repo) {
        return c.json(
          { error: 'parallel variants need a git repository (each variant runs in its own worktree) — run ×1 here, or start cezar inside a git repo' },
          400,
        );
      }
      return c.json({ runs: manager.startVariants(workflow, input, variants) }, 201);
    }
    const run = manager.startRun(workflow, input);
    return c.json(run, 201);
  });

  // ---- parallel variants (spec 010) -----------------------------------------

  const groupRuns = (groupId: string): RunRecord[] =>
    store
      .listRuns()
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));

  // Comparison data: per variant the status, cost, `git diff --stat` and the
  // first Progress-log lines from the handoff. The full diff is fetched per
  // variant via the existing GET /api/runs/:id/diff.
  app.get('/api/groups/:groupId', async (c) => {
    const runs = groupRuns(c.req.param('groupId'));
    if (runs.length === 0) return c.json({ error: 'not found' }, 404);
    const detailed = await Promise.all(
      runs.map(
        async (r): Promise<GroupVariant> => ({
          id: r.id,
          variant: r.variant ?? '?',
          title: r.title,
          status: r.status,
          archived: r.archived,
          tokensUsed: r.tokensUsed,
          costUsd: r.costUsd,
          diffStat:
            r.worktreePath && existsSync(r.worktreePath)
              ? await worktreeDiffStat(r.worktreePath, r.baseBranch ?? 'HEAD')
              : '',
          handoffExcerpt: handoffProgressExcerpt(readHandoff(dataDir, r.id)),
        }),
      ),
    );
    return c.json({ groupId: c.req.param('groupId'), runs: detailed } satisfies GroupResponse);
  });

  // "Pick this one": the winner rests at `review` (spec 009 takes it from
  // there — send back / draft PR / finish); the losers are cancelled if
  // alive, archived, and their worktrees + branches removed.
  app.post('/api/groups/:groupId/pick', async (c) => {
    const runs = groupRuns(c.req.param('groupId'));
    if (runs.length === 0) return c.json({ error: 'not found' }, 404);
    const parsed = pickSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const winner = runs.find((r) => r.id === parsed.data.runId);
    if (!winner) return c.json({ error: 'runId is not part of this group' }, 404);
    if (manager.isActive(winner.id)) {
      return c.json({ error: 'this variant is still active — wait for it to finish first' }, 409);
    }

    // Winner: a non-review terminal state with a non-empty diff flips to
    // `review` (the settleSuccess rule); an empty diff (or no worktree) stays.
    if (winner.status !== 'review' && winner.worktreePath && existsSync(winner.worktreePath)) {
      const diff = await worktreeDiff(winner.worktreePath, winner.baseBranch ?? 'HEAD');
      if (diff.trim().length > 0 && !diff.startsWith('(diff failed')) {
        store.updateRun(winner.id, { status: 'review' });
      }
    }
    const losers = runs.filter((r) => r.id !== winner.id);
    store.appendEvent(winner.id, {
      type: 'lifecycle',
      message: `picked from ${runs.length} variants — ${losers.length} other variant(s) archived`,
    });
    appendHandoffHeartbeat(dataDir, winner.id, `picked from ${runs.length} variants`);

    for (const loser of losers) {
      if (manager.isActive(loser.id)) manager.cancel(loser.id);
      if (loser.worktreePath) await removeWorktree(repoRoot, loser.worktreePath, loser.branch);
      store.updateRun(loser.id, { worktreePath: undefined, branch: undefined });
      store.setArchived(loser.id, true);
      store.appendEvent(loser.id, {
        type: 'lifecycle',
        message: `variant ${winner.variant ?? '?'} was picked — this variant is archived, its worktree removed`,
      });
    }
    return c.json({ winner: store.getRun(winner.id) } satisfies PickVariantResponse);
  });

  app.get('/api/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    return run ? c.json(withUsage(run)) : c.json({ error: 'not found' }, 404);
  });

  // Editable titles (#389). The UI displays `titleSummary ?? title`, so a
  // user edit sets BOTH: `title` (the record's own name — the raw task stops
  // being it the moment the user renames the run) and `titleSummary` (what
  // actually displays). The auto-summarizer only ever fills an *unset*
  // titleSummary (RunManager.recordTurnEnd), so an edit wins over any past or
  // future auto-summary. Answers the updated record.
  app.patch('/api/runs/:id', async (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const parsed = patchRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    if (parsed.data.title !== undefined) {
      store.updateRun(id, { title: parsed.data.title, titleSummary: parsed.data.title });
    }
    return c.json(store.getRun(id));
  });

  app.post('/api/runs/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const cancelled = manager.cancel(id);
    return c.json({ cancelled });
  });

  // Live-session participation (spec 002): deliver a user message (text +
  // pasted screenshots) into the run's open claude session.
  app.post('/api/runs/:id/messages', async (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const parsed = messageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const content: ContentBlock[] = [
      ...parsed.data.images.map(
        (img): ContentBlock => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        }),
      ),
      ...(parsed.data.text.trim()
        ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock]
        : []),
    ];
    const delivered = manager.sendMessage(id, content);
    if (!delivered) return c.json({ error: 'session closed' }, 409);
    return c.json({ delivered: true });
  });

  // "Finish": gracefully close a waiting session — the run completes as done.
  app.post('/api/runs/:id/finish', (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const finished = manager.finish(id);
    if (!finished) return c.json({ error: 'no open session' }, 409);
    return c.json({ finished: true });
  });

  // "Continue" (spec 003): reopen a finished run's session in-process.
  app.post('/api/runs/:id/continue', async (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const result = manager.continueRun(id, typeof body.text === 'string' ? body.text : undefined);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ continued: true });
  });

  // "Open in terminal" (spec 003): hand the session off to a real terminal —
  // in the task's worktree when it still exists (spec 006).
  app.post('/api/runs/:id/open-in-cli', async (c) => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    // Hosted mode: there is no "my machine" to open a terminal on. The UI
    // hides the button when localHandoff is false — this is defense in depth.
    if (!capabilities().localHandoff) {
      return c.json(
        { error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE); resume the session from a machine that has the checkout' },
        409,
      );
    }
    const sessionId = [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
    if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
    const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;
    const command = resumeCommand(run.runner, sessionId);
    const opened = await openInTerminal(cwd, command);
    if (!opened) {
      return c.json({ error: 'no terminal emulator found', command: `cd '${cwd}' && ${command}` }, 409);
    }
    return c.json({ opened: true, command });
  });

  // "Open in…" session takeover (#open-in): the editors/file-manager/terminal
  // detected on THIS machine. Empty in hosted mode (no local desktop to open).
  app.get('/api/open-targets', (c) =>
    c.json({ targets: capabilities().localHandoff ? detectOpenTargets() : [] }),
  );

  // Open a run's worktree (or the repo root) in the chosen local app.
  app.post('/api/runs/:id/open-in', async (c) => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    if (!capabilities().localHandoff) {
      return c.json(
        { error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { target?: unknown };
    const target = typeof body.target === 'string' ? body.target : '';
    if (!target) return c.json({ error: 'target required' }, 400);
    const dir = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;

    // Coding-agent CLI handoff (#cli-handoff): open a terminal in the worktree that resumes THIS
    // run's session when the chosen CLI is the run's own runner (and a session exists), or starts
    // a fresh CLI there otherwise. Same terminal launcher the Terminal button uses.
    const cliRunner = agentCliRunner(target);
    if (cliRunner) {
      const sessionId = [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
      const command =
        sessionId && cliRunner === run.runner ? resumeCommand(cliRunner, sessionId) : cliRunner;
      const opened = await openInTerminal(dir, command);
      if (!opened) {
        return c.json({ error: 'no terminal emulator found', command: `cd '${dir}' && ${command}` }, 409);
      }
      return c.json({ opened: true, path: dir, command });
    }

    const opened = await openInApp(target, dir);
    if (!opened) return c.json({ error: `could not open ${target}`, path: dir }, 409);
    return c.json({ opened: true, path: dir });
  });

  // Handoff journal (spec 007): the per-task handoff.md as markdown. 404 only
  // when the task is unknown; a task without a (yet) seeded file returns ''.
  app.get('/api/runs/:id/handoff', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.text(readHandoff(dataDir, run.id), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    });
  });

  // Agent screenshots — image blocks the run manager persisted out of tool
  // results (persistImage). `basename` pins reads inside the run's own dir.
  const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  app.get('/api/runs/:id/images/:file', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const file = basename(c.req.param('file'));
    const path = join(dataDir, 'runs', `${run.id}-images`, file);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    const type = IMAGE_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream';
    return new Response(readFileSync(path), {
      headers: { 'content-type': type, 'cache-control': 'private, max-age=31536000, immutable' },
    });
  });

  // Task diff (spec 006): what this run changed — its worktree vs its base.
  app.get('/api/runs/:id/diff', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    if (!run.worktreePath || !existsSync(run.worktreePath)) {
      return c.text('(no worktree — this task ran directly in the repo working tree)');
    }
    return c.text(await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD'));
  });

  // ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
  // Structured sibling of the text-blob /diff above (which stays untouched —
  // protected surface). Same worktree/base resolution; every predictable git
  // failure degrades to 409 + human-readable reason, 404 only for unknown ids.
  const worktreeOf = (run: RunRecord): string | null =>
    run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
  const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

  app.get('/api/runs/:id/changes', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const result = await collectChanges(worktree, run.baseBranch ?? 'HEAD');
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json(result.changes);
  });

  // The run's own commits (<base>..HEAD on the worktree branch) — the Commits tab.
  app.get('/api/runs/:id/commits', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const result = await collectRunCommits(worktree, run.baseBranch ?? 'HEAD');
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ commits: result.commits });
  });

  // One of the run's commits, structured like the Changes tab (reuses collectCommitChanges).
  app.get('/api/runs/:id/commit/:sha', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const result = await collectCommitChanges(worktree, c.req.param('sha'));
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json(result.commit);
  });

  // Files tab: directory listing (path omitted or a dir) or file content
  // (size-capped, binary flagged). Traversal-safe — readWorktreePath rejects
  // anything escaping the worktree. `raw=1` (R5 Step 1.6) serves the BYTES of
  // image files only, for the preview's inline <img> — never HTML/JS/etc., so
  // no worktree file can become a same-origin document, and never past the
  // size cap. The no-script CSP neutralizes SVG opened as a top-level URL.
  app.get('/api/runs/:id/files', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const result = await readWorktreePath(worktree, c.req.query('path') ?? '');
    if (result.kind === 'invalid' || result.kind === 'missing') {
      return c.json({ error: result.error }, 409);
    }
    if (result.kind === 'dir') {
      return c.json({ type: 'dir', path: result.path, entries: result.entries });
    }
    if (c.req.query('raw') === '1') {
      const mime = imageMimeType(result.path);
      if (!mime) return c.json({ error: `raw serving is limited to images: ${result.path}` }, 409);
      if (result.tooLarge) {
        return c.json({ error: `file too large to serve raw (${result.size} bytes): ${result.path}` }, 409);
      }
      const bytes = await readFile(join(worktree, result.path));
      return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
        'content-type': mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
    }
    return c.json({
      type: 'file',
      path: result.path,
      size: result.size,
      binary: result.binary,
      tooLarge: result.tooLarge,
      ...(result.content !== undefined ? { content: result.content } : {}),
    });
  });

  app.post('/api/runs/:id/git/commit', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const parsed = gitCommitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const result = await commitAll(worktree, parsed.data.message);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ committed: true, sha: result.sha });
  });

  app.post('/api/runs/:id/git/push', async (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const worktree = worktreeOf(run);
    if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
    const result = await pushCurrentBranch(worktree);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ pushed: true, branch: result.branch, remote: result.remote, upstreamSet: result.upstreamSet });
  });

  // Draft PR from the review gate (spec 009): final autosave → push →
  // `gh pr create --draft`; on success the run completes as done with the PR
  // badge. Failures come back as 409 with a `manual` merge command the GUI
  // shows next to the toast. CEZ_DRY_RUN=1 fakes the URL (no push, no gh).
  app.post('/api/runs/:id/pr', async (c) => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    if (manager.isActive(id)) return c.json({ error: 'run is still active — wait for the review gate' }, 409);
    if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
      return c.json({ error: 'no worktree/branch to publish — this task ran in the repo working tree' }, 400);
    }
    const outcome = await createDraftPr({ repoRoot, run, handoffText: readHandoff(dataDir, id) });
    if (!outcome.ok) {
      return c.json({ error: outcome.error, manual: `git merge ${run.branch}` }, 409);
    }
    store.updateRun(id, {
      pullRequestUrl: outcome.url,
      status: 'done',
      finishedAt: run.finishedAt ?? new Date().toISOString(),
    });
    store.appendEvent(id, {
      type: 'note',
      message: `draft PR created: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
    });
    return c.json({ url: outcome.url, dryRun: outcome.dryRun }, 201);
  });

  // Archived tasks keep their worktree for inspection; this is the explicit
  // "🧹 Remove worktree" cleanup (spec 006).
  app.post('/api/runs/:id/remove-worktree', async (c) => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
    if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
    store.updateRun(id, { worktreePath: undefined, branch: undefined });
    return c.json({ removed: true });
  });

  app.delete('/api/runs/:id', async (c) => {
    const id = c.req.param('id');
    if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    // Delete cleans up after itself: worktree + branch go with the run (spec 006).
    if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
    return store.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'not found' }, 404);
  });

  // ---- inbox (spec 007) ------------------------------------------------------
  app.get('/api/todos', async (c) => c.json(await readTodos(dataDir)));

  // Check off = delete the entry.
  app.delete('/api/todos/:id', async (c) => {
    const removed = await removeTodo(dataDir, c.req.param('id'));
    return removed ? c.json({ removed: true }) : c.json({ error: 'not found' }, 404);
  });

  // "▶ Run": turn an inbox entry into a task — a one-off single-step workflow
  // around the suggested skill when it exists, plain quick-task otherwise.
  app.post('/api/todos/:id/start', async (c) => {
    const id = c.req.param('id');
    const todo = (await readTodos(dataDir)).find((t) => t.id === id);
    if (!todo) return c.json({ error: 'not found' }, 404);
    if (todo.startedTaskId) return c.json({ error: 'already started' }, 409);

    let task = (todo.suggestedPrompt ?? todo.summary).trim() || todo.summary;
    if (todo.suggestedArgs) task += `\n\nArguments: ${todo.suggestedArgs}`;

    let workflow: WorkflowDef | undefined;
    if (todo.suggestedSkill) {
      const skills = await discoverSkills(repoRoot);
      if (skills.some((s) => s.name === todo.suggestedSkill)) {
        workflow = {
          name: '(inbox)',
          description: `Follow-up from the inbox — skill "${todo.suggestedSkill}"`,
          source: 'built-in',
          steps: [{ id: 'task', name: 'Do the task', skill: todo.suggestedSkill, prompt: '{{task}}' }],
        };
      }
    }
    if (!workflow) {
      const { workflows } = await loadWorkflows(repoRoot);
      workflow = workflows.find((w) => w.name === 'quick-task') ?? QUICK_TASK_WORKFLOW;
    }

    const run = manager.startRun(workflow, { task });
    await markStarted(dataDir, id, run.id);
    return c.json({ run }, 201);
  });

  // Per-run SSE: full replay from the NDJSON file, then live events. The
  // listener attaches before the replay and buffers, so nothing emitted
  // during the replay is lost or duplicated (dedup by seq).
  app.get('/api/runs/:id/events', (c) => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      let replaying = true;
      let maxSeq = 0;
      const buffered: RunEvent[] = [];
      // One endpoint, two SSE event names: v1 lines stay `run-event` (the name
      // the legacy UI listened to — its default branch JSON-dumped unknown
      // types into the transcript, which is why v2 never rode that name; the
      // split outlives the R7 retirement as wire shape); protocol-v2 lines
      // (dotted types, persisted snapshots AND ephemeral coalesced deltas)
      // ride `ui-event`, which only v2-aware clients subscribe to.
      // EventSource ignores names it has no listener for.
      const writeEvent = (event: RunEvent) =>
        stream.writeSSE({
          event: isV2WireEventType(event.type) ? 'ui-event' : 'run-event',
          data: JSON.stringify(event),
        });
      const onEvent = (payload: { runId: string; event: RunEvent }) => {
        if (payload.runId !== id) return;
        if (replaying) buffered.push(payload.event);
        else void writeEvent(payload.event);
      };
      const onRun = (run: RunRecord) => {
        if (run.id !== id) return;
        void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
      };
      store.on('event', onEvent);
      store.on('run', onRun);
      stream.onAbort(() => {
        store.off('event', onEvent);
        store.off('run', onRun);
      });

      for (const event of store.readEvents(id)) {
        maxSeq = Math.max(maxSeq, event.seq);
        await writeEvent(event);
      }
      replaying = false;
      for (const event of buffered) {
        if (event.seq > maxSeq) await writeEvent(event);
      }
      const run = store.getRun(id);
      if (run) await stream.writeSSE({ event: 'run', data: JSON.stringify(run) });

      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  // Global SSE: run-summary updates for the list view + inbox changes.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const onRun = (run: RunRecord) =>
        void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
      const onDeleted = (id: string) =>
        void stream.writeSSE({ event: 'run-deleted', data: JSON.stringify({ id }) });
      const sendTodos = async () => {
        const items: TodoItem[] = await readTodos(dataDir).catch(() => []);
        await stream.writeSSE({ event: 'todos', data: JSON.stringify(items) });
      };
      const offTodos = onTodosChanged(() => void sendTodos());
      // Live resource telemetry (#348): the sampler ticks ~every 2 s only
      // while some run has a registered process; each tick is relayed as one
      // `usage` message (runId → {cpuPct, rssBytes, procCount}). Never
      // persisted — the NDJSON transcripts stay usage-free.
      const offUsage = onUsage(
        (usage) => void stream.writeSSE({ event: 'usage', data: JSON.stringify(usage) }),
      );
      store.on('run', onRun);
      store.on('deleted', onDeleted);
      stream.onAbort(() => {
        store.off('run', onRun);
        store.off('deleted', onDeleted);
        offTodos();
        offUsage();
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    }),
  );

  // ---- GitHub tab ------------------------------------------------------------
  // Issues + PRs of the repo's origin, read through the logged-in `gh` CLI.
  // Degrades to `{available:false, reason}` — no gh / no remote / offline all
  // just render as a hint in the tab, never an error.
  app.get('/api/github', async (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    return c.json(
      await fetchGithub(repoRoot, c.req.query('refresh') === '1', Number.isFinite(limit) ? limit : 30),
    );
  });

  // ---- repo view -----------------------------------------------------------
  app.get('/api/repo', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.json({ info: null, status: [], log: [], branches: [], baseBranch: null });
    const [status, log, branches, config] = await Promise.all([
      getStatus(info.root),
      getLog(info.root),
      getBranches(info.root),
      loadConfig(repoRoot),
    ]);
    return c.json({ info, status, log, branches, baseBranch: config.baseBranch ?? null });
  });

  // The Settings → Agents knobs in one read (R6 Step 1.5) — an ADDITIVE
  // sibling of PUT /api/config below; /api/health keeps its protected shape.
  const configAnswer = (config: CezConfig) => ({
    baseBranch: config.baseBranch ?? null,
    defaultRunner: config.defaultRunner,
    systemPrompt: config.systemPrompt ?? null,
    defaultModels: config.defaultModels ?? {},
    maxParallel: config.maxParallel,
    memoryLimitMb: config.memoryLimitMb ?? null,
  });
  app.get('/api/config', async (c) => c.json(configAnswer(await loadConfig(repoRoot))));

  // Set/clear the agents' config knobs (Settings → Agents; the Repo tab's
  // base-branch picker). Merges into the RAW config.json so user keys
  // (skillsRepos…) survive and schema defaults are never materialized into
  // the file. All fields optional + additive: `null` (and `''` for the
  // R6 keys) clears a knob back to its default.
  const modelPresetSchema = z.string().trim().max(200).nullable().optional();
  const setConfigSchema = z.object({
    baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
    defaultRunner: z.enum(['claude', 'codex', 'opencode']).optional(),
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'systemPrompt must be at most 20000 characters')
      .nullable()
      .optional(),
    defaultModels: z
      .object({ claude: modelPresetSchema, codex: modelPresetSchema, opencode: modelPresetSchema })
      .optional(),
    // Concurrency + memory guard (Settings → Resources). maxParallel clamps to
    // the schema's 1–16; memoryLimitMb null/0 clears the ceiling.
    maxParallel: z.number().int().min(1).max(16).optional(),
    memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
  });
  app.put('/api/config', async (c) => {
    const parsed = setConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const configPath = join(dataDir, 'config.json');
    let raw: Record<string, unknown> = {};
    try {
      const existing: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (existing && typeof existing === 'object') raw = existing as Record<string, unknown>;
    } catch {
      // missing or malformed — start fresh
    }
    if (parsed.data.baseBranch !== undefined) {
      if (parsed.data.baseBranch === null) delete raw.baseBranch;
      else raw.baseBranch = parsed.data.baseBranch;
    }
    if (parsed.data.defaultRunner !== undefined) raw.defaultRunner = parsed.data.defaultRunner;
    if (parsed.data.systemPrompt !== undefined) {
      // '' and null both clear: an emptied textarea means "no extra prompt".
      if (parsed.data.systemPrompt === null || parsed.data.systemPrompt === '') {
        delete raw.systemPrompt;
      } else {
        raw.systemPrompt = parsed.data.systemPrompt;
      }
    }
    if (parsed.data.maxParallel !== undefined) raw.maxParallel = parsed.data.maxParallel;
    if (parsed.data.memoryLimitMb !== undefined) {
      // null or 0 both mean "no ceiling" — drop the key back to the default.
      if (parsed.data.memoryLimitMb === null || parsed.data.memoryLimitMb === 0) {
        delete raw.memoryLimitMb;
      } else {
        raw.memoryLimitMb = parsed.data.memoryLimitMb;
      }
    }
    if (parsed.data.defaultModels !== undefined) {
      // Per-runner merge, so setting codex's preset never clobbers claude's.
      const current =
        raw.defaultModels && typeof raw.defaultModels === 'object'
          ? { ...(raw.defaultModels as Record<string, unknown>) }
          : {};
      for (const [runner, model] of Object.entries(parsed.data.defaultModels)) {
        if (model === undefined) continue;
        if (model === null || model === '') delete current[runner];
        else current[runner] = model;
      }
      if (Object.keys(current).length === 0) delete raw.defaultModels;
      else raw.defaultModels = current;
    }
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    // Pre-R6 answer shape ({baseBranch, defaultRunner}) + additive R6 fields.
    return c.json(configAnswer(await loadConfig(repoRoot)));
  });

  app.get('/api/repo/diff', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.text('not a git repository');
    return c.text(await getDiff(info.root));
  });

  // One commit's message + stat + patch — the Repo view expands it inline.
  // `?structured=1` is the ADDITIVE sibling (R5 Step 1.7): the new repo view's commit-diff
  // shape `{sha, subject, author, when, files, stat}` with 409 + reason on failure. The
  // legacy text answer below is a protected surface (BACKWARD_COMPATIBILITY.md §2) — its
  // shape, including the in-band failure sentences, stays exactly as it was.
  app.get('/api/repo/commit/:sha', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (c.req.query('structured') === '1') {
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const result = await collectCommitChanges(info.root, c.req.param('sha'));
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.commit);
    }
    if (!info) return c.text('not a git repository');
    try {
      return c.text(await getCommit(info.root, c.req.param('sha')));
    } catch (err) {
      return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  });

  // Structured sibling of the text-blob /api/repo/diff above (protected
  // surface, untouched): the same {files, stat} shape the session /changes
  // route serves, here for the MAIN working tree's uncommitted changes vs
  // HEAD (redesign R5 Step 1.3 — §"Git/session API additions").
  app.get('/api/repo/changes', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.json({ error: 'not a git repository' }, 409);
    // The user's REAL working tree — never stage into their index (a GET must not write).
    const result = await collectChanges(info.root, 'HEAD', { intentToAdd: false });
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json(result.changes);
  });

  // Repo view branch actions: switch to an existing branch, or create one
  // (from `from` or HEAD) and switch. Predictable git failures — invalid
  // name, unknown `from`, dirty-tree checkout conflict — are 409 + reason.
  const repoBranchSchema = z.object({
    name: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1).max(200).optional(),
  });
  app.post('/api/repo/branch', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.json({ error: 'not a git repository' }, 409);
    const parsed = repoBranchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const result = await createOrSwitchBranch(info.root, parsed.data.name, parsed.data.from);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ branch: result.branch, created: result.created });
  });

  // ---- SPA catch-all -------------------------------------------------------
  // Last, so every route above still wins. Any other GET gets the cockpit shell:
  // react-router owns the route map, including the 404, so `/tasks/:id/changes`
  // cold-loads and survives a refresh instead of 404ing. `/api/*` and the static
  // files above resolve to `passthrough` and fall through to Hono's own 404 —
  // an unknown API path must never answer with HTML.
  // Without a web/dist build this serves the built-in build-hint page (dev-only
  // state — the published tarball ships web/dist), never a 404.
  app.get('*', (c) => serveShell(c) ?? c.notFound());

  return app;
}

export function startServer(deps: ServerDeps, port: number): ServerType {
  const app = createApp(deps);
  // SECURITY: default to loopback. This server executes agents locally and its endpoints are
  // same-origin-trusted (only /api/health is CORS-open); binding to a non-loopback host would
  // expose an agent-executing box to the network. `bindHost` exists only for a deliberate
  // hosted/VPS deployment (which also flips CEZ_REMOTE to gate the local-handoff endpoints) —
  // src/index.ts never passes it, so the loopback guarantee holds for the normal CLI.
  return serve({ fetch: app.fetch, port, hostname: deps.bindHost ?? '127.0.0.1' });
}

function resolveWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/server (built) or <pkg>/src/server (tsx dev).
  return join(here, '..', '..', 'web');
}

/** The CLI command that reopens a run's session for interactive take-over,
 *  per backend. Legacy/undefined records default to Claude. */
function resumeCommand(runner: string | undefined, sessionId: string): string {
  switch (runner) {
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    default:
      return `claude --resume ${sessionId}`;
  }
}
