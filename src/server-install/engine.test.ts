import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, runUninstall, type RunOptions } from './engine.js';
import { loadServerState } from './state.js';
import { StepAborted } from './steps.js';
import { createAutoUi } from './ui.js';
import type { InstallStep, PlatformStrategy, Runner } from './types.js';

const noRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    dryRun: false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    ui: createAutoUi(),
    runner: noRunner,
    ...over,
  };
}

/** A step whose run/undo/check are spies. */
function fakeStep(id: string, over: Partial<InstallStep> = {}): InstallStep {
  return {
    id,
    title: id,
    check: vi.fn(async () => false),
    run: vi.fn(async () => ({ artifacts: [{ kind: 'owned' as const, type: 'file', path: `/etc/${id}` }] })),
    undo: vi.fn(async () => {}),
    ...over,
  };
}

function strategyOf(steps: InstallStep[]): PlatformStrategy {
  return { id: 'ubuntu-vps', label: 'Ubuntu VPS', preflight: async () => {}, steps: () => steps };
}

describe('engine', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-engine-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs all steps and flips installed=true', async () => {
    const a = fakeStep('a');
    const b = fakeStep('b');
    const res = await runInstall(strategyOf([a, b]), opts());
    expect(res.status).toBe('complete');
    expect(res.state.installed).toBe(true);
    expect(a.run).toHaveBeenCalledOnce();
    expect(loadServerState().steps.a?.status).toBe('done');
  });

  it('resume skips already-done steps', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    const a2 = fakeStep('a');
    await runInstall(strategyOf([a2]), opts());
    expect(a2.run).not.toHaveBeenCalled(); // resolved from state → skipped
  });

  it('--reconfigure re-runs a named done step', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    const a2 = fakeStep('a');
    await runInstall(strategyOf([a2]), opts({ reconfigure: new Set(['a']) }));
    expect(a2.run).toHaveBeenCalledOnce();
  });

  it('a failing (aborted) required step stops with state intact, installed stays false', async () => {
    const a = fakeStep('a', { run: vi.fn(async () => { throw new StepAborted('nope'); }) });
    const b = fakeStep('b');
    const res = await runInstall(strategyOf([a, b]), opts());
    expect(res.status).toBe('failed');
    expect(res.state.installed).toBe(false);
    expect(b.run).not.toHaveBeenCalled();
    expect(loadServerState().steps.a?.status).toBe('failed');
  });

  it('install-then-uninstall calls each undo with its recorded created and empties state', async () => {
    const a = fakeStep('a');
    const b = fakeStep('b');
    await runInstall(strategyOf([a, b]), opts());
    const a2 = fakeStep('a');
    const b2 = fakeStep('b');
    const res = await runUninstall(strategyOf([a2, b2]), opts());
    expect(res.status).toBe('complete');
    // reverse order: b undone before a
    expect(b2.undo).toHaveBeenCalledWith(expect.anything(), { artifacts: [{ kind: 'owned', type: 'file', path: '/etc/b' }] });
    expect(a2.undo).toHaveBeenCalledOnce();
    const after = loadServerState();
    expect(after.steps).toEqual({});
    expect(after.installed).toBe(false);
  });

  it('optional step declined at the confirm prompt is skipped and does not block installed=true', async () => {
    const a = fakeStep('a');
    const opt = fakeStep('opt', { optional: true });
    const ui = { ...createAutoUi(), confirm: async () => false };
    const res = await runInstall(strategyOf([a, opt]), opts({ ui, assumeYes: false }));
    expect(opt.run).not.toHaveBeenCalled();
    expect(res.state.steps.opt?.status).toBe('skipped');
    expect(res.state.installed).toBe(true); // optional skip doesn't block
  });

  it('--yes skips optional steps rather than running them non-interactively', async () => {
    const a = fakeStep('a');
    const opt = fakeStep('opt', { optional: true });
    // confirm would return true, but --yes must not even ask for an optional step.
    const confirm = vi.fn(async () => true);
    const ui = { ...createAutoUi(), confirm };
    const res = await runInstall(strategyOf([a, opt]), opts({ ui, assumeYes: true }));
    expect(confirm).not.toHaveBeenCalled();
    expect(opt.run).not.toHaveBeenCalled();
    expect(res.state.steps.opt?.status).toBe('skipped');
    expect(res.state.installed).toBe(true);
  });
});
