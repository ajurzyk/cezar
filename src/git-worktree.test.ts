import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { branchFor, createWorktree, parseShortstat, worktreeShortstat } from './git-worktree.js';

const run = promisify(execFile);

/** Commit as a fixed identity so the fixture repo works on bare CI machines. */
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const worktreeRoots: string[] = [];

async function fixtureRepo(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  worktreeRoots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of worktreeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseShortstat', () => {
  const cases: Array<{ name: string; input: string; expected: { adds: number; dels: number; files: number } }> = [
    {
      name: 'full form',
      input: ' 3 files changed, 10 insertions(+), 2 deletions(-)',
      expected: { adds: 10, dels: 2, files: 3 },
    },
    {
      name: 'singulars',
      input: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      expected: { adds: 1, dels: 1, files: 1 },
    },
    {
      name: 'insertions only',
      input: ' 2 files changed, 7 insertions(+)',
      expected: { adds: 7, dels: 0, files: 2 },
    },
    {
      name: 'deletions only',
      input: ' 1 file changed, 5 deletions(-)',
      expected: { adds: 0, dels: 5, files: 1 },
    },
    {
      name: 'empty diff prints nothing at all',
      input: '',
      expected: { adds: 0, dels: 0, files: 0 },
    },
    {
      name: 'trailing newline (raw git stdout)',
      input: ' 4 files changed, 12 insertions(+), 3 deletions(-)\n',
      expected: { adds: 12, dels: 3, files: 4 },
    },
    {
      // Mode-only / rename-only changes: files changed without either counter.
      name: 'files changed with no line counters',
      input: ' 1 file changed, 0 insertions(+), 0 deletions(-)',
      expected: { adds: 0, dels: 0, files: 1 },
    },
  ];

  // Note on locales: `--shortstat` is porcelain whose wording git never
  // localizes, so matching the English words is stable by contract.
  it.each(cases)('$name', ({ input, expected }) => {
    expect(parseShortstat(input)).toEqual(expected);
  });
});

describe('createWorktree recovery (real git)', () => {
  it('is idempotent when the task worktree is already registered', async () => {
    const repo = await fixtureRepo('cez-worktree-idempotent-');
    const runId = '11111111-1111-4111-8111-111111111111';

    const first = await createWorktree(repo, runId, 'main');
    const second = await createWorktree(repo, runId, 'main');

    expect(second).toEqual(first);
    const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
    expect(listed.stdout.match(new RegExp(`branch refs/heads/${branchFor(runId)}`, 'g'))).toHaveLength(1);
  });

  it('reattaches a surviving task branch after its worktree directory is deleted', async () => {
    const repo = await fixtureRepo('cez-worktree-reattach-');
    const runId = '22222222-2222-4222-8222-222222222222';
    const first = await createWorktree(repo, runId, 'main');
    writeFileSync(join(first.path, 'progress.txt'), 'preserved\n');
    await run('git', ['add', '-A'], { cwd: first.path });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'task progress'], { cwd: first.path });

    rmSync(first.path, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], { cwd: repo });

    const recovered = await createWorktree(repo, runId, 'main');
    const log = await run('git', ['log', '-1', '--format=%s'], { cwd: recovered.path });
    expect(recovered.path).toBe(first.path);
    expect(log.stdout.trim()).toBe('task progress');
    expect(() => writeFileSync(join(recovered.path, 'still-usable.txt'), 'yes\n')).not.toThrow();
  });

  it('preserves an unregistered non-empty managed path instead of deleting it', async () => {
    const repo = await fixtureRepo('cez-worktree-preserve-');
    const runId = '33333333-3333-4333-8333-333333333333';
    const path = join(repo, '.ai/cezar/worktrees', runId);
    const marker = join(path, 'uncommitted.txt');
    mkdirSync(path, { recursive: true });
    writeFileSync(marker, 'do not delete\n');

    await expect(createWorktree(repo, runId, 'main')).rejects.toThrow(
      'managed worktree path already exists and could not be repaired',
    );
    expect(readFileSync(marker, 'utf8')).toBe('do not delete\n');
  });
});

describe('worktreeShortstat (real git)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-shortstat-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repo });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    await run('git', ['checkout', '-q', '-b', 'work'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('counts modified + untracked (intent-to-add) files against the base', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(repo, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    const stat = await worktreeShortstat(repo, 'main');
    expect(stat).toEqual({ adds: 3, dels: 1, files: 2 });
  });

  it('answers all zeros for a clean tree, not null', async () => {
    await run('git', ['checkout', '-q', '--', '.'], { cwd: repo });
    rmSync(join(repo, 'new.txt'), { force: true });
    // Drop the intent-to-add entry the previous test staged.
    await run('git', ['reset', '-q'], { cwd: repo });
    const stat = await worktreeShortstat(repo, 'main');
    expect(stat).toEqual({ adds: 0, dels: 0, files: 0 });
  });

  it('answers null when the path is not a git worktree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-notgit-'));
    try {
      expect(await worktreeShortstat(plain, 'main')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
