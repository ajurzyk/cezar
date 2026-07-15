import { describe, expect, it } from 'vitest';

import { agentCliRunner, detectOpenTargets, openInApp } from './open-in-app.js';

describe('detectOpenTargets', () => {
  it('always offers a file manager and a terminal, first', () => {
    const targets = detectOpenTargets();
    expect(targets[0]?.id).toBe('finder');
    expect(targets[1]?.id).toBe('terminal');
    // Ids are unique.
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
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
