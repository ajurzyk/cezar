import { execFile } from 'node:child_process';
import { autosaveCommit } from '../git-worktree.js';
import type { RunRecord } from '../runs/store.js';

/**
 * Draft-PR creation for the review gate (spec 009): final autosave-commit →
 * `git push -u origin cez/<id8>` → `gh pr create --draft`, all executed in
 * the task worktree (gh picks the repo up from the worktree's remote).
 * Every failure maps to a one-line human error — the GUI shows it as a toast
 * plus the manual `git merge <branch>` fallback. Never throws.
 */

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const PUSH_TIMEOUT_MS = 60_000;
const PROGRESS_LINES_MAX = 10;

export type DraftPrOutcome =
  | { ok: true; url: string; dryRun: boolean }
  | { ok: false; error: string };

export interface DraftPrInput {
  repoRoot: string;
  run: RunRecord;
  /** The task's handoff.md — becomes the PR body (goal + progress skim). */
  handoffText: string;
}

export async function createDraftPr(input: DraftPrInput): Promise<DraftPrOutcome> {
  const { run } = input;
  const worktree = run.worktreePath;
  const branch = run.branch;
  if (!worktree || !branch) {
    return { ok: false, error: 'this task has no worktree/branch to publish' };
  }

  // Final autosave: the branch must hold everything before it leaves the box.
  await autosaveCommit(worktree);

  // DRY-RUN (CEZ_DRY_RUN=1): no push, no gh — simulate success with a fake PR
  // URL so the whole review → PR flow is testable without GitHub.
  if (process.env.CEZ_DRY_RUN === '1') {
    return { ok: true, url: 'https://github.com/open-mercato/demo/pull/777', dryRun: true };
  }

  const remote = await exec('git', ['remote', 'get-url', 'origin'], worktree);
  if (!remote.ok || !remote.stdout.trim()) {
    return { ok: false, error: 'no git remote — add one (git remote add origin <url>) or merge the branch locally' };
  }

  const push = await exec('git', ['push', '-u', 'origin', branch], worktree, PUSH_TIMEOUT_MS);
  if (!push.ok) {
    return { ok: false, error: `git push failed — ${tail(push.stderr) || 'unknown error'}` };
  }

  const body = buildPrBody(input.handoffText, run.task);
  // Target the branch the worktree forked from (config `baseBranch`) — without
  // --base, gh aims at the repo default (main) even when work started on
  // develop. `origin/x` normalizes to `x`; a raw sha (detached-HEAD fork
  // point) can't be a PR base, so gh falls back to the default branch.
  const prBase = run.baseBranch?.replace(/^origin\//, '');
  const baseArgs = prBase && !/^[0-9a-f]{7,40}$/i.test(prBase) ? ['--base', prBase] : [];
  const pr = await exec(
    'gh',
    ['pr', 'create', '--draft', '--head', branch, ...baseArgs, '--title', run.title, '--body', body],
    worktree,
    PUSH_TIMEOUT_MS,
  );
  if (!pr.ok) {
    if (pr.notFound) {
      return { ok: false, error: 'gh not found — install the GitHub CLI and run `gh auth login`, or merge the branch locally' };
    }
    const hint = /auth|log ?in|credential/i.test(pr.stderr) ? ' (try `gh auth login`)' : '';
    return { ok: false, error: `gh pr create failed — ${tail(pr.stderr) || 'unknown error'}${hint}` };
  }

  // gh prints the PR URL on stdout; some versions echo it to stderr instead.
  const match = PR_URL_RE.exec(`${pr.stdout}\n${pr.stderr}`);
  if (!match) {
    return { ok: false, error: 'gh pr create returned no PR URL — check `gh pr list` manually' };
  }
  return { ok: true, url: match[0], dryRun: false };
}

/**
 * PR body from the handoff journal: the "## Goal" section (task text as
 * fallback) + the first ~10 lines of "## Progress log" (newest first) +
 * the cezar footer.
 */
export function buildPrBody(handoffText: string, task: string): string {
  const goal = section(handoffText, '## Goal') || task.trim();
  const progress = section(handoffText, '## Progress log')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, PROGRESS_LINES_MAX)
    .join('\n');
  const parts = ['## Goal', '', goal];
  if (progress) parts.push('', '## Progress log', '', progress);
  parts.push('', '---', '', '🤖 made with cezar');
  return parts.join('\n');
}

/** Text of one `## Header` section, up to the next `## ` header. */
function section(text: string, header: string): string {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + header.length + 1);
  const next = rest.indexOf('\n## ');
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** Last 3 stderr lines, pipe-joined — enough context, toast-sized. */
function tail(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT). */
  notFound: boolean;
}

function exec(bin: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          notFound: err?.code === 'ENOENT',
        }),
    );
  });
}
