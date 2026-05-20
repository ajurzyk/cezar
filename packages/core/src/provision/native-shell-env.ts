import { spawn } from 'node:child_process';
import type { ProjectEnvSpec, RunEnv, ShellResult } from './run-env.js';

/**
 * Runs project commands directly on the host, inside the worktree. The trust
 * boundary is the same as a CI script — the worktree is a clone of the user's
 * own repo and the command list is configured by the workspace admin.
 */
export class NativeShellEnv implements RunEnv {
  readonly kind = 'native' as const;

  constructor(
    private readonly worktreePath: string,
    private readonly spec: ProjectEnvSpec,
  ) {}

  install(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.install, onLine);
  }
  build(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.build, onLine);
  }
  test(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.test, onLine);
  }

  private maybeRun(command: string, onLine?: (line: string) => void): Promise<ShellResult | null> {
    const trimmed = command.trim();
    if (!trimmed) return Promise.resolve(null);
    return this.run(trimmed, onLine);
  }

  run(command: string, onLine?: (line: string) => void): Promise<ShellResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.worktreePath,
        shell: true,
        env: { ...process.env, ...this.spec.envVars },
      });
      let stdout = '';
      let stderr = '';
      const onChunk = (kind: 'out' | 'err') => (chunk: Buffer): void => {
        const text = chunk.toString();
        if (kind === 'out') stdout += text;
        else stderr += text;
        if (onLine) {
          for (const line of text.split('\n')) {
            const trimmed = line.trimEnd();
            if (trimmed) onLine(trimmed);
          }
        }
      };
      child.stdout?.on('data', onChunk('out'));
      child.stderr?.on('data', onChunk('err'));
      child.on('error', (err) => {
        resolve({ command, ok: false, exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, durationMs: Date.now() - started });
      });
      child.on('close', (code) => {
        resolve({ command, ok: code === 0, exitCode: code, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
