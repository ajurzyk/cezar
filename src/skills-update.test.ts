import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOpenMercatoSkillsSource, SkillsUpdateService } from './skills-update.js';

const oldDryRun = process.env.CEZ_DRY_RUN;
afterEach(() => { if (oldDryRun === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = oldDryRun; });

async function fixture(project: unknown, global?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'cez-skills-update-'));
  const home = join(root, 'home'); const repo = join(root, 'repo');
  await mkdir(join(home, '.agents'), { recursive: true }); await mkdir(repo);
  if (project !== undefined) await writeFile(join(repo, 'skills-lock.json'), typeof project === 'string' ? project : JSON.stringify(project));
  if (global !== undefined) await writeFile(join(home, '.agents', '.skill-lock.json'), typeof global === 'string' ? global : JSON.stringify(global));
  return { home, repo };
}

describe('SkillsUpdateService', () => {
  beforeEach(() => { process.env.CEZ_DRY_RUN = '0'; });

  it('matches only canonical Open Mercato GitHub sources', () => {
    expect(['open-mercato/skills', 'https://github.com/open-mercato/skills', 'https://github.com/open-mercato/skills.git'].every(isOpenMercatoSkillsSource)).toBe(true);
    expect(['evil/open-mercato/skills', 'https://github.com.evil.test/open-mercato/skills', 'git@github.com:open-mercato/skills.git'].some(isOpenMercatoSkillsSource)).toBe(false);
  });

  it('fails closed for malformed and unknown locks without executing', async () => {
    for (const value of ['{oops', { version: 99, skills: {} }, { version: 3, nope: {} }]) {
      const { home, repo } = await fixture(value); const run = vi.fn();
      const state = await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => '/npx' }).check(repo);
      expect(run).not.toHaveBeenCalled(); expect(state.scopes[0]?.status).toBe('unavailable');
    }
  });

  it('groups mixed provenance, sorts and deduplicates fixed arguments', async () => {
    const lock = { version: 3, skills: { zed: { source: 'open-mercato/skills' }, other: { source: 'acme/skills' }, alpha: { sourceUrl: 'https://github.com/open-mercato/skills' } } };
    const { home, repo } = await fixture(lock, lock); const calls: string[][] = [];
    const service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/safe/npx', run: async (file, args) => { expect(file).toBe('/safe/npx'); calls.push([...args]); return { stdout: 'alpha update available', stderr: '' }; } });
    const state = await service.check(repo);
    expect(calls).toEqual([['--yes','skills','check','alpha','zed','-p'], ['--yes','skills','check','alpha','zed','-g']]);
    expect(state.scopes.map((s) => s.skills)).toEqual([['alpha'], ['alpha']]);
  });

  it('normalizes offline failures and never leaks command output', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    const run = vi.fn(async () => { throw new Error('fetch failed token=super-secret'); });
    const state = await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => 'npx' }).check(repo);
    expect(state.scopes[0]?.reason).toBe('update check is offline'); expect(JSON.stringify(state)).not.toContain('super-secret');
  });

  it('degrades when npx is absent without executing', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    const run = vi.fn();
    const state = await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => null }).check(repo);
    expect(run).not.toHaveBeenCalled();
    expect(state.status).toBe('unavailable');
    expect(state.scopes.every((scope) => scope.reason === 'npx is unavailable')).toBe(true);
  });

  it('normalizes timeouts', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    const run = vi.fn(async () => { throw Object.assign(new Error('secret'), { killed: true }); });
    const state = await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => 'npx', timeoutMs: 5 }).check(repo);
    expect(state.scopes[0]?.reason).toBe('update check timed out');
  });

  it('degrades when npx is absent and does not inspect manual skill folders', async () => {
    const { home, repo } = await fixture(undefined);
    await mkdir(join(repo, '.agents', 'skills', 'om-manual'), { recursive: true });
    const run = vi.fn();
    const state = await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => null }).check(repo);
    expect(state.status).toBe('unavailable'); expect(state.scopes[0]?.reason).toBe('npx is unavailable'); expect(run).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent checks and honors the TTL', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => { await gate; return { stdout: '', stderr: '' }; });
    const service = new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => 'npx' });
    const a = service.check(repo); const b = service.check(repo); release();
    expect(await a).toBe(await b); await service.check(repo); expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses an exclusive cache lock across service instances', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => 'npx', run: async () => { await gate; return { stdout: '', stderr: '' }; } });
    const secondRun = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const second = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => 'npx', run: secondRun });
    const active = first.check(repo); await vi.waitFor(async () => { await expect(import('node:fs/promises').then((fs) => fs.stat(join(home, '.cache', 'cez', 'skills-update.lock')))).resolves.toBeDefined(); });
    const blocked = await second.check(repo); release(); await active;
    expect(blocked.status).toBe('unavailable'); expect(secondRun).not.toHaveBeenCalled();
  });

  it('returns deterministic dry-run state without files, tools, or network', async () => {
    process.env.CEZ_DRY_RUN = '1'; const run = vi.fn();
    const state = await new SkillsUpdateService({ homeDir: '/missing', run, resolveNpx: async () => { throw new Error('no'); } }).check('/missing');
    expect(state.status).toBe('current'); expect(run).not.toHaveBeenCalled();
  });

  it('recovers a dead cache lock and removes its own lock afterward', async () => {
    const { home, repo } = await fixture({ skills: { om: { source: 'open-mercato/skills' } } });
    const lockPath = join(home, '.cache', 'cez', 'skills-update.lock');
    await mkdir(join(home, '.cache', 'cez'), { recursive: true });
    await writeFile(lockPath, `99999999\n${Date.now()}\n`);
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await new SkillsUpdateService({ homeDir: home, run, resolveNpx: async () => 'npx' }).check(repo);
    expect(run).toHaveBeenCalledOnce();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
