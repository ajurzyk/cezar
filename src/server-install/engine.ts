import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cezarHomeDir } from '../paths.js';
import { acquireLock, isResolved, loadServerState, saveServerState } from './state.js';
import { StepAborted, StepCancelled, StepSkipped, defaultRunner } from './steps.js';
import { createAutoUi, createClackUi } from './ui.js';
import {
  CANCEL,
  PreflightError,
  type InstallContext,
  type PlatformStrategy,
  type Runner,
  type ServerState,
  type Ui,
} from './types.js';

/**
 * The engine — pure control flow over a strategy's ordered steps. It never
 * knows what a step *does*, only `check`/`run`/`undo`. `runInstall` resumes
 * from `~/.cezar/server.json` (skips resolved steps unless `--reconfigure`
 * names them); `runUninstall` walks completed steps in reverse. Both hold the
 * single-writer lock for their whole run.
 */

export interface RunOptions {
  dryRun: boolean;
  assumeYes: boolean;
  reconfigure: ReadonlySet<string>;
  repoRoot: string;
  /** ISO timestamp from the caller (Date.now is guarded in some contexts). */
  now: string;
  ui?: Ui;
  runner?: Runner;
}

export type RunStatus = 'complete' | 'cancelled' | 'failed';
export interface RunResult {
  status: RunStatus;
  state: ServerState;
}

function buildContext(state: ServerState, opts: RunOptions): InstallContext {
  const ui = opts.ui ?? (opts.dryRun || opts.assumeYes ? createAutoUi({}, (m) => console.log(m)) : createClackUi());
  return {
    state,
    ui,
    runner: opts.runner ?? defaultRunner,
    save: async () => saveServerState(state),
    dryRun: opts.dryRun,
    assumeYes: opts.assumeYes,
    reconfigure: opts.reconfigure,
    repoRoot: opts.repoRoot,
    now: opts.now,
  };
}

export async function runInstall(strategy: PlatformStrategy, opts: RunOptions): Promise<RunResult> {
  const release = acquireLock();
  try {
    const state = loadServerState();
    if (state.platform && state.platform !== strategy.id) {
      throw new PreflightError(
        `this host already has a ${state.platform} install recorded — run \`server-uninstall\` first to switch platforms`,
      );
    }
    state.platform = strategy.id;
    state.createdAt ??= opts.now;
    state.updatedAt = opts.now;
    const ctx = buildContext(state, opts);

    await strategy.preflight(ctx); // throws PreflightError to refuse politely

    const steps = strategy.steps(ctx);
    const resolvedCount = steps.filter((s) => isResolved(state.steps[s.id])).length;
    if (resolvedCount > 0) {
      ctx.ui.info(`Resuming ${strategy.label} — ${resolvedCount}/${steps.length} steps already done.`);
    }

    for (const step of steps) {
      const forced = opts.reconfigure.has(step.id);
      if (!forced && isResolved(state.steps[step.id])) {
        ctx.ui.info(`= ${step.title} (already done)`);
        continue;
      }
      // Already satisfied on the box (fresh install, nothing recorded yet)?
      if (!forced && (await step.check(ctx))) {
        state.steps[step.id] = { status: 'done', created: state.steps[step.id]?.created ?? null };
        await ctx.save();
        ctx.ui.info(`= ${step.title} (already present)`);
        continue;
      }

      if (step.optional) {
        // `--yes` = accept safe defaults, and the safe default for an optional
        // step (SSL against a real domain, autostart) is to SKIP it — never run
        // it non-interactively against placeholder input.
        if (ctx.assumeYes) {
          state.steps[step.id] = { status: 'skipped', created: null };
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped: --yes)`);
          continue;
        }
        const proceed = await ctx.ui.confirm({ message: `Set up ${step.title}?`, initialValue: true });
        if (proceed === CANCEL) {
          state.steps[step.id] = { status: 'pending', created: null };
          await ctx.save();
          ctx.ui.warn(`Cancelled at "${step.title}". Progress saved — re-run to resume.`);
          return { status: 'cancelled', state };
        }
        if (proceed !== true) {
          state.steps[step.id] = { status: 'skipped', created: null };
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped)`);
          continue;
        }
      }

      try {
        const created = await step.run(ctx);
        state.steps[step.id] = { status: 'done', created };
        state.updatedAt = opts.now;
        await ctx.save();
      } catch (err) {
        if (err instanceof StepSkipped) {
          state.steps[step.id] = { status: 'skipped', created: null };
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped: ${err.message})`);
          continue;
        }
        if (err instanceof StepCancelled) {
          state.steps[step.id] = { status: 'pending', created: null };
          await ctx.save();
          ctx.ui.warn(`Cancelled at "${step.title}". Progress saved — re-run to resume.`);
          return { status: 'cancelled', state };
        }
        if (err instanceof StepAborted) {
          state.steps[step.id] = { status: 'failed', created: null };
          await ctx.save();
          ctx.ui.error(`Stopped at "${step.title}": ${err.message}`);
          return { status: 'failed', state };
        }
        state.steps[step.id] = { status: 'failed', created: null };
        await ctx.save();
        throw err;
      }
    }

    const requiredAllDone = steps
      .filter((s) => !s.optional)
      .every((s) => state.steps[s.id]?.status === 'done');
    state.installed = requiredAllDone;
    state.updatedAt = opts.now;
    await ctx.save();
    return { status: 'complete', state };
  } finally {
    release();
  }
}

export async function runUninstall(strategy: PlatformStrategy, opts: RunOptions): Promise<RunResult> {
  const release = acquireLock();
  try {
    const state = loadServerState();
    const ctx = buildContext(state, opts);

    if (liveInstancesExist()) {
      ctx.ui.warn('Other cezar instances are registered under ~/.cezar/instances/.');
      const proceed = await ctx.ui.confirm({
        message: 'Removing the shared proxy/service will break them. Continue?',
        initialValue: false,
      });
      if (proceed !== true) return { status: 'cancelled', state };
    }

    // Reverse order: undo the last-created first.
    const steps = [...strategy.steps(ctx)].reverse();
    for (const step of steps) {
      const outcome = state.steps[step.id];
      if (outcome?.status !== 'done') continue;
      try {
        await step.undo(ctx, outcome.created ?? null);
        delete state.steps[step.id];
        state.updatedAt = opts.now;
        await ctx.save();
      } catch (err) {
        if (err instanceof StepCancelled) {
          ctx.ui.warn(`Cancelled during uninstall at "${step.title}". Re-run to continue.`);
          return { status: 'cancelled', state };
        }
        ctx.ui.error(`Failed to reverse "${step.title}": ${err instanceof Error ? err.message : String(err)}`);
        return { status: 'failed', state };
      }
    }

    // Every `done` step was reversed above; `skipped`/`pending` entries had no
    // system effect. A completed uninstall leaves the record empty.
    state.steps = {};
    state.installed = false;
    state.updatedAt = opts.now;
    await ctx.save();
    return { status: 'complete', state };
  } finally {
    release();
  }
}

/** True when at least one repo instance is registered (multi-project registry). */
function liveInstancesExist(): boolean {
  const dir = join(cezarHomeDir(), 'instances');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
