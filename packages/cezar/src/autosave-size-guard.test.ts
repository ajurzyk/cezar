import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveCommit } from './git-worktree.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Small enough that the fixtures cost bytes, not megabytes — the guard is size-agnostic. */
const LIMIT = 1024;
const OVERSIZED = Buffer.alloc(LIMIT * 4, 0);

/**
 * `autosaveCommit` stages with `git add -A`, so before this guard any large new
 * artefact left in the worktree — a core dump, a heap snapshot, a downloaded
 * fixture — landed permanently in the run branch and in every PR opened from it.
 * Two observed `run finalize` autosaves carried three 28 401 664 B core dumps
 * each, ~162 MiB in total.
 *
 * The guard holds those paths back out of the index and commits the rest: a
 * skipped recovery point is temporary, a committed 27 MB blob is not.
 */
describe('autosave size guard (#41)', () => {
  let repo: string;
  let warn: ReturnType<typeof vi.spyOn>;

  const git = (args: string[]) => run('git', args, { cwd: repo });
  const subject = async () => (await git(['log', '-1', '--format=%s'])).stdout.trim();
  const head = async () => (await git(['rev-parse', 'HEAD'])).stdout.trim();
  /** Paths the tip commit actually holds. */
  const tracked = async () =>
    (await git(['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean);

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-size-'));
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  it('holds back an oversized new file and still commits the rest', async () => {
    writeFileSync(join(repo, 'small.txt'), 'keep me\n');
    writeFileSync(join(repo, 'core.big'), OVERSIZED);

    expect(await autosaveCommit(repo, 'turn end', LIMIT)).toBe('committed');

    expect(await subject()).toBe('cezar autosave (turn end)');
    expect(await tracked()).toContain('small.txt');
    expect(await tracked()).not.toContain('core.big');
    // Held back, not deleted: the next flush would sweep it again if it shrank.
    expect((await git(['status', '--porcelain'])).stdout).toContain('?? core.big');
  });

  it('leaves a tracked file alone however large it grew', async () => {
    writeFileSync(join(repo, 'grown.txt'), 'placeholder\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'add grown.txt']);
    writeFileSync(join(repo, 'grown.txt'), OVERSIZED);

    expect(await autosaveCommit(repo, 'turn end', LIMIT)).toBe('committed');

    // `M`, never `A`: the guard reads new-vs-HEAD only, so history that already
    // carries the path keeps carrying it — dropping it would rewrite content.
    expect(await tracked()).toContain('grown.txt');
    expect(warn).not.toHaveBeenCalled();
  });

  it('says which paths it held back', async () => {
    writeFileSync(join(repo, 'small.txt'), 'keep me\n');
    writeFileSync(join(repo, 'core.big'), OVERSIZED);
    writeFileSync(join(repo, 'we ird.big'), OVERSIZED);

    await autosaveCommit(repo, 'periodic', LIMIT);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('core.big'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('we ird.big'));
  });

  it('commits normally when nothing exceeds the threshold', async () => {
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, 'small.txt'), 'keep me\n');
    writeFileSync(join(repo, 'nested', 'deep.txt'), 'me too\n');

    expect(await autosaveCommit(repo, 'run finalize', LIMIT)).toBe('committed');

    expect(await subject()).toBe('cezar autosave (run finalize)');
    expect(await tracked()).toContain('small.txt');
    expect(await tracked()).toContain('nested/deep.txt');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns nothing-to-do when the oversized file was the only change', async () => {
    const before = await head();
    writeFileSync(join(repo, 'core.big'), OVERSIZED);

    // An empty index makes `git commit` fail, which callers surface to the user
    // as a lost recovery point (createDraftPr). There is nothing to recover.
    expect(await autosaveCommit(repo, 'pre-PR', LIMIT)).toBe('nothing-to-do');

    expect(await head()).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('core.big'));
  });
});
