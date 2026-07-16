import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cezarHomeDir, serverLockPath, serverStatePath } from './paths.js';

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
