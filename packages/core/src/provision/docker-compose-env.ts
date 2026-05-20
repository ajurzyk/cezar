import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEnvSpec, RunEnv, ShellResult } from './run-env.js';

/** How to invoke compose on this host: `docker compose …` (v2) or `docker-compose …` (v1). */
export interface ComposeCommand {
  bin: string;
  /** Leading sub-args, e.g. `['compose']` for the v2 plugin, `[]` for the v1 binary. */
  lead: string[];
}

export interface DockerComposeEnvOpts {
  worktreePath: string;
  /** Absolute path to the compose file. */
  composeFile: string;
  /** The app service install/build/test run inside. */
  service: string;
  /** Where the worktree is bind-mounted in the app service. */
  workdir: string;
  /** Unique per run — names the compose project so concurrent runs don't collide. */
  project: string;
  compose: ComposeCommand;
  spec: ProjectEnvSpec;
}

/**
 * Runs project commands inside a per-run `docker compose` project. The worktree
 * is bind-mounted into the app service (so the agent edits files on the host
 * and the container sees them, and deps written by `install` persist back into
 * the worktree across `run --rm` invocations). `depends_on` services (db,
 * redis, …) are started by `compose run` automatically.
 *
 * Isolation: every run gets a unique `-p <project>` so two concurrent runs on
 * the same repo get separate networks / volumes / containers. `dispose()` does
 * `down -v --remove-orphans` to clean them up.
 */
export class DockerComposeEnv implements RunEnv {
  readonly kind = 'compose' as const;
  private overrideDir: string | null = null;
  private overrideFile: string | null = null;
  private setupPromise: Promise<void> | null = null;

  constructor(private readonly opts: DockerComposeEnvOpts) {}

  install(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.opts.spec.install, onLine);
  }
  build(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.opts.spec.build, onLine);
  }
  test(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.opts.spec.test, onLine);
  }

  private maybeRun(command: string, onLine?: (line: string) => void): Promise<ShellResult | null> {
    const trimmed = command.trim();
    if (!trimmed) return Promise.resolve(null);
    return this.run(trimmed, onLine);
  }

  /** Lazily write the bind-mount override file (once). */
  private ensureOverride(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = (async () => {
        this.overrideDir = await mkdtemp(join(tmpdir(), 'cezar-compose-'));
        this.overrideFile = join(this.overrideDir, 'compose.cezar.override.yaml');
        const yaml = [
          'services:',
          `  ${this.opts.service}:`,
          '    volumes:',
          `      - ${this.opts.worktreePath}:${this.opts.workdir}`,
          '',
        ].join('\n');
        await writeFile(this.overrideFile, yaml, 'utf8');
      })();
    }
    return this.setupPromise;
  }

  private baseArgs(): string[] {
    const { compose, project, worktreePath, composeFile } = this.opts;
    return [
      ...compose.lead,
      '-p', project,
      '--project-directory', worktreePath,
      '-f', composeFile,
      '-f', this.overrideFile!,
    ];
  }

  async run(command: string, onLine?: (line: string) => void): Promise<ShellResult> {
    await this.ensureOverride();
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(this.opts.spec.envVars)) {
      envFlags.push('-e', `${k}=${v}`);
    }
    const args = [
      ...this.baseArgs(),
      'run', '--rm',
      '-w', this.opts.workdir,
      ...envFlags,
      this.opts.service,
      'sh', '-lc', command,
    ];
    return spawnCapture(this.opts.compose.bin, args, command, onLine);
  }

  async dispose(): Promise<void> {
    if (this.setupPromise) {
      try {
        await spawnCapture(this.opts.compose.bin, [...this.baseArgs(), 'down', '-v', '--remove-orphans'], 'compose down');
      } catch {
        // best-effort teardown
      }
    }
    if (this.overrideDir) {
      await rm(this.overrideDir, { recursive: true, force: true }).catch(() => {});
      this.overrideDir = null;
      this.overrideFile = null;
    }
  }
}

/** Spawn a process with array args (no shell), capture stdout/stderr, stream lines. */
export function spawnCapture(
  bin: string,
  args: string[],
  command: string,
  onLine?: (line: string) => void,
): Promise<ShellResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env });
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
