import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from '../../../src/actions/autofix/worktree.js';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * Regression for the stale-local-branch leak: when a prior autofix run dies
 * after the autosaver committed (but before squash/push), the local branch
 * survives in the shared clone with the autosaver's commits. The next run
 * must start fresh from baseBranch — not inherit those commits — or the
 * verify-in-repo step will see the prior attempt's fix and skip the run.
 */
describe('createWorktree — resetBranch on a stale local branch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cezar-reset-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@cezar.dev']);
    await git(repo, ['config', 'user.name', 'cezar test']);
    await writeFile(join(repo, 'README'), 'initial\n');
    await git(repo, ['add', 'README']);
    await git(repo, ['commit', '-q', '-m', 'initial']);
    // Simulate a prior failed autofix attempt that left a local branch with
    // an autosaver commit on it.
    await git(repo, ['checkout', '-q', '-b', 'autofix/cezar-issue-99']);
    await writeFile(join(repo, 'leftover.ts'), 'autosave from previous run\n');
    await git(repo, ['add', 'leftover.ts']);
    await git(repo, ['commit', '-q', '-m', 'cezar: autosave (fix)']);
    // Return to main so the stale branch is just sitting in refs.
    await git(repo, ['checkout', '-q', 'main']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('resetBranch:true deletes the stale local branch and starts from baseBranch', async () => {
    const wt = await createWorktree({
      repoRoot: repo,
      branch: 'autofix/cezar-issue-99',
      baseBranch: 'main',
      remote: 'origin',
      fetchRemote: false, // no remote in this fixture
      resetBranch: true,
    });

    try {
      // Worktree HEAD must equal main (no autosave commit inherited).
      const wtHead = await git(wt.path, ['rev-parse', 'HEAD']);
      const mainHead = await git(repo, ['rev-parse', 'main']);
      expect(wtHead).toBe(mainHead);
      // The leftover file from the prior run must NOT be present.
      const tree = await git(wt.path, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(tree).not.toContain('leftover.ts');
      // And only one commit (initial) is reachable from HEAD.
      const count = await git(wt.path, ['rev-list', '--count', 'HEAD']);
      expect(count).toBe('1');
    } finally {
      await wt.dispose();
    }
  });

  it('resetBranch:false (CI-followup path) inherits the existing branch', async () => {
    // The CI-followup call sites pass resetBranch:false on purpose — they're
    // extending a real PR branch on origin. This test pins that behavior.
    const wt = await createWorktree({
      repoRoot: repo,
      branch: 'autofix/cezar-issue-99',
      baseBranch: 'main',
      remote: 'origin',
      fetchRemote: false,
      resetBranch: false,
    });

    try {
      const tree = await git(wt.path, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(tree).toContain('leftover.ts');
      const count = await git(wt.path, ['rev-list', '--count', 'HEAD']);
      expect(count).toBe('2');
    } finally {
      await wt.dispose();
    }
  });
});
