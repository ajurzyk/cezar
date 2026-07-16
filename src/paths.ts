import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentHomePaths } from './agent-config/catalog.js';

/**
 * The repo's first shared home-path helper. Until now every `~`-relative path
 * was hardcoded inline (e.g. `skills-remote.ts`'s `~/.cache/cez`). Kept small
 * and env-injectable so it is testable and so a sibling feature (the
 * multi-project instance registry under `~/.cezar`) can extend it rather than
 * duplicate the homedir logic.
 */

/** The user's home directory. A thin wrapper so callers depend on this module, not `node:os`. */
export function homeDir(): string {
  return homedir();
}

/**
 * Where each coding agent keeps its per-user config, honouring the env vars the
 * vendors document: `$CODEX_HOME` relocates Codex's home; `$XDG_CONFIG_HOME`
 * relocates OpenCode's config dir (falling back to `~/.config`). Claude's `~/.claude`
 * has no documented override. Read per call so tests and ops can set env live.
 */
export function agentHomePaths(env: NodeJS.ProcessEnv = process.env): AgentHomePaths {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return {
    claude: join(home, '.claude'),
    codex: env.CODEX_HOME?.trim() || join(home, '.codex'),
    opencodeConfig: join(xdgConfig, 'opencode'),
  };
}
