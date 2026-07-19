import { describe, expect, it } from 'vitest';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
  type ManifestLike,
} from './stable.js';

describe('computeStableVersion', () => {
  it('increments each semver component the way npm version does', () => {
    expect(computeStableVersion('patch', '0.1.5')).toBe('0.1.6');
    expect(computeStableVersion('minor', '0.1.5')).toBe('0.2.0');
    expect(computeStableVersion('major', '0.1.5')).toBe('1.0.0');
  });

  it('returns the base verbatim for the existing bump', () => {
    expect(computeStableVersion('existing', '0.1.5')).toBe('0.1.5');
    expect(computeStableVersion('existing', '2.3.4')).toBe('2.3.4');
  });

  it('rejects a non-plain base version so a snapshot can never be released', () => {
    expect(computeStableVersion('patch', '0.1.5-pr482.123')).toBeNull();
    expect(computeStableVersion('patch', 'not-a-version')).toBeNull();
    expect(computeStableVersion('patch', '')).toBeNull();
  });
});

describe('isReleaseBump', () => {
  it('accepts the four supported modes and nothing else', () => {
    expect(isReleaseBump('patch')).toBe(true);
    expect(isReleaseBump('existing')).toBe(true);
    expect(isReleaseBump('snapshot')).toBe(false);
    expect(isReleaseBump('')).toBe(false);
  });
});

describe('stampStableManifests', () => {
  it('stamps both manifests and keeps a caret range on the alias dependency', () => {
    const root: ManifestLike = { name: '@scope/impl', version: '0.1.5', files: ['dist'] };
    const alias: ManifestLike = {
      name: 'impl-cli',
      version: '0.1.5',
      dependencies: { '@scope/impl': '^0.1.5' },
    };

    const stamped = stampStableManifests(root, alias, '0.1.6');

    expect(stamped.root.version).toBe('0.1.6');
    expect(stamped.root.files).toEqual(['dist']); // passthrough untouched
    expect(stamped.alias.version).toBe('0.1.6');
    // Caret, not an exact pin — the opposite of the snapshot stamper.
    expect(stamped.alias.dependencies).toEqual({ '@scope/impl': '^0.1.6' });
  });

  it('lets the alias inherit repository/homepage/bugs from root so provenance validates', () => {
    const repository = { type: 'git', url: 'https://github.com/open-mercato/cezar' };
    const root: ManifestLike = { name: '@scope/impl', version: '0.1.5', repository, homepage: 'https://example.test', bugs: { url: 'https://example.test/issues' } };
    const alias: ManifestLike = { name: 'impl-cli', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } };

    const stamped = stampStableManifests(root, alias, '0.1.6');

    expect(stamped.alias.repository).toEqual(repository);
    expect(stamped.alias.homepage).toBe('https://example.test');
    expect(stamped.alias.bugs).toEqual({ url: 'https://example.test/issues' });
  });

  it('leaves the alias untouched when root declares no repository', () => {
    const root: ManifestLike = { name: '@scope/impl', version: '0.1.5' };
    const alias: ManifestLike = { name: 'impl-cli', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } };
    expect('repository' in stampStableManifests(root, alias, '0.1.6').alias).toBe(false);
  });
});
