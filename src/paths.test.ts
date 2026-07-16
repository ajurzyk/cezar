import { describe, expect, it } from 'vitest';
import { agentHomePaths } from './paths.js';

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
