import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autosaveCommit, createWorktree } from './git-worktree.ts';
import { PIPELINE_SOURCE_DIR, provisionPipeline } from './pipeline-seam.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The seam that lets a run act on a tracker without the repository under work
 * carrying the pipeline (#46).
 *
 * The obvious shape — write the files and list them in the worktree's
 * `.git/info/exclude` — is measured false: a linked worktree does not read its
 * own `$GIT_DIR/info/exclude`, and the entry that does work lives in the common
 * dir, i.e. a persistent modification to the repository. What these cases pin is
 * the mechanism that survived: `extensions.worktreeConfig` plus a per-worktree
 * `core.excludesFile`, which is scoped to one worktree and disappears with it.
 *
 * Every case runs against real git rather than a mock, because the whole claim
 * under test is about what git does with a config it is handed.
 */
describe('pipeline delivery seam (#46)', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let savedEnv: Record<string, string | undefined>;

  const git = (cwd: string, args: string[]) => run('git', args, { cwd });
  const status = async (cwd: string, paths: string[] = []) =>
    (await git(cwd, ['status', '--porcelain', ...(paths.length ? ['--', ...paths] : [])])).stdout;

  /** Put a file into the repo's provision directory at the repo-relative path it should land on. */
  const provision = (relativePath: string, contents: string): void => {
    const full = join(repo, PIPELINE_SOURCE_DIR, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-seam-'));
    repo = join(root, 'repo');
    worktree = join(root, 'wt');
    mkdirSync(repo);

    // Seal the fixtures off from the machine's own git configuration the way #38
    // did: a developer whose ~/.gitconfig sets core.excludesFile would otherwise
    // exercise the inheritance path in every case, not just the one that asks for it.
    const emptyConfig = join(root, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    savedEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;

    await git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(repo, ['add', '-A']);
    await git(repo, [...GIT_ID, 'commit', '-q', '-m', 'base']);
    await git(repo, ['worktree', 'add', '-q', worktree, '-b', 'task']);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('is a total no-op for a repository that provisions nothing', async () => {
    const before = readFileSync(join(repo, '.git', 'config'), 'utf8');

    expect(await provisionPipeline(repo, worktree)).toEqual({ status: 'inactive' });

    // Not even the extension flag: a repo that never asked for the seam must come
    // out of a run with its .git/config byte-identical.
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('delivers the pipeline into the worktree and hides it from git there', async () => {
    provision('.ai/trackers/forgejo.md', '# descriptor\n');
    provision('.ai/agentic.config.json', '{"tracker":"forgejo"}\n');

    const outcome = await provisionPipeline(repo, worktree);

    expect(outcome).toEqual({
      status: 'delivered',
      delivered: ['.ai/agentic.config.json', '.ai/trackers/forgejo.md'],
      skippedTracked: [],
    });
    // Readable from inside the worktree — the only path the skills know.
    expect(readFileSync(join(worktree, '.ai/trackers/forgejo.md'), 'utf8')).toBe('# descriptor\n');
    expect(readFileSync(join(worktree, '.ai/agentic.config.json'), 'utf8')).toBe(
      '{"tracker":"forgejo"}\n',
    );
    // ...and invisible to git in that worktree.
    expect(await status(worktree)).toBe('');
    await git(worktree, ['add', '-A']);
    expect((await git(worktree, ['diff', '--cached', '--name-only'])).stdout).toBe('');
  });

  it('leaves no pipeline file in the branch diff after a run commits its work', async () => {
    provision('.ai/trackers/forgejo.md', '# descriptor\n');
    provision('.ai/agentic.config.json', '{"tracker":"forgejo"}\n');
    await provisionPipeline(repo, worktree);

    // A run's own work, committed the way `autosaveCommit` does it.
    writeFileSync(join(worktree, 'feature.ts'), 'export const x = 1\n');
    await git(worktree, ['add', '-A']);
    await git(worktree, [...GIT_ID, 'commit', '-q', '-m', 'cezar autosave (run finalize)']);

    const changed = (await git(worktree, ['diff', 'main..HEAD', '--name-only'])).stdout
      .split('\n')
      .filter(Boolean);
    expect(changed).toEqual(['feature.ts']);
    expect(changed.filter((path) => path.startsWith('.ai/'))).toEqual([]);
  });

  it('hides the pipeline only inside the run worktree, never in the main checkout', async () => {
    provision('.ai/trackers/forgejo.md', '# descriptor\n');
    await provisionPipeline(repo, worktree);

    // The same path, authored by the user in their own checkout, still shows up.
    mkdirSync(join(repo, '.ai/trackers'), { recursive: true });
    writeFileSync(join(repo, '.ai/trackers/forgejo.md'), '# mine\n');
    expect(await status(repo)).toContain('.ai/');
    await git(repo, ['add', '-A']);
    expect((await git(repo, ['diff', '--cached', '--name-only'])).stdout).toContain(
      '.ai/trackers/forgejo.md',
    );
  });

  it('keeps the excludes that were already effective before it took the file over', async () => {
    const userExcludes = join(root, 'user-excludes');
    writeFileSync(userExcludes, '# the developer\nscratch-*.log\n');
    await git(repo, ['config', 'core.excludesFile', userExcludes]);
    provision('.ai/trackers/forgejo.md', '# descriptor\n');

    await provisionPipeline(repo, worktree);

    // Setting a per-worktree core.excludesFile overrides the inherited one, so the
    // seam composes rather than replaces — otherwise it would quietly un-ignore
    // everything the user ignores.
    writeFileSync(join(worktree, 'scratch-run.log'), 'noise\n');
    expect(await status(worktree)).toBe('');
  });

  it('refuses to overwrite a path the repository already tracks, and says which', async () => {
    // cezar's own repo is exactly this case: it tracks its pipeline already.
    mkdirSync(join(repo, '.ai'), { recursive: true });
    writeFileSync(join(repo, '.ai/agentic.config.json'), '{"tracker":"github"}\n');
    await git(repo, ['add', '-A']);
    await git(repo, [...GIT_ID, 'commit', '-q', '-m', 'own pipeline']);
    await git(worktree, ['merge', '-q', 'main']);
    provision('.ai/agentic.config.json', '{"tracker":"forgejo"}\n');
    provision('.ai/trackers/forgejo.md', '# descriptor\n');

    const outcome = await provisionPipeline(repo, worktree);

    expect(outcome).toEqual({
      status: 'delivered',
      delivered: ['.ai/trackers/forgejo.md'],
      skippedTracked: ['.ai/agentic.config.json'],
    });
    // Untouched: an excludes entry cannot hide a tracked file, so writing it would
    // have put a pipeline edit straight into the run's diff.
    expect(readFileSync(join(worktree, '.ai/agentic.config.json'), 'utf8')).toBe(
      '{"tracker":"github"}\n',
    );
    expect(await status(worktree)).toBe('');
  });

  it('delivers nothing when git documents the extension as unsafe for this repo', async () => {
    // git-config(1) requires core.bare/core.worktree to be migrated into the main
    // worktree's config.worktree before extensions.worktreeConfig is enabled. The
    // seam declines rather than performing that migration on someone's repository.
    await git(repo, ['config', 'core.worktree', repo]);
    provision('.ai/trackers/forgejo.md', '# descriptor\n');

    const outcome = await provisionPipeline(repo, worktree);

    expect(outcome.status).toBe('refused');
    expect(outcome).toHaveProperty('reason', expect.stringContaining('core.worktree'));
    expect(existsSync(join(worktree, '.ai/trackers/forgejo.md'))).toBe(false);
    // Read the file rather than `git config --get`, which exits 1 on a missing key
    // and so cannot distinguish "not set" from "git failed".
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('worktreeConfig');
  });

  it('is idempotent across the restarts a run survives', async () => {
    const userExcludes = join(root, 'user-excludes');
    writeFileSync(userExcludes, 'scratch-*.log\n');
    await git(repo, ['config', 'core.excludesFile', userExcludes]);
    provision('.ai/trackers/forgejo.md', '# descriptor\n');

    const first = await provisionPipeline(repo, worktree);
    const second = await provisionPipeline(repo, worktree);

    expect(second).toEqual(first);
    expect(await status(worktree)).toBe('');
    // The second pass must inherit the USER's excludes, not the file the first
    // pass installed — otherwise re-provisioning silently un-ignores everything
    // the developer ignores, and only from the second run onward.
    writeFileSync(join(worktree, 'scratch-run.log'), 'noise\n');
    expect(await status(worktree)).toBe('');
  });
});

/**
 * The wiring, not the seam: `createWorktree` is the single choke point every run
 * worktree passes through, so pinning the call here is what makes the guarantee
 * hold for the run flow and for retention's reattach at once.
 */
describe('createWorktree delivers the provisioned pipeline (#46)', () => {
  let root: string;
  let repo: string;
  let savedEnv: Record<string, string | undefined>;

  const git = (cwd: string, args: string[]) => run('git', args, { cwd });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-seam-wire-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    const emptyConfig = join(root, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    savedEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    await git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(repo, ['add', '-A']);
    await git(repo, [...GIT_ID, 'commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('a simulated run ends with the descriptor readable and absent from its diff', async () => {
    const source = join(repo, PIPELINE_SOURCE_DIR, '.ai/trackers');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'forgejo.md'), '# Tracker provider: Forgejo\n');

    const info = await createWorktree(repo, 'ab12cd34-0000-0000-0000-000000000000', 'main');

    expect(readFileSync(join(info.path, '.ai/trackers/forgejo.md'), 'utf8')).toContain('Forgejo');
    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1\n');
    expect(await autosaveCommit(info.path, 'pre-PR')).toBe('committed');
    expect(
      (await git(info.path, ['diff', 'main..HEAD', '--name-only'])).stdout.split('\n').filter(Boolean),
    ).toEqual(['feature.ts']);
  });

  it('leaves a repository that provisions nothing exactly as it was', async () => {
    const before = readFileSync(join(repo, '.git', 'config'), 'utf8');

    const info = await createWorktree(repo, 'ff99ee88-0000-0000-0000-000000000000', 'main');

    expect(existsSync(info.path)).toBe(true);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(before);
  });
});
