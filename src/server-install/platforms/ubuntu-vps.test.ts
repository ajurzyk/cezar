import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemdUnit, ubuntuVps } from './ubuntu-vps.js';
import { StepAborted } from '../steps.js';
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
    expect(ids).toEqual(['deps', 'nginx-proxy', 'ssl', 'autostart', 'identity']);
    expect(stepById('ssl').optional).toBe(true);
    expect(stepById('autostart').optional).toBe(true);
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

describe('ubuntu-vps nginx-proxy security', () => {
  function secCtx(password: string, capture: Runner['capture']) {
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string }) => (o.message.toLowerCase().includes('username') ? 'ops' : ''),
      password: async () => password,
    } as Ui;
    return { ...ctxWith({ ui }), assumeYes: true, runner: { capture, interactive: async () => 0 } } as InstallContext;
  }

  it('feeds the password to openssl via stdin, never as an argv (H2)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: 'hash', stderr: '' }));
    await stepById('nginx-proxy').run(secCtx('hunter2', capture));
    const openssl = capture.mock.calls.find((c) => c[0] === 'openssl');
    expect(openssl?.[1]).toEqual(['passwd', '-apr1', '-stdin']);
    expect(openssl?.[2]).toEqual({ input: 'hunter2\n' });
    // the plaintext is never passed as a command argument
    expect(capture.mock.calls.some((c) => c[1].includes('hunter2'))).toBe(false);
  });

  it('refuses an empty/too-short password instead of creating an open cockpit (H1)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: '', stderr: '' }));
    await expect(stepById('nginx-proxy').run(secCtx('', capture))).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('systemdUnit', () => {
  it('runs cezar serve loopback with CEZ_REMOTE=1 and the port', () => {
    const unit = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/cezar');
    expect(unit).toContain('Environment=CEZ_REMOTE=1');
    expect(unit).toContain('ExecStart=/usr/local/bin/cezar serve --no-open --port 4321');
    expect(unit).toContain('WorkingDirectory=/srv/app');
    expect(unit).toContain('WantedBy=default.target');
  });
  it('system scope pins User= and multi-user.target', () => {
    const unit = systemdUnit('/srv/app', 5000, 'system', '/usr/local/bin/cezar');
    expect(unit).toContain('User=');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});

describe('ubuntu-vps autostart step (dry-run)', () => {
  it('records a user-scoped service artifact and writes nothing to disk', async () => {
    const created = await stepById('autostart').run(ctxWith({ dryRun: true }));
    const svc = created?.artifacts.find((a) => a.type === 'service');
    expect(svc?.kind).toBe('owned');
    expect(svc?.scope).toBe('user');
    expect(svc?.name).toBe('cezar.service');
  });
});
