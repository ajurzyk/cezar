import { describe, expect, it, vi } from 'vitest';
import { createAutoUi } from './ui.js';
import { sudoStep, StepAborted, verifyCommand } from './steps.js';
import type { CommandResult, InstallContext, Runner, Ui } from './types.js';

function makeCtx(over: Partial<InstallContext> & { ui?: Ui; runner?: Partial<Runner> }): InstallContext {
  const runner: Runner = {
    capture: over.runner?.capture ?? (async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' })),
    interactive: over.runner?.interactive ?? (async () => 0),
  };
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    runner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: over.assumeYes ?? false,
    reconfigure: over.reconfigure ?? new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
  };
}

/** A Ui whose select/confirm answers come from queues, consumed in order. */
function scriptedUi(select: string[], confirm: boolean[]): Ui {
  const base = createAutoUi();
  const selects = [...select];
  const confirms = [...confirm];
  return {
    ...base,
    async select() {
      return selects.shift() as never;
    },
    async confirm() {
      return confirms.shift() ?? true;
    },
  };
}

describe('sudoStep', () => {
  it('dry-run performs no exec and no verify', async () => {
    const interactive = vi.fn(async () => 0);
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const verify = vi.fn(async () => true);
    const ctx = makeCtx({ dryRun: true, runner: { interactive, capture } });
    await sudoStep(ctx, { description: 'x', command: 'apt-get install -y nginx', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('run-via-sudo then verify-fail loops to redo until verify passes', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ui = scriptedUi(['sudo', 'sudo'], [true]); // 2 sudo runs, 1 redo=yes
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'install nginx', command: 'apt-get install -y nginx', verify });
    expect(interactive).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('delegate path does not shell out to sudo but still verifies', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn(async () => true);
    const ui = scriptedUi(['delegate'], [true]); // choose delegate, confirm done
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'write vhost', command: 'tee /etc/nginx/x', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('--yes aborts when verification fails (never loops forever)', async () => {
    const verify = vi.fn(async () => false);
    // passwordless sudo available so it runs non-interactively
    const ctx = makeCtx({
      assumeYes: true,
      runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    });
    await expect(sudoStep(ctx, { description: 'x', command: 'true', verify })).rejects.toBeInstanceOf(
      StepAborted,
    );
  });
});

describe('verifyCommand', () => {
  it('returns false in dry-run without running anything', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ctx = makeCtx({ dryRun: true, runner: { capture } });
    expect(await verifyCommand(ctx, 'gh', ['--version'])).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('applies the matcher to captured output', async () => {
    const ctx = makeCtx({ runner: { capture: async () => ({ code: 0, stdout: 'nginx/1.24', stderr: '' }) } });
    expect(await verifyCommand(ctx, 'nginx', ['-v'], (r) => r.stdout.includes('nginx/'))).toBe(true);
  });
});
