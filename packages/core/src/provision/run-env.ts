import type { Config } from '../config/config.model.js';

/** The resolved `autofix.projectEnv` block (zod always supplies defaults). */
export type ProjectEnvSpec = NonNullable<Config['autofix']>['projectEnv'];

/** Outcome of running one command inside a `RunEnv`. */
export interface ShellResult {
  /** The command as Cezar invoked it (for the cockpit / comment). */
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * A runnable project environment bound to one worktree. Two implementations:
 *  - `NativeShellEnv` — runs commands directly on the host, in the worktree.
 *  - `DockerComposeEnv` — runs commands inside a per-run `docker compose`
 *    project, with the worktree bind-mounted into the app service.
 *
 * The autofix workflow's `shell-check` steps drive `install` / `build` /
 * `test`; a `null` return means the command was not configured (skip the step).
 * Lifecycle: `dispose()` is always called once, even on failure.
 */
export interface RunEnv {
  readonly kind: 'native' | 'compose';
  /** The configured install command, or `null` when unset. */
  install(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** The configured build command, or `null` when unset. */
  build(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** The configured test command, or `null` when unset. */
  test(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** Run an arbitrary command in the env. */
  run(command: string, onLine?: (line: string) => void): Promise<ShellResult>;
  /** Tear the env down (compose: `down -v`; native: no-op). Idempotent. */
  dispose(): Promise<void>;
}

/** Keep only the last `maxLines` lines of `text` — for failure tails in comments / prompts. */
export function tailLines(text: string, maxLines = 40): string {
  const lines = text.split('\n');
  return lines.slice(-maxLines).join('\n').trim();
}
