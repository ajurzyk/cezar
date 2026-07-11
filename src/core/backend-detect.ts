import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BackendCheck {
  name: 'claude' | 'gh' | 'git';
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probe the host for everything cez leans on: the `claude` CLI (the agent
 * backend), `gh` (GitHub auth for PR creation) and `git`. Nothing is required
 * except `claude` — the GUI degrades gracefully and shows the hints instead.
 */
export async function detectEnvironment(): Promise<BackendCheck[]> {
  return Promise.all([probeClaude(), probeGh(), probeGit()]);
}

async function probeClaude(): Promise<BackendCheck> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return { name: 'claude', available: true, version: 'mock (CEZ_DRY_RUN=1)' };
  }
  try {
    const { stdout } = await exec('claude', ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    // A generic `claude` binary (a shell wrapper, an unrelated tool) can shadow
    // the real CLI on $PATH — reject anything that doesn't match the banner.
    if (!/^\d+\.\d+|^claude(\s+code)?\s+version\s+\d+\.\d+/i.test(version)) {
      return {
        name: 'claude',
        available: false,
        hint: `\`claude\` is on PATH but doesn't look like Claude Code (got: ${version.slice(0, 80)})`,
      };
    }
    return {
      name: 'claude',
      available: true,
      version,
      hint: 'if not authenticated, run `claude` once and log in',
    };
  } catch {
    return {
      name: 'claude',
      available: false,
      hint: 'install Claude Code (npm i -g @anthropic-ai/claude-code) and log in',
    };
  }
}

async function probeGh(): Promise<BackendCheck> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    return { name: 'gh', available: stdout.trim().length > 0, version: 'authenticated' };
  } catch {
    return {
      name: 'gh',
      available: false,
      hint: 'install the GitHub CLI and run `gh auth login` (only needed for PR creation)',
    };
  }
}

async function probeGit(): Promise<BackendCheck> {
  try {
    const { stdout } = await exec('git', ['--version'], { timeout: 10_000 });
    return { name: 'git', available: true, version: stdout.trim() };
  } catch {
    return { name: 'git', available: false, hint: 'install git' };
  }
}

/** The host's GitHub token: logged-in `gh` first, `GITHUB_TOKEN` fallback. */
export async function readHostGithubToken(): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the env var
  }
  return process.env.GITHUB_TOKEN?.trim() || null;
}
