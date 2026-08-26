import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Delivery seam for the agent pipeline (#46).
 *
 * A run's agent reaches its tracker through two files sitting at fixed
 * repo-relative paths — `.ai/agentic.config.json` and
 * `.ai/trackers/<tracker>.md`. That is the only path the ~30 `om-*` skills know,
 * so the files must be readable from inside the run's worktree. They must also
 * never reach the repository under work: it is the subject of the run, not a
 * cezar client, and a pipeline file committed onto a run's branch shows up in
 * the pull request that branch opens.
 *
 * The obvious shape does not work. Measured 2026-08-26 on git 2.47.3:
 *
 *  - A linked worktree does NOT read its own `$GIT_DIR/info/exclude`; a file
 *    listed there was still staged by `git add -A`.
 *  - The entry that does take effect lives in the COMMON dir — the target
 *    repository's own `.git`, shared by every worktree and surviving the run.
 *    That is a persistent modification to someone else's repository.
 *
 * What survives is `extensions.worktreeConfig` plus `git config --worktree
 * core.excludesFile`, which is scoped to one worktree and disappears with it:
 *
 *     $ git -C wt   status --porcelain      # (nothing)
 *     $ git -C main status --porcelain
 *     ?? .ai/
 *
 * Hiding through excludes rather than through `autosaveCommit` is deliberate.
 * `autosaveCommit` is not the only thing that stages in a run's worktree — the
 * agent runs its own `git add`, and so do `worktreeDiff`, `worktreeShortstat`
 * and `server/git-changes.ts` (all three issue `git add -N .`). An exclusion
 * taught to one of them would leak through the others; an excludes file is read
 * by every one of them, because it is read by git.
 *
 * Nothing here throws: a seam that cannot prove the files are hidden delivers
 * nothing and says why, and the run proceeds without a tracker rather than with
 * a poisoned branch.
 */

/**
 * Where a repository provisions the pipeline it wants delivered, mirroring the
 * repo root: `.ai/cezar/pipeline/.ai/trackers/forgejo.md` lands on
 * `.ai/trackers/forgejo.md`. Under `.ai/cezar/`, which cezar's own installer
 * already gitignores wholesale in every project it touches, so the source side
 * of the seam is invisible without any help from this module.
 *
 * A repository with no such directory gets `inactive` and is not touched at all
 * — the seam is opt-in per target repo, and every repo that carries its own
 * committed pipeline (cezar's included) keeps behaving exactly as before.
 */
export const PIPELINE_SOURCE_DIR = '.ai/cezar/pipeline';

/** Basename of the composed excludes file, written inside the worktree's own git dir. */
const EXCLUDES_FILE = 'cezar-pipeline-excludes';

export type SeamOutcome =
  | { status: 'inactive' }
  | { status: 'delivered'; delivered: string[]; skippedTracked: string[] }
  | { status: 'refused'; reason: string };

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw — degradation is this module's whole policy. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** Every file under `dir`, as paths relative to it, sorted for a stable report. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      // `isDirectory()` on a Dirent does not follow symlinks, so a symlinked
      // directory is copied as the link it is rather than walked into — which
      // also means a link pointing back at the repo cannot fan out.
      if (entry.isDirectory()) await visit(full);
      else out.push(relative(dir, full));
    }
  };
  await visit(dir);
  return out.sort();
}

/**
 * Escape one repo-relative path into a gitignore pattern matching exactly it.
 *
 * The leading `/` anchors to the repo root, so a provisioned
 * `.ai/trackers/forgejo.md` cannot also silence a `trackers/forgejo.md` the
 * project keeps somewhere else. The backslash escapes cover every character
 * gitignore treats as syntax; `#` and `!` only matter in the first column, which
 * is where the anchor would otherwise put them.
 */
function ignorePattern(repoRelative: string): string {
  const escaped = repoRelative
    .split(sep)
    .join('/')
    .replace(/[\\*?[\]!#]/g, (char) => `\\${char}`)
    // A trailing space is significant in gitignore unless escaped.
    .replace(/ $/, '\\ ');
  return `/${escaped}`;
}

/**
 * The excludes file that is in force in `dir` right now — either the configured
 * `core.excludesFile`, or git's fallback when none is configured. Returned so
 * its contents can be carried into the file we are about to put in its place:
 * `core.excludesFile` is a single value, so setting a per-worktree one silences
 * the user's own, and a run that quietly un-ignored a developer's scratch files
 * would be a worse bug than the one this module fixes.
 */
async function effectiveExcludesFile(dir: string): Promise<string> {
  const configured = await git(dir, ['config', '--get', 'core.excludesFile']);
  const value = configured.ok ? configured.stdout.trim() : '';
  if (value) return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'git', 'ignore') : join(homedir(), '.config', 'git', 'ignore');
}

/**
 * git-config(1), `extensions.worktreeConfig`: enabling the extension requires
 * `core.worktree` — and `core.bare` when true — to be moved out of the common
 * config into the MAIN worktree's `config.worktree` first, or the main checkout
 * misreads its own layout. Rewriting someone else's main worktree config is well
 * past what delivering a descriptor should be allowed to do, so the seam checks
 * and declines instead. A normal non-bare checkout has `core.bare = false` and
 * no `core.worktree`, which is why this returns null for every repository the
 * seam is actually aimed at.
 */
async function extensionHazard(repoRoot: string): Promise<string | null> {
  const [bare, worktree] = await Promise.all([
    git(repoRoot, ['config', '--local', '--get', 'core.bare']),
    git(repoRoot, ['config', '--local', '--get', 'core.worktree']),
  ]);
  if (worktree.ok && worktree.stdout.trim()) {
    return 'core.worktree is set in the common config; git-config(1) requires it to be moved into the main worktree config.worktree before extensions.worktreeConfig is enabled';
  }
  if (bare.ok && bare.stdout.trim() === 'true') {
    return 'core.bare is true in the common config; git-config(1) requires it to be moved into the main worktree config.worktree before extensions.worktreeConfig is enabled';
  }
  return null;
}

/**
 * Deliver the repository's provisioned pipeline into one run worktree, hidden
 * from git there.
 *
 * Order matters and is the point: hide first, verify the hiding, and only then
 * write a single byte of pipeline into the worktree. Delivering first would mean
 * that any failure below leaves the files exposed to the next `git add -A` —
 * which is the failure this whole module exists to prevent.
 *
 * Idempotent: re-running rewrites the same excludes file and re-copies the same
 * contents, so the restarts a run survives cost nothing.
 */
export async function provisionPipeline(
  repoRoot: string,
  worktreePath: string,
): Promise<SeamOutcome> {
  const sourceDir = join(repoRoot, PIPELINE_SOURCE_DIR);
  const sources = await walk(sourceDir);
  if (sources.length === 0) return { status: 'inactive' };

  const hazard = await extensionHazard(repoRoot);
  if (hazard) return { status: 'refused', reason: hazard };

  // A tracked path cannot be hidden — excludes only ever apply to untracked
  // files — so writing one would put a pipeline edit straight into the run's
  // diff. Skip it: the repository already carries that file, which is its
  // business, and the constraint is about not ADDING pipeline files.
  const tracked = await git(worktreePath, ['ls-files', '-z', '--', ...sources]);
  const trackedSet = new Set(tracked.ok ? tracked.stdout.split('\0').filter(Boolean) : []);
  const deliverable = sources.filter((path) => !trackedSet.has(path));
  const skippedTracked = sources.filter((path) => trackedSet.has(path));
  if (deliverable.length === 0) {
    return { status: 'delivered', delivered: [], skippedTracked };
  }

  const gitDir = await git(worktreePath, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok || !gitDir.stdout.trim()) {
    return { status: 'refused', reason: 'could not resolve the worktree git dir' };
  }
  const excludesPath = join(gitDir.stdout.trim(), EXCLUDES_FILE);

  // Ask the MAIN worktree, not this one. Asking this one works exactly once: the
  // second call would find the file the first call installed, and inherit our own
  // header instead of the user's patterns — silently un-ignoring everything they
  // ignore, from the second provision onward. `config.worktree` is per-worktree,
  // so it is invisible from `repoRoot`, which is what makes that reading stable.
  const inheritedPath = await effectiveExcludesFile(repoRoot);
  const inherited =
    inheritedPath === excludesPath ? '' : await readFile(inheritedPath, 'utf8').catch(() => '');

  const body = [
    '# Written by cezar. Hides the delivered agent pipeline from this ONE worktree.',
    `# Inherited from ${inheritedPath}:`,
    inherited.trimEnd(),
    '# Delivered pipeline:',
    ...deliverable.map(ignorePattern),
    '',
  ].join('\n');
  await writeFile(excludesPath, body).catch(() => undefined);

  const enabled = await git(repoRoot, ['config', 'extensions.worktreeConfig', 'true']);
  if (!enabled.ok) {
    return { status: 'refused', reason: `could not enable extensions.worktreeConfig: ${enabled.stderr.trim()}` };
  }
  const pointed = await git(worktreePath, ['config', '--worktree', 'core.excludesFile', excludesPath]);
  if (!pointed.ok) {
    return { status: 'refused', reason: `could not set the worktree excludes file: ${pointed.stderr.trim()}` };
  }

  // Prove the negative before creating anything. `check-ignore` answers for
  // paths that do not exist yet, which is exactly the order we want: a path git
  // would still report is a path we must not write.
  const check = await git(worktreePath, ['check-ignore', '--', ...deliverable]);
  const ignored = new Set(check.stdout.split('\n').filter(Boolean));
  const exposed = deliverable.filter((path) => !ignored.has(path));
  if (exposed.length > 0) {
    return {
      status: 'refused',
      reason: `git would still report ${exposed.join(', ')} in this worktree`,
    };
  }

  for (const path of deliverable) {
    const target = join(worktreePath, path);
    await mkdir(dirname(target), { recursive: true }).catch(() => undefined);
    // Copy rather than symlink: a symlink is itself a path git reports, and it
    // would dangle the moment the worktree outlived its source.
    await copyFile(join(sourceDir, path), target).catch(() => undefined);
  }

  // Verify what actually landed, not what we intended to land. A copy that
  // failed above must not be reported as delivered, and a path that turns out
  // visible after the fact is withdrawn rather than left in the branch's way.
  const after = await git(worktreePath, ['status', '--porcelain', '--', ...deliverable]);
  if (after.stdout.trim()) {
    for (const path of deliverable) await rm(join(worktreePath, path), { force: true });
    return {
      status: 'refused',
      reason: `git reported the delivered pipeline after writing it: ${after.stdout.trim()}`,
    };
  }

  return { status: 'delivered', delivered: deliverable, skippedTracked };
}
