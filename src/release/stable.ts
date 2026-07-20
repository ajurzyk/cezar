/** Stable-release decisions — the pure half of `scripts/release.mjs`.
 *
 *  Sibling of `snapshot.ts`, but for the *owner-driven* `latest` channel. The
 *  `Release` workflow (`.github/workflows/release.yml`) is run manually and
 *  never fires from a push, so — unlike snapshots — a stable release is the only
 *  thing that ever moves the `latest` dist-tag (spec
 *  `.ai/specs/2026-07-18-npm-preview-publish.md`, #482).
 *
 *  Two decisions live here so they stay unit-testable, side-effect-free, and
 *  name-agnostic (names come from the checked-out manifests, never constants):
 *  the next stable version for a given bump, and how both manifests are stamped.
 *  Crucially, the alias keeps a **caret** range on its scoped dependency — the
 *  opposite of the snapshot stamper's exact pin — so a stable `cezar-cli` picks
 *  up compatible patch releases of the implementation package.
 */

/** The version-bump modes the Release workflow offers. `existing` publishes the
 *  version already committed to the root manifest (for hand-prepared releases);
 *  the rest increment semver from the current base. */
export type ReleaseBump = 'patch' | 'minor' | 'major' | 'existing';

export const RELEASE_BUMPS: readonly ReleaseBump[] = ['patch', 'minor', 'major', 'existing'];

export function isReleaseBump(value: string): value is ReleaseBump {
  return (RELEASE_BUMPS as readonly string[]).includes(value);
}

/** Compute the next stable version from the current base and a bump mode.
 *
 *  `base` must be a plain `major.minor.patch` (no prerelease/build suffix) — a
 *  stable release should never start from a snapshot version. `existing` returns
 *  the base verbatim; the increments zero out the lower components the way
 *  `npm version` does. Returns `null` for an unparseable base so the caller can
 *  fail loudly instead of publishing a garbage version. */
export function computeStableVersion(bump: ReleaseBump, base: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case 'existing':
      return `${major}.${minor}.${patch}`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      return null;
  }
}

/** The minimal manifest shape the stamper touches; everything else passes through. */
export interface ManifestLike {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Stamp both manifests to a stable version.
 *
 *  Mirror of `stampManifests` in `snapshot.ts`, but the alias's dependency on
 *  the scoped package is a **caret** range (`^0.1.6`), not an exact pin — a
 *  stable `cezar-cli` should follow compatible releases of the implementation
 *  package, whereas a snapshot must pin the one exact build it was cut from.
 *
 *  Like the snapshot stamper, the alias inherits `repository`/`homepage`/`bugs`
 *  from the root manifest: `--provenance` publishes are rejected (E422) unless
 *  the manifest's `repository.url` matches the building repo, and the alias file
 *  carries none of its own. The git URL already matches and survives any
 *  npm-name rename. */
export function stampStableManifests(
  rootPkg: ManifestLike,
  aliasPkg: ManifestLike,
  version: string,
): { root: ManifestLike; alias: ManifestLike } {
  const inherited: Partial<ManifestLike> = {};
  for (const field of ['repository', 'homepage', 'bugs'] as const) {
    if (rootPkg[field] !== undefined) inherited[field] = rootPkg[field];
  }
  return {
    root: { ...rootPkg, version },
    alias: { ...aliasPkg, ...inherited, version, dependencies: { [rootPkg.name]: `^${version}` } },
  };
}
