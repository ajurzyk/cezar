import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cezarLaunchdPlist, launchdPlist, macosxNgrok } from './macosx-ngrok.js';
import { availablePlatformIds, getStrategy } from '../strategies.js';
import { runInstall, runUninstall } from '../engine.js';
import { loadServerState } from '../state.js';
import { createAutoUi } from '../ui.js';
import type { Runner } from '../types.js';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('macosx-ngrok', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside ubuntu-vps', () => {
    expect(getStrategy('macosx-ngrok')?.id).toBe('macosx-ngrok');
    expect(availablePlatformIds()).toEqual(['ubuntu-vps', 'macosx-ngrok']);
  });

  it('launchdPlist embeds the port, basic-auth and reserved domain', () => {
    const p = launchdPlist(4321, 'ops:hunter2', 'cezar.ngrok.app');
    expect(p).toContain('<string>http</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>ops:hunter2</string>');
    expect(p).toContain('<string>cezar.ngrok.app</string>');
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('cezarLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>CEZ_REMOTE</key>');
    expect(p).toContain('<string>ai.cezar.cockpit</string>');
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui,
      runner: okRunner,
    };
    const res = await runInstall(macosxNgrok, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-ngrok');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.ngrok?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no domain given → ephemeral URL
    const ngrokArtifacts = state.steps.ngrok?.created?.artifacts ?? [];
    expect(ngrokArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');
    expect(ngrokArtifacts.find((a) => a.type === 'ngrok-config')?.kind).toBe('shared');
    const autostartArtifacts = state.steps.autostart?.created?.artifacts ?? [];
    expect(autostartArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxNgrok, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });
});
