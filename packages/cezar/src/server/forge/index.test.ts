import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import { forgeKindOfRemote, forgeWebRoot, parseRemote, resolveForge } from './index.ts';
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

describe('forgeWebRoot', () => {
  it.each([
    ['https://github.com/acme/demo.git', 'https://github.com/acme/demo'],
    ['git@github.com:acme/demo.git', 'https://github.com/acme/demo'],
    ['git@gitlab.com:acme/demo.git', null],
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('builds %s as %s from the host table alone', (remote, expected) => {
    expect(forgeWebRoot(remote)).toBe(expected);
  });

  it('rebuilds from the parsed remote, so credentials in it cannot reach the value', () => {
    expect(forgeWebRoot('https://user:token@github.com/acme/demo.git')).toBe('https://github.com/acme/demo');
  });

  it("a repo-config forge supplies the web root for a host the table cannot reveal", () => {
    expect(forgeWebRoot('ssh://git@forge.internal:2222/acme/demo.git', forgejoSettings)).toBe(
      'http://forge.internal:8929/acme/demo',
    );
  });

  it('rebuilds the config-fed root from the PARSED remote too — a credentialed self-hosted remote leaks nothing', () => {
    // The security property that made this function rebuild rather than pass through has to hold on
    // BOTH branches; only the base differs, never where owner/repo come from.
    expect(forgeWebRoot('https://user:token@forge.internal/acme/demo.git', forgejoSettings)).toBe(
      'http://forge.internal:8929/acme/demo',
    );
  });

  it('the host table wins over a repo-config forge on a github.com remote — precedence is unchanged', () => {
    expect(forgeWebRoot('https://github.com/acme/demo.git', forgejoSettings)).toBe('https://github.com/acme/demo');
  });

  it('trims a trailing slash on the configured webUrl rather than rendering a double slash', () => {
    // `apiUrl` is trimmed on its way into `ForgejoHttp`; `webUrl` is trimmed nowhere today, so a
    // config ending in '/' would otherwise render `http://host//acme/demo`.
    const trailing: ForgeSettings = { ...forgejoSettings, webUrl: 'http://forge.internal:8929///' };
    expect(forgeWebRoot('ssh://git@forge.internal:2222/acme/demo.git', trailing)).toBe(
      'http://forge.internal:8929/acme/demo',
    );
  });

  it('encodes owner/repo segments the way forgejoViewUrl encodes the same pair', () => {
    // `parseRemote` only checks these for non-emptiness, so encoding here is the one thing keeping a
    // '..' segment or a space out of a URL the cockpit renders and links.
    expect(forgeWebRoot('ssh://git@forge.internal:2222/a c/..%2Fetc.git', forgejoSettings)).toBe(
      'http://forge.internal:8929/a%20c/..%252Fetc',
    );
  });

  it('stays null for a repo-config kind:github on a self-hosted remote', () => {
    // Same refusal `classifyForgeKind` already makes: the GitHub driver is hardwired to github.com,
    // and a web root built from `githubSettings.webUrl` would point at a same-named github.com repo.
    expect(forgeWebRoot('ssh://git@forge.internal:2222/acme/demo.git', githubSettings)).toBeNull();
  });

  it('stays null for an unparseable remote even with a repo config present', () => {
    // `parseRemote` is the only source of owner/repo — with none, there is no root to compose.
    expect(forgeWebRoot('/srv/git/demo.git', forgejoSettings)).toBeNull();
    expect(forgeWebRoot(undefined, forgejoSettings)).toBeNull();
  });

  it('stays null for a self-hosted remote with no repo config — the pre-Forgejo behaviour', () => {
    expect(forgeWebRoot('ssh://git@forge.internal:2222/acme/demo.git')).toBeNull();
  });

  it.each([
    ['https://github.com/acme/demo.git', undefined],
    ['https://github.com/acme/demo.git', forgejoSettings],
    ['https://github.com/acme/demo.git', githubSettings],
    ['ssh://git@forge.internal:2222/acme/demo.git', forgejoSettings],
    ['ssh://git@forge.internal:2222/acme/demo.git', githubSettings],
    ['ssh://git@forge.internal:2222/acme/demo.git', undefined],
    ['git@gitlab.com:acme/demo.git', forgejoSettings],
    ['/srv/git/demo.git', forgejoSettings],
  ])('agrees with forgeKindOfRemote about which forge named the root (%s)', (remote, settings) => {
    // The invariant the cockpit newly DEPENDS on. `global-tasks.tsx` spells a number-only PR chip
    // from the row's `repoUrl` and its `forge` together, and the two segments differ (`/pulls/` on
    // Forgejo, `/pull/` on GitHub) — so a row whose kind and root disagreed would render a 404.
    // They cannot disagree, because both answers come from `classifyForgeKind`; this pins that.
    const kind = forgeKindOfRemote(remote, settings);
    const root = forgeWebRoot(remote, settings);
    expect(root === null).toBe(kind === null);
    if (kind === 'github') expect(root).toMatch(/^https:\/\/github\.com\//);
    if (kind === 'forgejo') expect(root?.startsWith(`${settings?.webUrl}/`)).toBe(true);
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
