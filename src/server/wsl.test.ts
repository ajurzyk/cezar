import { describe, expect, it } from 'vitest';

import { isWsl, toPosixPath, toWindowsPath, wslDistroName } from './wsl.js';

describe('isWsl', () => {
  it('is false on any non-Linux platform, regardless of env', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin', 'Linux version 5.15 microsoft')).toBe(false);
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'win32', 'microsoft')).toBe(false);
  });

  it('is true on Linux when WSL_DISTRO_NAME or WSL_INTEROP is set', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', '')).toBe(true);
    expect(isWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, 'linux', '')).toBe(true);
  });

  it('is true on Linux when /proc/version mentions microsoft, even with no WSL env', () => {
    expect(isWsl({}, 'linux', 'Linux version 5.15.90.1-microsoft-standard-WSL2')).toBe(true);
    expect(isWsl({}, 'linux', 'Linux version 5.15.90.1-microsoft-standard-WSL2'.toUpperCase())).toBe(true);
  });

  it('is false on plain Linux — no WSL env and an ordinary /proc/version', () => {
    expect(isWsl({}, 'linux', 'Linux version 6.1.0-amd64')).toBe(false);
  });
});

describe('wslDistroName', () => {
  it('reads WSL_DISTRO_NAME, defaulting to Ubuntu when unset', () => {
    expect(wslDistroName({ WSL_DISTRO_NAME: 'Debian' })).toBe('Debian');
    expect(wslDistroName({})).toBe('Ubuntu');
  });
});

describe('toWindowsPath', () => {
  it('maps a /mnt/<drive> path to its native drive letter, not a UNC round-trip', () => {
    expect(toWindowsPath('/mnt/c/Users/pat/projects/cezar', 'Ubuntu')).toBe('C:\\Users\\pat\\projects\\cezar');
    expect(toWindowsPath('/mnt/d', 'Ubuntu')).toBe('D:\\');
  });

  it('maps a distro-native path to \\\\wsl$\\<Distro>\\…', () => {
    expect(toWindowsPath('/home/pat/projects/cezar', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu\\home\\pat\\projects\\cezar');
  });

  it('handles the distro root itself', () => {
    expect(toWindowsPath('/', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu');
  });

  it('defaults the distro from wslDistroName (env) when not passed explicitly', () => {
    expect(toWindowsPath('/home/pat')).toMatch(/^\\\\wsl\$\\/);
  });
});

describe('toPosixPath', () => {
  it('reverses a \\\\wsl$\\<Distro>\\… UNC path back to POSIX', () => {
    expect(toPosixPath('\\\\wsl$\\Ubuntu\\home\\pat\\projects\\cezar')).toBe('/home/pat/projects/cezar');
  });

  it('also reverses the newer \\\\wsl.localhost\\<Distro>\\… form', () => {
    expect(toPosixPath('\\\\wsl.localhost\\Ubuntu\\home\\pat')).toBe('/home/pat');
  });

  it('passes through anything that is not a WSL UNC path', () => {
    expect(toPosixPath('C:\\Users\\pat')).toBe('C:\\Users\\pat');
    expect(toPosixPath('\\\\some-share\\folder')).toBe('\\\\some-share\\folder');
  });
});
