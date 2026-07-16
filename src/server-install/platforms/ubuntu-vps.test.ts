import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ubuntuVps } from './ubuntu-vps.js';
import { createAutoUi } from '../ui.js';
import type { InstallContext, InstallStep, Runner, Ui } from '../types.js';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxWith(over: { ui?: Ui; runner?: Runner; dryRun?: boolean }): InstallContext {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
  };
}

function stepById(id: string): InstallStep {
  const s = ubuntuVps.steps(ctxWith({})).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe('ubuntu-vps ssl step', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ssl-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is optional and appears before identity', () => {
    const ids = ubuntuVps.steps(ctxWith({})).map((s) => s.id);
    expect(ids).toEqual(['deps', 'nginx-proxy', 'ssl', 'identity']);
    expect(stepById('ssl').optional).toBe(true);
  });

  it('dry-run records the cert as a shared artifact and sets publicUrl', async () => {
    const ui = { ...createAutoUi(), text: async (o: { message: string }) => (o.message.includes('Domain') ? 'cezar.example.com' : 'you@example.com') } as Ui;
    const ctx = ctxWith({ dryRun: true, ui });
    const created = await stepById('ssl').run(ctx);
    const cert = created?.artifacts.find((a) => a.type === 'cert');
    expect(cert?.kind).toBe('shared');
    expect(cert?.name).toBe('cezar.example.com');
    expect(ctx.state.publicUrl).toBe('https://cezar.example.com');
  });

  it('undo does NOT remove the cert — it only lists it', async () => {
    const note = vi.fn();
    const ui = { ...createAutoUi(), note } as Ui;
    const ctx = ctxWith({ ui });
    await stepById('ssl').undo(ctx, { artifacts: [{ kind: 'shared', type: 'cert', name: 'x.example.com', removeHint: 'sudo certbot delete --cert-name x.example.com' }] });
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0]?.[0]).toContain('certbot delete');
  });
});
