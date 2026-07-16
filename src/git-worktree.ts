import { execFile } from 'node:child_process';
import { existsSync, realpathSync, type Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/**
 * Git worktree per task (spec 006). Each run gets its own branch
 * `cez/<id8>` checked out into `.ai/cezar/worktrees/<runId>` so agents never
 * touch the user's working tree. Pattern ported from github-janitor's
 * `git.ts` (createWorktree / autosaveCommit), minus the bare clone — we're
 * already inside a working copy. Everything degrades: helpers never throw
 * except `createWorktree`, whose failure the caller turns into a note.
 */

/** Repo-relative home of all task worktrees (gitignored via .ai/cezar/.gitignore). */
export const WORKTREES_DIR = '.ai/cezar/worktrees';

const DIFF_CAP = 400_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

/** Run git, never throw — degradation is the caller's policy. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

export function branchFor(runId: string): string {
  return `cez/${runId.slice(0, 8)}`;
}

/**
 * Resolve the configured base branch to something `git worktree add` can
 * fork from: the branch itself, else its remote-tracking ref (base exists
 * only on origin), else null — the caller falls back to the current branch
 * with a note. Never throws.
 */
export async function resolveBaseRef(repoRoot: string, base: string): Promise<string | null> {
  for (const ref of [base, `origin/${base}`]) {
    const res = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (res.ok) return ref;
  }
  return null;
}

export function worktreePathFor(repoRoot: string, runId: string): string {
  return join(repoRoot, WORKTREES_DIR, runId);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Branch name the worktree was forked from (commit sha when HEAD was detached). */
  baseBranch: string;
}

/** Parse `git worktree list --porcelain` without assuming paths contain no spaces. */
async function registeredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const res = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (!line && current) {
      worktrees.push(current);
      current = undefined;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function worktreeInfo(path: string, branch: string, baseBranch: string): WorktreeInfo {
  return { path, branch, baseBranch };
}

/** Git canonicalizes symlinked path prefixes (macOS `/var` → `/private/var`). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Establish the task worktree idempotently. Besides the fresh
 * `git worktree add -b` path, recover the two normal restart/deletion cases:
 * reuse an already-registered task worktree, or reattach a surviving task
 * branch after its directory/registration was removed. Existing non-empty
 * unregistered paths are never deleted because they may hold recoverable
 * uncommitted work.
 */
export async function createWorktree(
  repoRoot: string,
  runId: string,
  baseBranch: string,
): Promise<WorktreeInfo> {
  let base = baseBranch;
  if (!base || base === 'HEAD') {
    // Detached HEAD — pin the base to the current commit so the record and
    // later diffs stay meaningful.
    const head = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    base = head.stdout.trim();
  }
  const branch = branchFor(runId);
  const absolutePath = join(canonicalPath(repoRoot), WORKTREES_DIR, runId);
  const branchRef = `refs/heads/${branch}`;

  // A missing directory can leave stale administrative metadata behind.
  // Prune first so the checks below describe the filesystem as it exists now.
  await git(repoRoot, ['worktree', 'prune']);
  let registered = await registeredWorktrees(repoRoot);
  let atPath = registered.find((item) => canonicalPath(item.path) === canonicalPath(absolutePath));
  if (atPath) {
    if (atPath.branch !== branchRef) {
      throw new Error(
        `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
      );
    }
    return worktreeInfo(atPath.path, branch, base);
  }

  // If the directory survived but its administrative entry did not, let Git
  // repair it. This is non-destructive; an unrepairable non-empty directory is
  // preserved and reported instead of being recursively removed.
  if (existsSync(absolutePath)) {
    await git(repoRoot, ['worktree', 'repair', absolutePath]);
    registered = await registeredWorktrees(repoRoot);
    atPath = registered.find((item) => canonicalPath(item.path) === canonicalPath(absolutePath));
    if (atPath) {
      if (atPath.branch !== branchRef) {
        throw new Error(
          `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
        );
      }
      return worktreeInfo(atPath.path, branch, base);
    }
    const entries = await readdir(absolutePath).catch(() => ['unreadable']);
    if (entries.length > 0) {
      throw new Error(`managed worktree path already exists and could not be repaired: ${absolutePath}`);
    }
  }

  const branchExists = await git(repoRoot, ['show-ref', '--verify', '--quiet', branchRef]);
  if (branchExists.ok) {
    // The task branch may still be checked out after its directory was moved.
    // Reuse only a path whose basename is the full run id; a same-prefix UUID
    // collision must fail rather than point two tasks at one worktree.
    const byBranch = registered.find((item) => item.branch === branchRef);
    if (byBranch) {
      if (basename(byBranch.path) !== runId) {
        throw new Error(`task branch ${branch} is already checked out at ${byBranch.path}`);
      }
      return worktreeInfo(byBranch.path, branch, base);
    }
    const attach = await git(repoRoot, ['worktree', 'add', absolutePath, branch]);
    if (!attach.ok) {
      throw new Error(`git worktree reattach failed: ${attach.stderr.trim() || attach.stdout.trim()}`);
    }
    return worktreeInfo(absolutePath, branch, base);
  }

  const create = await git(repoRoot, ['worktree', 'add', '-b', branch, absolutePath, base]);
  if (!create.ok) {
    throw new Error(`git worktree add failed: ${create.stderr.trim() || create.stdout.trim()}`);
  }
  return worktreeInfo(absolutePath, branch, base);
}

/** Remove a task worktree and its branch. Best effort — never throws. */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  await git(repoRoot, ['worktree', 'prune']);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}

/**
 * Stage and commit everything in the worktree as a "cezar autosave" commit
 * (janitor pattern) — the agent's progress is always recoverable from the
 * `cez/<id8>` branch history. Quietly a no-op when nothing changed.
 */
export async function autosaveCommit(dir: string): Promise<boolean> {
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok || !status.stdout.trim()) return false;
  await git(dir, ['add', '-A']);
  // Commit as the CURRENT git user, so the branch's commits (and any PR opened from it) are
  // attributed to the real author and pass CLA / attribution checks. The old hardcoded
  // `cezar <cezar@local>` identity made every autosave look like a non-GitHub user. Fall back to
  // that identity ONLY when the machine has no git identity configured — otherwise `git commit`
  // would fail and the autosave (the run's recovery point) would be lost.
  const identityArgs = (await gitHasIdentity(dir))
    ? []
    : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
  const commit = await git(dir, [
    ...identityArgs,
    'commit',
    '--no-verify',
    '-m',
    'cezar autosave',
  ]);
  return commit.ok;
}

/** Does this repo/worktree resolve a git author identity (name + email)? Ambient config wins so
 *  autosave commits carry the user's own identity — see autosaveCommit. */
async function gitHasIdentity(dir: string): Promise<boolean> {
  const [name, email] = await Promise.all([
    git(dir, ['config', 'user.name']),
    git(dir, ['config', 'user.email']),
  ]);
  return name.ok && name.stdout.trim() !== '' && email.ok && email.stdout.trim() !== '';
}

/**
 * "What did this task change": diff of the worktree (committed + uncommitted
 * + untracked, via `add -N`) against the merge-base with its base branch —
 * so the diff stays *this task's* changes even after the base moves on.
 */
export async function worktreeDiff(
  worktreePath: string,
  baseBranch: string,
  cap = DIFF_CAP,
): Promise<string> {
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const mergeBase = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const res = await git(worktreePath, ['diff', base]);
  if (!res.ok) return `(diff failed: ${res.stderr.trim() || 'unknown git error'})`;
  if (res.stdout.length > cap) return `${res.stdout.slice(0, cap)}\n… (diff truncated)`;
  return res.stdout;
}

/**
 * `git diff --stat` version of `worktreeDiff` (spec 010 — the variant
 * comparison columns). Same merge-base anchoring; returns '' on any failure.
 */
export async function worktreeDiffStat(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const mergeBase = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const res = await git(worktreePath, ['diff', '--stat', base]);
  return res.ok ? res.stdout.trim() : '';
}

/** Aggregate diff numbers (#389) — the shape stored on `RunRecord.diffStat`. */
export interface DiffStat {
  adds: number;
  dels: number;
  files: number;
}

/**
 * Parse `git diff --shortstat` output — " 3 files changed, 10 insertions(+),
 * 2 deletions(-)". Every part is optional: insertions-only and deletions-only
 * diffs omit the other counter, and an empty diff prints nothing at all
 * (→ all zeros). The wording is stable porcelain English — git does not
 * localize `--shortstat` — so matching the words is safe.
 */
export function parseShortstat(s: string): DiffStat {
  const files = /(\d+) files? changed/.exec(s);
  const adds = /(\d+) insertions?\(\+\)/.exec(s);
  const dels = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    adds: adds ? Number(adds[1]) : 0,
    dels: dels ? Number(dels[1]) : 0,
  };
}

/**
 * `git diff --shortstat` of the worktree vs its base (#389) — same
 * merge-base anchoring and intent-to-add as `worktreeDiff`, parsed into
 * numbers. Null on git failure (the caller notes it, never fails the run);
 * an empty diff is a valid all-zero stat.
 */
export async function worktreeShortstat(
  worktreePath: string,
  baseBranch: string,
): Promise<DiffStat | null> {
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const mergeBase = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const res = await git(worktreePath, ['diff', '--shortstat', base]);
  return res.ok ? parseShortstat(res.stdout) : null;
}

/**
 * Startup reconcile: `git worktree prune` + remove every directory under
 * `.ai/cezar/worktrees/` whose run id is no longer in the store (and its
 * branch). Returns the removed run ids for the boot log. Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
): Promise<string[]> {
  await git(repoRoot, ['worktree', 'prune']);
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, WORKTREES_DIR), { withFileTypes: true });
  } catch {
    return []; // no worktrees dir yet
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || validIds.has(entry.name)) continue;
    await removeWorktree(repoRoot, worktreePathFor(repoRoot, entry.name), branchFor(entry.name));
    removed.push(entry.name);
  }
  return removed;
}
