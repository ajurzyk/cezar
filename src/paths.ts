import { homedir } from 'node:os';
import { join } from 'node:path';

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
