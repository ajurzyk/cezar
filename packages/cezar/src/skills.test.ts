import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverSkills,
  filterImportedTeamSkills,
  readImportedSkills,
  type Skill,
} from './skills.ts';
import { waitForTeamSkills } from './skills-remote.ts';
import { DEFAULT_SKILLS_REPOS, loadConfig } from './config.ts';

/**
 * The opt-out gate's two pure halves (#391 follow-up: the promo banner is gone, replaced by
 * per-skill curation). `readImportedSkills` parses a user-editable ui-state as a tri-state
 * (absent = not curated = keep all); `filterImportedTeamSkills` applies the gate. Kept pure so
 * they are testable without a network clone — the gated repo set is otherwise a vendor default.
 */

const OM = 'open-mercato/skills';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function teamSkill(name: string, repo: string): Skill {
  return {
    name,
    body: `${name} body`,
    path: `${repo}@main:${name}/SKILL.md`,
    source: 'team',
    team: { repo, ref: 'main', path: `${name}/SKILL.md`, dir: true },
  };
}

function localSkill(name: string): Skill {
  return { name, body: `${name} body`, path: `/repo/.ai/cezar/skills/${name}.md`, source: 'cezar' };
}

describe('readImportedSkills', () => {
  it('returns the string names from a well-formed array', () => {
    expect(readImportedSkills({ importedSkills: ['pr-create', 'code-review'] })).toEqual([
      'pr-create',
      'code-review',
    ]);
  });

  it('returns undefined for a missing key — not curated, so the caller keeps all', () => {
    expect(readImportedSkills({})).toBeUndefined();
  });

  it('returns undefined for a non-array (a hand-edited file) — the safe, keep-all reading', () => {
    expect(readImportedSkills({ importedSkills: 'pr-create' })).toBeUndefined();
  });

  it('distinguishes an explicit empty array (curated to nothing) from absent', () => {
    expect(readImportedSkills({ importedSkills: [] })).toEqual([]);
  });

  it('drops non-string and empty entries rather than throwing', () => {
    expect(readImportedSkills({ importedSkills: ['ok', 42, '', null, 'fine'] })).toEqual(['ok', 'fine']);
  });
});

describe('filterImportedTeamSkills', () => {
  const gated = new Set([OM]);

  it('keeps every gated-repo skill when not curated (undefined) — opt-out default, no upgrade break', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, undefined).map((s) => s.name)).toEqual([
      'pr-create',
      'code-review',
    ]);
  });

  it('drops a gated-repo skill once curated away (explicit empty array)', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual([]);
  });

  it('keeps only the named skills from a gated repo when curated', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, ['code-review']).map((s) => s.name)).toEqual([
      'code-review',
    ]);
  });

  it('keeps every skill from a repo that is not gated (custom team repo auto-loads)', () => {
    const skills = [teamSkill('alpha', 'acme/team-skills'), teamSkill('beta', 'acme/team-skills')];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('never gates a local skill (no team field), even when curated to nothing', () => {
    const skills = [localSkill('house-rules'), teamSkill('pr-create', OM)];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual(['house-rules']);
  });

  it('gates nothing when the gated set is empty (repo configured its own skillsRepos)', () => {
    const skills = [teamSkill('pr-create', OM)];
    expect(filterImportedTeamSkills(skills, new Set(), []).map((s) => s.name)).toEqual(['pr-create']);
  });
});

describe('discoverSkills local entrypoints', () => {
  it('recognizes only scalar true as the interactive composer hint', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'true.md'), '---\r\ninteractive: "true"\r\n---\r\nBody');
    await writeFile(join(skillsDir, 'false.md'), '---\ninteractive: false\n---\nBody');
    await writeFile(join(skillsDir, 'array.md'), '---\ninteractive: [true]\n---\nBody');
    await writeFile(join(skillsDir, 'yes.md'), '---\ninteractive: yes\n---\nBody');
    await writeFile(join(skillsDir, 'missing.md'), 'Body');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'cezar');
    expect(skills.find((skill) => skill.name === 'true')).toMatchObject({
      interactive: true,
      body: 'Body',
    });
    for (const name of ['false', 'array', 'yes', 'missing']) {
      expect(skills.find((skill) => skill.name === name)?.interactive).toBeUndefined();
    }
  });

  it('keeps flat and SKILL.md skills while excluding nested reference files', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    await mkdir(join(skillsDir, 'om-example/references'), { recursive: true });
    await mkdir(join(skillsDir, 'legacy/nested'), { recursive: true });
    await writeFile(join(skillsDir, 'flat.md'), '# Flat skill');
    await writeFile(join(skillsDir, 'legacy/nested/legacy.md'), '# Legacy skill');
    await writeFile(join(skillsDir, 'om-example/SKILL.md'), '# Example skill');
    await writeFile(join(skillsDir, 'om-example/references/agentic-setup.md'), '# Supporting doc');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'cezar');

    expect(skills.map((skill) => skill.name)).toEqual(['flat', 'legacy', 'om-example']);
    expect(skills.some((skill) => skill.name === 'agentic-setup')).toBe(false);
  });

  it('follows npx-skills directory mirrors and deduplicates them by skill name', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const canonicalDir = join(repoRoot, '.agents/skills/om-example');
    const mirrorRoot = join(repoRoot, '.claude/skills');
    await mkdir(canonicalDir, { recursive: true });
    await mkdir(mirrorRoot, { recursive: true });
    await writeFile(join(canonicalDir, 'SKILL.md'), '# Example skill');
    await symlink('../../.agents/skills/om-example', join(mirrorRoot, 'om-example'), 'dir');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.name === 'om-example');

    expect(skills).toHaveLength(1);
    expect(skills[0]?.source).toBe('agents');
  });
});

/**
 * The seal an e2e fixture repo relies on (#32): `"skillsRepos": []` in `.ai/cezar/config.json`
 * must empty the team catalog OUTRIGHT — no clone, no listing, nothing merged into
 * `discoverSkills`. Without it a spec-owned `cezar serve` reads the collection cached in the
 * developer's `$HOME` (`bareDirFor` keys off `homedir()`, which `CEZ_HOME` cannot contain), so
 * `new-task.e2e.ts` saw `om-apply-upgrade-notes` where its fixture had written `spec-writer`.
 *
 * The positive control is the load-bearing half: on a machine with a cold cache the negative
 * assertion passes for the wrong reason, so each case first proves the SAME code path does
 * surface a team skill when a source is configured. `HOME` is redirected to a throwaway
 * directory rather than the developer's real one — `~/.cache/cez/skills` is never read, written,
 * or deleted here, and the local source repo keeps the whole thing offline.
 */
describe('discoverSkills team-skill seal', () => {
  /** A real git repo defining one skill, cloneable over a plain local path. */
  async function skillsSourceRepo(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-skills-src-'));
    tempDirs.push(dir);
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'SKILL.md'), `---\ndescription: from the team repo\n---\n\nBody`);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.email=t@cezar.test', '-c', 'user.name=t', ...args], {
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'skills');
    return dir;
  }

  async function repoWith(skillsRepos: unknown): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-consumer-'));
    tempDirs.push(repoRoot);
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    await writeFile(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ skillsRepos }));
    return repoRoot;
  }

  /** Run `body` with `homedir()` pointed at a throwaway directory, and hand it that path. */
  async function withThrowawayHome<T>(body: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), 'cezar-skills-home-'));
    tempDirs.push(home);
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home; // os.homedir() reads this one on win32
    try {
      return await body(home);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('surfaces a configured team skill (the positive control the seal is measured against)', async () => {
    await withThrowawayHome(async (home) => {
      const source = await skillsSourceRepo('team-only-skill');
      const repoRoot = await repoWith([{ repo: source, ref: 'main' }]);

      await waitForTeamSkills(repoRoot);
      const skills = await discoverSkills(repoRoot);

      expect(skills.filter((skill) => skill.source === 'team').map((skill) => skill.name)).toEqual([
        'team-only-skill',
      ]);
      expect(existsSync(join(home, '.cache/cez/skills'))).toBe(true);
    });
  }, 30_000);

  it('contributes no team skill — and clones nothing — when skillsRepos is empty', async () => {
    await withThrowawayHome(async (home) => {
      // Warm the same throwaway cache first, so "no team skill" cannot pass merely because
      // this machine has never cloned one.
      const source = await skillsSourceRepo('team-only-skill');
      await waitForTeamSkills(await repoWith([{ repo: source, ref: 'main' }]));
      const cache = join(home, '.cache/cez/skills');
      const warmed = await readdir(cache);
      expect(warmed).toHaveLength(1);

      const sealed = await repoWith([]);
      await waitForTeamSkills(sealed);
      const skills = await discoverSkills(sealed);

      expect(skills.filter((skill) => skill.source === 'team')).toEqual([]);
      // The cold-cache race closes here too: an empty source list is not "clone, then find
      // nothing" — `loadTeamSkills` iterates nothing, so there is no background clone whose
      // arrival could change the answer between two reads.
      expect(await readdir(cache)).toEqual(warmed);
    });
  }, 30_000);

  it('needs the seal: a repo that declares nothing inherits the vendor source', async () => {
    // The leak's entry point. A fixture repo writes `.ai/skills/*` and no config, so its
    // sources are `DEFAULT_SKILLS_REPOS` — `open-mercato/skills`, whose bare clone in the
    // developer's `$HOME` is exactly what showed up in the fixture's catalog.
    const bare = await mkdtemp(join(tmpdir(), 'cezar-skills-unsealed-'));
    tempDirs.push(bare);
    expect((await loadConfig(bare)).skillsRepos).toEqual(DEFAULT_SKILLS_REPOS);
  });
});
