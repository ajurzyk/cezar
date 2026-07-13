import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { detectEnvironment } from '../core/backend-detect.js';
import type { ContentBlock } from '../core/agent-runner.js';
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
import type { RunEvent, RunRecord, RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { removeWorktree, worktreeDiff, worktreeDiffStat } from '../git-worktree.js';
import { getBranches, getCommit, getDiff, getLog, getRepoInfo, getStatus } from './git.js';
import { loadConfig } from '../config.js';
import { fetchGithub } from './github.js';
import { ensureLaunchKey } from './launch-key.js';
import { openInTerminal } from './open-in-terminal.js';
import { createDraftPr } from './pr.js';

export interface ServerDeps {
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
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
  })
  .passthrough();

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
  const { repoRoot, store, manager, version, update } = deps;
  const dataDir = join(repoRoot, '.ai/cezar');
  startTodosWatch(dataDir); // inbox live updates (spec 007)
  const launchKey = ensureLaunchKey(dataDir); // bookmarklet auto-start secret (spec 011)
  const app = new Hono();

  // ---- static GUI ----------------------------------------------------------
  const webDir = resolveWebDir();
  const staticFile = (name: string, type: string) => (): Response => {
    // Read per request — the files are tiny and this keeps dev iteration live.
    const body = readFileSync(join(webDir, name));
    return new Response(body, { headers: { 'content-type': type } });
  };
  app.get('/', staticFile('index.html', 'text/html; charset=utf-8'));
  // Deep-link target for the bookmarklets (spec 011) — same SPA, the query
  // string (`?skill=…&ref=…&auto=…&key=…`) is handled by web/app.js init().
  app.get('/new', staticFile('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', staticFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/style.css', staticFile('style.css', 'text/css; charset=utf-8'));
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
    return c.json({
      version,
      latestVersion: update?.latest,
      repoRoot,
      repo,
      checks,
      defaultRunner: config.defaultRunner,
    });
  });

  // The bookmarklet generator bakes this key into the `javascript:` URLs —
  // `/new?auto=1` is honored only with it (spec 011). Same-origin only.
  app.get('/api/launch-key', (c) => c.json({ key: launchKey }));

  app.get('/api/skills', async (c) => c.json(await discoverSkills(repoRoot)));

  // ---- GUI prefs (ui-state.json) --------------------------------------------
  const uiStatePath = join(dataDir, 'ui-state.json');
  const readUiState = async (): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(uiStatePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  app.get('/api/ui-state', async (c) => c.json(await readUiState()));
  app.put('/api/ui-state', async (c) => {
    const parsed = uiStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const merged = { ...(await readUiState()), ...parsed.data };
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(uiStatePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
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
  app.get('/api/runs', (c) => c.json(store.listRuns()));

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
    const input = { task: parsed.data.task, model: parsed.data.model, runner: parsed.data.runner, images };
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
      runs.map(async (r) => ({
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
      })),
    );
    return c.json({ groupId: c.req.param('groupId'), runs: detailed });
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
    return c.json({ winner: store.getRun(winner.id) });
  });

  app.get('/api/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    return run ? c.json(run) : c.json({ error: 'not found' }, 404);
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
      const writeEvent = (event: RunEvent) =>
        stream.writeSSE({ event: 'run-event', data: JSON.stringify(event) });
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
      store.on('run', onRun);
      store.on('deleted', onDeleted);
      stream.onAbort(() => {
        store.off('run', onRun);
        store.off('deleted', onDeleted);
        offTodos();
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

  // Set/clear the agents' base branch (Repo tab). Merges into the RAW
  // config.json so user keys (skillsRepos…) survive and schema defaults are
  // never materialized into the file.
  const setConfigSchema = z.object({
    baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
    defaultRunner: z.enum(['claude', 'codex', 'opencode']).optional(),
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
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    const config = await loadConfig(repoRoot);
    return c.json({ baseBranch: config.baseBranch ?? null, defaultRunner: config.defaultRunner });
  });

  app.get('/api/repo/diff', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.text('not a git repository');
    return c.text(await getDiff(info.root));
  });

  // One commit's message + stat + patch — the Repo view expands it inline.
  app.get('/api/repo/commit/:sha', async (c) => {
    const info = await getRepoInfo(repoRoot);
    if (!info) return c.text('not a git repository');
    try {
      return c.text(await getCommit(info.root, c.req.param('sha')));
    } catch (err) {
      return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  });

  return app;
}

export function startServer(deps: ServerDeps, port: number): ServerType {
  const app = createApp(deps);
  return serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
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
