import { describe, expect, it } from 'vitest';

import { wslTerminalLaunchers } from './open-in-terminal.js';

describe('wslTerminalLaunchers (#361 WSL support)', () => {
  it('tries Windows Terminal first, re-entering the distro through wsl.exe', () => {
    const [first] = wslTerminalLaunchers('/tmp/cez-term-abc/launch.sh', 'Ubuntu');
    expect(first).toEqual(['wt.exe', ['wsl.exe', '-d', 'Ubuntu', '--', '/tmp/cez-term-abc/launch.sh']]);
  });

  it('falls back to a classic cmd window, same wsl.exe re-entry', () => {
    const [, second] = wslTerminalLaunchers('/tmp/cez-term-abc/launch.sh', 'Ubuntu');
    expect(second).toEqual([
      'cmd.exe',
      ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu', '--', '/tmp/cez-term-abc/launch.sh'],
    ]);
  });

  it('addresses the distro the launch actually runs in, not a hardcoded default', () => {
    const [first] = wslTerminalLaunchers('/tmp/script.sh', 'Debian');
    expect(first?.[1]).toContain('Debian');
  });
});
