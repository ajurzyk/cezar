import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentHomePaths, cezarHomeDir, serverLockPath, serverStatePath } from './paths.js';

describe('paths', () => {
  const original = process.env.CEZ_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
  });

  it('defaults cezarHomeDir to ~/.cezar', () => {
    delete process.env.CEZ_HOME;
    expect(cezarHomeDir()).toBe(join(homedir(), '.cezar'));
  });

  it('honors the CEZ_HOME override', () => {
    process.env.CEZ_HOME = '/tmp/cez-home-test';
    expect(cezarHomeDir()).toBe('/tmp/cez-home-test');
    expect(serverStatePath()).toBe('/tmp/cez-home-test/server.json');
    expect(serverLockPath()).toBe('/tmp/cez-home-test/server.install.lock');
  });
});

it('an EMPTY CEZ_HOME falls back to the default instead of a relative cwd path', () => {
  const original = process.env.CEZ_HOME;
  process.env.CEZ_HOME = '';
  try {
    expect(cezarHomeDir().startsWith('/')).toBe(true);
    expect(cezarHomeDir().endsWith('/.cezar')).toBe(true);
  } finally {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
  }
});

describe('agentHomePaths', () => {
  it('defaults to ~/.claude, ~/.codex, ~/.config/opencode', () => {
    const p = agentHomePaths({ HOME: '/home/u' } as NodeJS.ProcessEnv);
    expect(p.claude).toBe('/home/u/.claude');
    expect(p.codex).toBe('/home/u/.codex');
    expect(p.opencodeConfig).toBe('/home/u/.config/opencode');
  });

  it('honours $CODEX_HOME', () => {
    const p = agentHomePaths({ HOME: '/home/u', CODEX_HOME: '/opt/codex' } as NodeJS.ProcessEnv);
    expect(p.codex).toBe('/opt/codex');
  });

  it('honours $XDG_CONFIG_HOME for OpenCode', () => {
    const p = agentHomePaths({ HOME: '/home/u', XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv);
    expect(p.opencodeConfig).toBe('/xdg/opencode');
  });

  it('falls back to USERPROFILE when HOME is unset (Windows)', () => {
    const p = agentHomePaths({ USERPROFILE: 'C:\\Users\\u' } as unknown as NodeJS.ProcessEnv);
    expect(p.claude).toContain('.claude');
  });
});
