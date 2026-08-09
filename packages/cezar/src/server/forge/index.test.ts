import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import { forgeKindOfRemote, parseRemote, resolveForge } from './index.ts';
import type { ForgeSettings } from './types.ts';

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

/** A repo-config-declared self-hosted forge (repo-config-driven recognition) — fills the gap the
 *  host table leaves, and only there. */
const forgejoSettings: ForgeSettings = {
  kind: 'forgejo',
  apiUrl: 'http://forgejo:3000',
  webUrl: 'http://forge.internal:8929',
};
const githubSettings: ForgeSettings = {
  kind: 'github',
  apiUrl: 'https://api.github.com',
  webUrl: 'https://github.com',
};

describe('parseRemote', () => {
  it.each([
    ['https://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://user:token@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@github.com:acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com:2222/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://GitHub.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo/', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@gitlab.com:group/sub/project.git', { host: 'gitlab.com', owner: 'sub', repo: 'project' }],
  ])('parses %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  it.each([
    ['/srv/git/demo.git'], // local bare path — not a forge
    ['../relative/path'],
    ['https://github.com/only-owner'],
    [''],
  ])('rejects %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('forgeKindOfRemote', () => {
  // The registry probe's classification (#698) — same host table as resolveForge,
  // but string-only: no driver, no repo root, no `gh`.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', null],
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s', (remote, expected) => {
    expect(forgeKindOfRemote(remote)).toBe(expected);
  });

  it('a repo-config forge names the forge for a host the table cannot reveal', () => {
    expect(forgeKindOfRemote('ssh://git@forge.internal:2222/acme/demo.git', forgejoSettings)).toBe('forgejo');
  });

  it('the host table wins over a repo-config forge on a github.com remote — the config fills a gap, it does not override', () => {
    // Declaring `forgejo` next to a github.com remote used to classify as 'forgejo' and hand the
    // repo a null driver: a config key that silently takes a working forge away.
    expect(forgeKindOfRemote('https://github.com/acme/demo.git', forgejoSettings)).toBe('github');
  });

  it('a github-kind repo config on a github.com remote still classifies as github', () => {
    expect(forgeKindOfRemote('https://github.com/acme/demo.git', githubSettings)).toBe('github');
  });

  it('ignores a repo-config kind:github on a self-hosted remote', () => {
    // The GitHub driver is hardwired to github.com (`gh` without `--hostname`, `viewUrl` on
    // github.com), so honouring this would point `repos/acme/demo` at a same-named github.com
    // repository. Nothing left to classify → null.
    expect(forgeKindOfRemote('ssh://git@forge.internal:2222/acme/demo.git', githubSettings)).toBeNull();
  });

  it.each([['git@__proto__:acme/demo.git'], ['git@constructor:acme/demo.git']])(
    'classifies %s — a host colliding with an Object.prototype key — as no forge',
    (remote) => {
      // The host table used to be an object literal, so `FORGE_HOSTS['__proto__']` returned
      // Object.prototype: truthy, non-nullish, and passed straight through `??` into the project
      // list as a value the contract's `z.enum(['github','forgejo'])` rejects.
      expect(forgeKindOfRemote(remote)).toBeNull();
    },
  );

  it('an undefined remote stays null even with a repo config (nothing to parse owner/repo from)', () => {
    expect(forgeKindOfRemote(undefined, forgejoSettings)).toBeNull();
  });

  it('a local-path remote stays null even with a repo config (unparseable — same reason)', () => {
    expect(forgeKindOfRemote('/srv/git/demo.git', forgejoSettings)).toBeNull();
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  it('returns null for an unknown forge host (GitLab lands here later)', () => {
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))).toBeNull();
  });

  it('returns null for a self-hosted host', () => {
    expect(resolveForge(info('https://git.example.com/acme/demo.git'))).toBeNull();
  });

  it('returns null when the repo has no remote', () => {
    expect(resolveForge(info(undefined))).toBeNull();
  });

  it('returns null when not in a git repo at all', () => {
    expect(resolveForge(null)).toBeNull();
  });

  it('returns null for a local-path remote', () => {
    expect(resolveForge(info('/srv/git/demo.git'))).toBeNull();
  });

  it('builds the Forgejo driver for a repo-config forgejo declaration on a self-hosted remote', () => {
    expect(resolveForge(info('ssh://git@forge.internal:2222/acme/demo.git'), forgejoSettings)?.kind).toBe('forgejo');
  });

  it('keeps the GitHub driver on a github.com remote even when the repo config declares forgejo', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'), forgejoSettings)?.kind).toBe('github');
  });

  it('builds no driver for a repo-config kind:github on a self-hosted remote', () => {
    // Regression guard for the cross-repo hazard: the driver would have been built with
    // `{owner:'acme', repo:'demo'}` parsed from the SELF-HOSTED remote, and `gh api --method PUT
    // repos/acme/demo/pulls/<n>/merge` runs without `--hostname` — i.e. against github.com.
    expect(resolveForge(info('ssh://git@forge.internal:2222/acme/demo.git'), githubSettings)).toBeNull();
  });

  it('a repo-config github declaration stays null without a parseable remote', () => {
    expect(resolveForge(info(undefined), githubSettings)).toBeNull();
  });
});

describe('GitHub driver viewUrl', () => {
  const driver = resolveForge(info('git@github.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://github.com/acme/demo'],
    ['issue', 142, 'https://github.com/acme/demo/issues/142'],
    ['pr', 128, 'https://github.com/acme/demo/pull/128'],
    ['branch', 'feat/cockpit ui', 'https://github.com/acme/demo/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://github.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});
