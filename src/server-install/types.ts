import { z } from 'zod';

/**
 * Contracts for the server installer (spec 2026-07-16-server-installer).
 * The engine closes over `InstallStep` / `PlatformStrategy` and never learns
 * what a step *does* — only `check` / `run` / `undo`. That seam is what makes
 * "use ubuntu as a selector and run it that way" a registry lookup, and what
 * makes the interactive helpers reusable across every future platform.
 */

/** The platforms the registry knows. Extend here + add a strategy file. */
export const PLATFORM_IDS = ['ubuntu-vps', 'macosx-ngrok'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/** Per-step lifecycle. `failed` resumes identically to `pending`. */
export const STEP_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * One thing a step created, tagged by who owns its removal:
 *  - `owned`  — cezar authored it and nothing else uses it → uninstall removes it.
 *  - `shared` — a system tool the operator may now depend on (gh, agent CLIs,
 *    certbot + its renewal timer, the cert itself) → uninstall lists it with a
 *    manual removal hint instead of yanking it.
 */
export const stepArtifactSchema = z.object({
  kind: z.enum(['owned', 'shared']),
  /** file | package | service | cert | htpasswd | config | note */
  type: z.string().min(1),
  /** Filesystem path for `owned` files (vhost, unit, htpasswd). */
  path: z.string().optional(),
  /** Human name: package id, unit name, cert domain, auth user. */
  name: z.string().optional(),
  /** `system` | `user` for services. */
  scope: z.string().optional(),
  /** For `shared` artifacts: the exact command the operator can run to remove it. */
  removeHint: z.string().optional(),
});
export type StepArtifact = z.infer<typeof stepArtifactSchema>;

/** What a step returns from `run()`; `undo()` receives it back verbatim. */
export const stepCreatedSchema = z
  .object({ artifacts: z.array(stepArtifactSchema).default([]) })
  .nullable();
export type StepCreated = z.infer<typeof stepCreatedSchema>;

/** Persisted per-step outcome — the `steps` map in `server.json`. */
export const stepOutcomeSchema = z.object({
  status: z.enum(STEP_STATUSES),
  created: stepCreatedSchema.optional().catch(null),
});
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

/**
 * `~/.cezar/server.json` — host-level, install-once. Additive-safe: every new
 * field is optional / defaulted so an older cezar still parses a newer file
 * (BACKWARD_COMPATIBILITY cross-version-state rule). No secrets live here.
 */
export const serverStateSchema = z.object({
  schema: z.literal(1).catch(1),
  platform: z.enum(PLATFORM_IDS).optional(),
  /** Flips true only when every required step is `done`. */
  installed: z.boolean().default(false),
  /** ISO stamp set by the caller (Date.now is unavailable in some contexts). */
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  primaryPort: z.number().int().positive().default(4321),
  /** Public URL / identity user surfaced at the end — display only. */
  publicUrl: z.string().optional(),
  /** macOS+ngrok free tier: the tunnel URL changes across restarts. */
  ephemeral: z.boolean().optional(),
  steps: z.record(z.string(), stepOutcomeSchema).default({}),
});
export type ServerState = z.infer<typeof serverStateSchema>;

/** Freshly-initialized state (no install yet). */
export function freshServerState(): ServerState {
  return serverStateSchema.parse({});
}

/**
 * The interactive surface a step talks to. Implemented by `ui.ts` over
 * `@clack/prompts`; declared here as a pure interface so `types.ts` (and the
 * engine) never import the TUI library. Prompt methods resolve to the
 * `CANCEL` sentinel instead of throwing when the user aborts.
 */
export const CANCEL = Symbol('cezar.ui.cancel');
export type Cancellable<T> = T | typeof CANCEL;

export interface SpinnerHandle {
  start(message?: string): void;
  stop(message?: string): void;
  message(message: string): void;
}

export interface Ui {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  select<T>(opts: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<Cancellable<T>>;
  multiselect<T>(opts: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    required?: boolean;
  }): Promise<Cancellable<T[]>>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<Cancellable<boolean>>;
  text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (v: string) => string | undefined;
  }): Promise<Cancellable<string>>;
  password(opts: {
    message: string;
    validate?: (v: string) => string | undefined;
  }): Promise<Cancellable<string>>;
  spinner(): SpinnerHandle;
}

/** Result of running a command with captured output. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Command execution seam. The engine supplies a real implementation; tests
 * inject a fake so `sudoStep` / `verifyCommand` are exercised without touching
 * the host. In `CEZ_DRY_RUN`, side-effecting runs are short-circuited by the
 * step helpers, not the runner.
 */
export interface Runner {
  /**
   * Capture stdout/stderr; never throws on non-zero exit (returns the code).
   * `opts.input` is written to the child's stdin — use it to pass secrets
   * (passwords, tokens) so they never appear in the process's argv.
   */
  capture(program: string, args: string[], opts?: { input?: string }): Promise<CommandResult>;
  /** Inherit stdio (streams live output). Resolves with the exit code. */
  interactive(program: string, args: string[]): Promise<number>;
}

/** Live install/uninstall context, threaded through every step. */
export interface InstallContext {
  state: ServerState;
  ui: Ui;
  runner: Runner;
  /** Atomically persist `state` to `~/.cezar/server.json`. */
  save(): Promise<void>;
  /** CEZ_DRY_RUN — no real sudo, package installs, or network. */
  dryRun: boolean;
  /** `--yes`: auto-accept safe defaults; never invents a sudo password. */
  assumeYes: boolean;
  /** Step ids the user asked to force-rerun via `--reconfigure`. */
  reconfigure: ReadonlySet<string>;
  /** Repo root the autostart service should run `cezar serve` in. */
  repoRoot: string;
  /** ISO timestamp for this run (passed in — Date.now guard). */
  now: string;
  /**
   * Choices remembered for the rest of the run so the wizard stops re-asking.
   * `sudoMode` is set the first time the operator answers the sudo-vs-delegate
   * prompt — once they pick "I'll run it myself as root", every later privileged
   * command reuses that choice instead of prompting again.
   */
  prefs: { sudoMode?: 'sudo' | 'delegate' };
}

export interface InstallStep {
  /** Stable — the key in `server.json`. Never rename once it has landed. */
  id: string;
  title: string;
  /** Optional steps (SSL, autostart) can be skipped without failing install. */
  optional?: boolean;
  /** True ⇒ already satisfied, engine skips (unless `--reconfigure` names it). */
  check(ctx: InstallContext): Promise<boolean>;
  /** Do it, interactively. Return what was created (or null). */
  run(ctx: InstallContext): Promise<StepCreated>;
  /** Reverse it, given back the recorded `created`. */
  undo(ctx: InstallContext, created: StepCreated): Promise<void>;
}

export interface PlatformStrategy {
  id: PlatformId;
  label: string;
  /** OS / arch / privilege sanity. Throw `PreflightError` to refuse politely. */
  preflight(ctx: InstallContext): Promise<void>;
  /** Ordered steps for this platform. */
  steps(ctx: InstallContext): InstallStep[];
}

/** Thrown by `preflight` to stop with a clean, user-facing reason (no stack). */
export class PreflightError extends Error {}
