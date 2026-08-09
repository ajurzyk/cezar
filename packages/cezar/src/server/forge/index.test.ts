import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import { forgeKindOfRemote, parseRemote, resolveForge } from './index.ts';
import type { ForgeSettings } from './types.ts';

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

/** A repo-config-declared self-hosted forge (repo-config-driven recognition) — wins over the host
 *  table when present. */
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

  it('a repo-config forge wins over the host table for a self-hosted remote', () => {
    expect(forgeKindOfRemote('ssh://git@forge.internal:2222/acme/demo.git', forgejoSettings)).toBe('forgejo');
  });

  it('a repo-config forge wins over the host table even on a github.com remote', () => {
    expect(forgeKindOfRemote('https://github.com/acme/demo.git', forgejoSettings)).toBe('forgejo');
  });

  it('a github-kind repo config on a github.com remote still classifies as github', () => {
    expect(forgeKindOfRemote('https://github.com/acme/demo.git', githubSettings)).toBe('github');
  });

  it('a github-kind repo config on a self-hosted remote still wins (config beats host)', () => {
    expect(forgeKindOfRemote('ssh://git@forge.internal:2222/acme/demo.git', githubSettings)).toBe('github');
  });

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

  it('returns null for a repo-config forgejo declaration on a self-hosted remote (driver lands separately)', () => {
    expect(resolveForge(info('ssh://git@forge.internal:2222/acme/demo.git'), forgejoSettings)).toBeNull();
  });

  it('a repo-config forgejo declaration also wins on a github.com remote, deliberately dropping the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'), forgejoSettings)).toBeNull();
  });

  it('a repo-config github declaration builds the GitHub driver from a self-hosted remote', () => {
    // owner/repo still come from parseRemote — viewUrl still hardcodes github.com (known limit,
    // see the comment on the 'github' branch in resolveForge), so it is NOT asserted here.
    expect(resolveForge(info('ssh://git@forge.internal:2222/acme/demo.git'), githubSettings)?.kind).toBe('github');
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
