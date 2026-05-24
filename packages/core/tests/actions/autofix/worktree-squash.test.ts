import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, squashCommitsToBase } from '../../../src/actions/autofix/worktree.js';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

describe('squashCommitsToBase', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cezar-squash-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@cezar.dev']);
    await git(repo, ['config', 'user.name', 'cezar test']);
    await writeFile(join(repo, 'README'), 'initial\n');
    await git(repo, ['add', 'README']);
    await git(repo, ['commit', '-q', '-m', 'initial']);
    // Mirror the real autofix flow: a feature branch off main is what the
    // autosaver / squash both operate on (baseRef = main).
    await git(repo, ['checkout', '-q', '-b', 'autofix/test']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('squashes N autosave commits into one commit with the supplied message', async () => {
    // Simulate the autosaver firing twice while the agent edits files.
    await writeFile(join(repo, 'a.ts'), 'fix step 1\n');
    expect(await commitAll(repo, 'cezar: autosave (fix)')).toBeTruthy();
    await writeFile(join(repo, 'b.ts'), 'fix step 2\n');
    expect(await commitAll(repo, 'cezar: autosave (fix)')).toBeTruthy();

    // Two autosave commits above main now exist.
    const before = (await git(repo, ['rev-list', '--count', 'main..HEAD'])).trim();
    expect(before).toBe('2');

    const sha = await squashCommitsToBase(repo, 'main', 'fix: real commit message');
    expect(sha).toBeTruthy();

    // Now there should be exactly one commit above main, with the new message.
    const after = (await git(repo, ['rev-list', '--count', 'main..HEAD'])).trim();
    expect(after).toBe('1');
    const head = await git(repo, ['log', '-1', '--pretty=%s']);
    expect(head).toBe('fix: real commit message');
    // And both files are still present on HEAD.
    const tree = await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tree).toContain('a.ts');
    expect(tree).toContain('b.ts');
  });

  it('returns null when there is no diff against base (fixer truly did nothing)', async () => {
    const sha = await squashCommitsToBase(repo, 'main', 'fix: noop');
    expect(sha).toBeNull();
    // No new commits created.
    const count = (await git(repo, ['rev-list', '--count', 'main..HEAD'])).trim();
    expect(count).toBe('0');
  });
});
