import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fixtureServeEnv } from '../e2e/agent-browser'

/**
 * The seal `fixtureServeEnv` writes into every spec-owned fixture repo (#32), tested here rather
 * than in `e2e/` because these cases need no browser and no server: `npm test` is the gate that
 * must catch a regression, and the e2e suite only runs behind `npm run test:e2e`. Same shape as
 * `vite-config.test.ts`, which reaches out of `src/` for the same reason.
 *
 * Why the seal exists: `discoverSkills` merges `getTeamSkillsCached(repoRoot)`, whose bare clone
 * lives under `homedir()` (`packages/cezar/src/skills-remote.ts` → `bareDirFor`), so pinning
 * `CEZ_HOME` cannot contain it. `"skillsRepos": []` in the fixture's own `.ai/cezar/config.json`
 * is the documented opt-out (`packages/cezar/src/config.ts`) and empties the source list before
 * anything is cloned or listed — which is what closes the cold-cache race too. The seal's
 * behaviour at the config seam is pinned separately in `packages/cezar/src/skills.test.ts`.
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cezar-seal-'))
  tempDirs.push(dir)
  return dir
}

function readSealedConfig(dataRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataRoot, '.ai/cezar/config.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('fixtureServeEnv seals the fixture repo off from the machine team-skill collection', () => {
  it('creates the config when the fixture has none — the zero-config case every spec hits', () => {
    const dataRoot = fixtureRoot()

    fixtureServeEnv(dataRoot)

    expect(readSealedConfig(dataRoot)).toEqual({ skillsRepos: [] })
  })

  it('merges into an existing config instead of overwriting it', () => {
    // Verbatim shape from forgejo.e2e.ts, which writes this block into the SAME file before it
    // boots through the helper. Dropping `forge` would silently un-classify that fixture's forge.
    const dataRoot = fixtureRoot()
    const forge = { kind: 'forgejo', apiUrl: 'http://forgejo.test:3000', webUrl: 'https://forgejo.test' }
    mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(dataRoot, '.ai/cezar/config.json'), `${JSON.stringify({ forge }, null, 2)}\n`, 'utf8')

    fixtureServeEnv(dataRoot)

    expect(readSealedConfig(dataRoot)).toEqual({ forge, skillsRepos: [] })
  })

  it('never clobbers a skillsRepos a spec set deliberately', () => {
    // A spec that wants a team catalog (a fixture source of its own) has already said so; the
    // seal is a default for the silent majority, not an override.
    const dataRoot = fixtureRoot()
    const deliberate = [{ repo: '/tmp/some-fixture-skills', ref: 'main' }]
    mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(
      join(dataRoot, '.ai/cezar/config.json'),
      `${JSON.stringify({ skillsRepos: deliberate }, null, 2)}\n`,
      'utf8',
    )

    fixtureServeEnv(dataRoot)

    expect(readSealedConfig(dataRoot)).toEqual({ skillsRepos: deliberate })
  })

  it('seals over a malformed config rather than throwing, exactly as cezar degrades it', () => {
    // `packages/cezar/src/config.ts` degrades an unreadable config to defaults and boots anyway.
    // The helper must not be the thing that turns a junk file into a failed spec — and a fixture
    // left unsealed here would be the machine-dependent catalog this issue is about.
    const dataRoot = fixtureRoot()
    mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(dataRoot, '.ai/cezar/config.json'), 'not json at all', 'utf8')

    fixtureServeEnv(dataRoot)

    expect(readSealedConfig(dataRoot)).toEqual({ skillsRepos: [] })
  })

  it('still returns the dry-run env and the pinned CEZ_HOME, with extras applied last', () => {
    // The seal is additive: the isolation contract this helper already carried must not shift.
    const dataRoot = fixtureRoot()

    const env = fixtureServeEnv(dataRoot, { CEZ_REVIEW_GATE: '1' })

    expect(env.CEZ_DRY_RUN).toBe('1')
    expect(env.CEZ_HOME).toBe(join(dataRoot, '.cez-home'))
    expect(env.CEZ_REVIEW_GATE).toBe('1')
  })

  it('is idempotent — a second call neither duplicates nor rewrites the seal', () => {
    // `quick-list.e2e.ts` calls the helper three times in one file, and specs restart servers.
    const dataRoot = fixtureRoot()

    fixtureServeEnv(dataRoot)
    const first = readFileSync(join(dataRoot, '.ai/cezar/config.json'), 'utf8')
    fixtureServeEnv(dataRoot)

    expect(readFileSync(join(dataRoot, '.ai/cezar/config.json'), 'utf8')).toBe(first)
  })
})
