import { describe, expect, it } from 'vitest';
import { scrubInheritedCezEnv } from './host-env.testkit.ts';

describe('scrubInheritedCezEnv', () => {
  it('removes every CEZ_* key the host process leaked in', () => {
    const env: NodeJS.ProcessEnv = {
      CEZ_PROJECTS_DIR: '/srv/dev',
      CEZ_HOME: '/srv/cezar-state',
      CEZ_FORGEJO_TOKEN: 'secret',
      PATH: '/usr/bin',
    };

    const removed = scrubInheritedCezEnv(env);

    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(removed).toEqual(['CEZ_FORGEJO_TOKEN', 'CEZ_HOME', 'CEZ_PROJECTS_DIR']);
  });

  it('leaves keys that merely contain CEZ_ alone, and answers [] on a clean env', () => {
    const env: NodeJS.ProcessEnv = { MY_CEZ_HOME: 'x', CEZARINA: 'y' };

    expect(scrubInheritedCezEnv(env)).toEqual([]);
    expect(env).toEqual({ MY_CEZ_HOME: 'x', CEZARINA: 'y' });
  });

  it('has already run for this worker — the suite never sees a host CEZ_* value', () => {
    // Regression na run 526bafac: `CEZ_PROJECTS_DIR=/srv/dev` z env kontenera
    // cezar-staging wywalał dwie asercje w projects-api.test.ts. Jedyne CEZ_*,
    // jakie tu wolno zobaczyć, to sandboxowy pin z vitest.setup.ts.
    const leaked = Object.keys(process.env)
      .filter((k) => k.startsWith('CEZ_') && k !== 'CEZ_HOME')
      .sort();
    expect(leaked).toEqual([]);
  });
});
