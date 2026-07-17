import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentCliRunner, detectOpenTargets, fileManagerLaunch, launchPathFor, openInApp } from './open-in-app.js';

/** Polls `assertion` until it stops throwing or `timeoutMs` elapses (then rethrows) — there is
 *  no @testing-library here, and the detached child processes this suite launches settle on
 *  their own schedule, not the test's. */
async function waitFor(assertion: () => void, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

describe('detectOpenTargets', () => {
  it('always offers a file manager and a terminal, first, both with an icon', () => {
    const targets = detectOpenTargets();
    expect(targets[0]).toMatchObject({ id: 'finder', icon: 'folder' });
    expect(targets[1]).toMatchObject({ id: 'terminal', icon: 'terminal' });
    // Ids are unique.
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });

  it('gives every detected target a non-empty icon key (#361)', () => {
    for (const target of detectOpenTargets()) {
      expect(target.icon, `${target.id} should carry an icon`).toBeTruthy();
    }
  });

  // Detection depends on what is actually installed, so the wider JetBrains registry (#361 gap
  // 3) is exercised by putting fake, executable stub binaries on PATH rather than asserting
  // against whatever happens to be present on the machine running the suite.
  describe('with stub CLIs on PATH', () => {
    let stubDir: string;
    let originalPath: string | undefined;

    const STUBS = ['idea', 'pycharm', 'webstorm', 'goland', 'rubymine', 'phpstorm', 'clion', 'rider', 'studio'];

    let callLog: string;

    function withStubsOnPath() {
      stubDir = mkdtempSync(join(tmpdir(), 'cez-open-in-test-'));
      callLog = join(stubDir, 'calls.log');
      for (const name of STUBS) {
        const p = join(stubDir, name);
        // Records its own name and argv so the "opens with the right dir" test can confirm the
        // resolved binary actually ran with the worktree path, not just that spawn didn't throw.
        writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $1" >> ${JSON.stringify(callLog)}\ntrue\n`, 'utf8');
        chmodSync(p, 0o755);
      }
      originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    }

    afterEach(() => {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (stubDir) rmSync(stubDir, { recursive: true, force: true });
    });

    it('detects every JetBrains product once its CLI launcher is on PATH', () => {
      withStubsOnPath();
      const targets = detectOpenTargets();
      const byId = new Map(targets.map((t) => [t.id, t]));

      expect(byId.get('idea')).toMatchObject({ label: 'IntelliJ IDEA', icon: 'idea' });
      expect(byId.get('pycharm')).toMatchObject({ label: 'PyCharm', icon: 'pycharm' });
      expect(byId.get('webstorm')).toMatchObject({ label: 'WebStorm', icon: 'webstorm' });
      expect(byId.get('goland')).toMatchObject({ label: 'GoLand', icon: 'goland' });
      expect(byId.get('rubymine')).toMatchObject({ label: 'RubyMine', icon: 'rubymine' });
      expect(byId.get('phpstorm')).toMatchObject({ label: 'PhpStorm', icon: 'phpstorm' });
      expect(byId.get('clion')).toMatchObject({ label: 'CLion', icon: 'clion' });
      expect(byId.get('rider')).toMatchObject({ label: 'Rider', icon: 'rider' });
      expect(byId.get('android-studio')).toMatchObject({ label: 'Android Studio', icon: 'android-studio' });
    });

    it('opens the resolved JetBrains stub with the worktree dir as its argument', async () => {
      withStubsOnPath();
      expect(await openInApp('clion', '/tmp/some-worktree')).toBe(true);
      expect(await openInApp('rider', '/tmp/some-worktree')).toBe(true);
      // runDetached's own 250ms settle window is enough for these trivial scripts to run, but
      // it unrefs rather than waiting on the child — poll briefly rather than risk a flaky
      // exact-timing race under load.
      await waitFor(() => {
        const log = readFileSync(callLog, 'utf8');
        expect(log).toContain('clion /tmp/some-worktree');
        expect(log).toContain('rider /tmp/some-worktree');
      });
    });
  });
});

describe('openInApp', () => {
  it('rejects an unknown target instead of launching anything', async () => {
    expect(await openInApp('not-a-real-editor', process.cwd())).toBe(false);
  });
});

describe('agentCliRunner', () => {
  it('maps cli:<runner> ids to the runner, and rejects everything else', () => {
    expect(agentCliRunner('cli:claude')).toBe('claude');
    expect(agentCliRunner('cli:codex')).toBe('codex');
    expect(agentCliRunner('cli:opencode')).toBe('opencode');
    expect(agentCliRunner('vscode')).toBeNull();
    expect(agentCliRunner('terminal')).toBeNull();
    expect(agentCliRunner('cli:bogus')).toBeNull();
  });
});

describe('fileManagerLaunch (#361 WSL support)', () => {
  it('uses `open` on darwin and `explorer` on native win32, path unchanged', () => {
    expect(fileManagerLaunch('/repo/worktree', 'darwin', false)).toEqual({ bin: 'open', args: ['/repo/worktree'] });
    expect(fileManagerLaunch('C:\\repo\\worktree', 'win32', false)).toEqual({
      bin: 'explorer',
      args: ['C:\\repo\\worktree'],
    });
  });

  it('uses xdg-open on plain Linux (not WSL)', () => {
    expect(fileManagerLaunch('/home/pat/project', 'linux', false)).toEqual({
      bin: 'xdg-open',
      args: ['/home/pat/project'],
    });
  });

  it('goes through interop to explorer.exe under WSL, translating the POSIX path', () => {
    const result = fileManagerLaunch('/home/pat/project', 'linux', true);
    expect(result.bin).toBe('explorer.exe');
    // No real `wslpath` on the machine running this suite, so translateToWindowsPath falls back
    // to the pure conversion — still deterministic and worth pinning here.
    expect(result.args).toEqual(['\\\\wsl$\\Ubuntu\\home\\pat\\project']);
  });

  it('translates a WSL /mnt/<drive> path to its native Windows drive letter', () => {
    const result = fileManagerLaunch('/mnt/c/Users/pat/project', 'linux', true);
    expect(result.args).toEqual(['C:\\Users\\pat\\project']);
  });
});

describe('launchPathFor (#361 WSL support)', () => {
  it('passes the POSIX path through for a bare-name (WSL-native or non-WSL) binary', () => {
    expect(launchPathFor('idea', '/home/pat/project', true)).toBe('/home/pat/project');
    expect(launchPathFor('code', '/home/pat/project', false)).toBe('/home/pat/project');
  });

  it('translates the path for a Windows-suffixed binary resolved through WSL interop', () => {
    expect(launchPathFor('idea.exe', '/home/pat/project', true)).toBe('\\\\wsl$\\Ubuntu\\home\\pat\\project');
    expect(launchPathFor('pycharm.bat', '/mnt/c/repo', true)).toBe('C:\\repo');
  });

  it('never translates when not running under WSL, even for a .exe name', () => {
    expect(launchPathFor('idea.exe', '/home/pat/project', false)).toBe('/home/pat/project');
  });
});

