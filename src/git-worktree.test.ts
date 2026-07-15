import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseShortstat, worktreeShortstat } from './git-worktree.js';

const run = promisify(execFile);

/** Commit as a fixed identity so the fixture repo works on bare CI machines. */
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

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
