import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nginxVhost, serviceExecStart, systemdUnit, ubuntuVps } from './ubuntu-vps.js';
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
    prefs: {},
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

  it('orders the steps and only SSL is optional (the service must run)', () => {
    const ids = ubuntuVps.steps(ctxWith({})).map((s) => s.id);
    expect(ids).toEqual(['deps', 'nginx-proxy', 'ssl', 'autostart', 'identity']);
    expect(stepById('ssl').optional).toBe(true);
    // The service step is required now — after install cezar must actually run.
    expect(stepById('autostart').optional).toBeFalsy();
    expect(stepById('identity').optional).toBeFalsy();
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

describe('nginxVhost', () => {
  it('defaults to a catch-all server_name and can target a domain', () => {
    expect(nginxVhost(4321)).toContain('server_name _;');
    // The SSL step rewrites server_name to the domain so certbot --nginx can find it.
    expect(nginxVhost(4321, 'cezar.example.com')).toContain('server_name cezar.example.com;');
  });
});

describe('ubuntu-vps nginx-proxy identity (interactive, dry-run)', () => {
  it('suggests the current OS user and can auto-generate the cockpit password', async () => {
    const notes: string[] = [];
    const password = vi.fn(async () => 'should-not-be-asked');
    const ui = {
      ...createAutoUi(),
      // username: echo back the suggested (initialValue) default
      text: async (o: { initialValue?: string }) => o.initialValue ?? 'x',
      // credential prompt: pick the first option ("Generate a strong password for me")
      select: async (o: { options: Array<{ value: string }> }) => o.options[0]?.value,
      password,
      note: (m: string) => { notes.push(m); },
    } as unknown as Ui;
    // Interactive path (assumeYes:false) is where the generate/manual menu lives.
    const ctx = { ...ctxWith({ dryRun: true, ui }), assumeYes: false } as InstallContext;
    const created = await stepById('nginx-proxy').run(ctx);

    expect(password).not.toHaveBeenCalled(); // generated, not typed (issue #3)
    expect(notes.some((m) => m.includes('Password:'))).toBe(true); // shown once so it can be saved
    const htp = created?.artifacts.find((a) => a.type === 'htpasswd');
    expect(htp?.kind).toBe('owned');
    expect(htp?.name).toBeTruthy(); // the suggested current-user default (issue #2)
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

  it('takes an absolute "<node> <entry.js>" ExecStart verbatim (no bare name → no 203/EXEC)', () => {
    const unit = systemdUnit('/srv/app', 4321, 'system', '/usr/bin/node /srv/app/dist/index.js');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/app/dist/index.js serve --no-open --port 4321');
  });
});

describe('serviceExecStart', () => {
  const base = { node: '/n/node', entry: '/pkg/dist/index.js', npxPath: '/n/npx' };

  it('runs the built entry for a stable checkout/global install', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: true })).toBe('/n/node /pkg/dist/index.js');
  });

  it('uses the official npx alias when launched from the ephemeral _npx cache', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/home/u/.npm/_npx/abcd/node_modules/cezar-cli', entryExists: false }))
      .toBe('/n/npx --yes cezar-cli');
  });

  it('falls back to a resolved global bin when the entry is missing', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: false, globalBin: '/usr/bin/cezar-cli' }))
      .toBe('/n/node /usr/bin/cezar-cli');
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

describe('ubuntu-vps identity step (end-to-end verify)', () => {
  /** A runner whose curl returns codes by URL/args; sleep + everything else ok. */
  function curlRunner(byPort: string, throughProxy: string): Runner {
    return {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          const code = target.includes(`:${4321}`) ? byPort : throughProxy;
          return { code: 0, stdout: code, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('passes when cezar is up, anon is 401, and an authed request reaches it', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('200', '401') }), assumeYes: false } as InstallContext;
    ctx.prefs.cockpit = { user: 'ops', password: 'hunter2!' };
    // authed request (curl -K -) must return 2xx/3xx — model that by returning 200
    // for the proxy when credentials are supplied via stdin:
    ctx.runner = {
      interactive: async () => 0,
      capture: async (program, args, opts) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          if (target.includes(':4321')) return { code: 0, stdout: '200', stderr: '' }; // upstream up
          if (opts?.input) return { code: 0, stdout: '200', stderr: '' }; // authed → ok
          return { code: 0, stdout: '401', stderr: '' }; // anon → challenged
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await expect(stepById('identity').run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('fails the run when cezar is down (nginx would 502)', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('000', '401') }), assumeYes: false } as InstallContext;
    await expect(stepById('identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });
});
