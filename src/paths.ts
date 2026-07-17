import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentHomePaths } from './agent-config/catalog.js';

/**
 * Per-user cezar home. Literal `~/.cezar` on every platform (no XDG, no
 * `%LOCALAPPDATA%` branch) — one rule, and it matches how the existing cache
 * path already behaves (`skills-remote.ts` hardcodes `~/.cache/cez`).
 *
 * `CEZ_HOME` overrides the base so tests (and containers) never touch a real
 * home dir. This is the first shared home-path helper in the repo; two other
 * 2026-07-16 specs (multi-project-switcher, agent-config-files) extend it —
 * first writer owns the file, later specs import it. Do not duplicate this
 * homedir logic elsewhere.
 */
export function cezarHomeDir(): string {
  // `|| undefined` so an EMPTY CEZ_HOME (e.g. `CEZ_HOME= cezar …`) falls back
  // to the default instead of yielding relative paths in the cwd.
  return (process.env.CEZ_HOME || undefined) ?? join(homedir(), '.cezar');
}

/**
 * Host-level, install-once record written by `server-install` (spec
 * 2026-07-16-server-installer). Distinct from the per-instance registry the
 * multi-project switcher keeps under `~/.cezar/instances/` — they coexist.
 */
export function serverStatePath(): string {
  return join(cezarHomeDir(), 'server.json');
}

/**
 * Single-writer lock the installer/uninstaller hold for a whole run. The
 * host-level installer is not concurrency-safe with itself.
 */
export function serverLockPath(): string {
  return join(cezarHomeDir(), 'server.install.lock');
}

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
