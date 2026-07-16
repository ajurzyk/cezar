import { execFile, spawn } from 'node:child_process';
import { detectEnvironment, type BackendCheck } from '../core/backend-detect.js';
import {
  CANCEL,
  type InstallContext,
  type InstallStep,
  type Runner,
  type StepArtifact,
} from './types.js';

/**
 * Platform-agnostic step helpers. The star is `sudoStep`: the wizard runs as a
 * normal account and never escalates silently. It prints the exact command,
 * lets the operator run it via `sudo` or run it themselves, then proves the box
 * is actually in the expected state with `verify()` before advancing — and
 * offers a redo when verification fails.
 */

/** Real command runner (Node child_process). */
export const defaultRunner: Runner = {
  capture(program, args) {
    return new Promise((resolve) => {
      execFile(program, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  },
  interactive(program, args) {
    return new Promise((resolve) => {
      const child = spawn(program, args, { stdio: 'inherit' });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 0));
    });
  },
};

/** Run a probe and assert its result. Returns false in dry-run (nothing is verifiably present). */
export async function verifyCommand(
  ctx: InstallContext,
  program: string,
  args: string[],
  matcher: (r: { code: number; stdout: string; stderr: string }) => boolean = (r) => r.code === 0,
): Promise<boolean> {
  if (ctx.dryRun) return false;
  return matcher(await ctx.runner.capture(program, args));
}

/** True when `sudo -n true` succeeds — the box grants passwordless sudo. */
export async function hasPasswordlessSudo(ctx: InstallContext): Promise<boolean> {
  if (ctx.dryRun) return false;
  return (await ctx.runner.capture('sudo', ['-n', 'true'])).code === 0;
}

export class StepCancelled extends Error {}
export class StepAborted extends Error {}
/** Thrown from an optional step's `run()` to record it as `skipped` (e.g. certbot DNS not ready). */
export class StepSkipped extends Error {}

export interface SudoStepOpts {
  /** One-line description of what/why (shown above the command). */
  description: string;
  /** The privileged shell command (without a leading `sudo`). May use pipes/redirects. */
  command: string;
  /** Prove the command actually took effect. Runs after every attempt. */
  verify: (ctx: InstallContext) => Promise<boolean>;
}

/**
 * Execute one privileged command with the operator in the loop:
 * print → run-via-sudo OR delegate → verify → redo-on-mismatch.
 *
 * - Dry-run: prints the intended command and returns (no exec, no verify).
 * - `--yes` with passwordless sudo: runs non-interactively.
 * - `--yes` without passwordless sudo: falls back to delegate (never blocks on a hidden prompt).
 *
 * Throws `StepCancelled` if the user cancels, `StepAborted` if they give up after a failed verify.
 */
/** Single-quote a shell string so a copy-paste of `display` runs exactly what we run. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function sudoStep(ctx: InstallContext, opts: SudoStepOpts): Promise<void> {
  const { ui } = ctx;
  // What we actually run — and what the operator copy-pastes in the delegate path.
  const display = `sudo bash -lc ${shquote(opts.command)}`;

  if (ctx.dryRun) {
    ui.info(`DRY RUN — would run: ${display}`);
    return;
  }

  const passwordless = await hasPasswordlessSudo(ctx);

  for (;;) {
    ui.note(display, opts.description);

    let mode: 'sudo' | 'delegate';
    if (ctx.assumeYes) {
      mode = passwordless ? 'sudo' : 'delegate';
    } else {
      const choice = await ui.select<'sudo' | 'delegate'>({
        message: 'How should this privileged command run?',
        options: [
          { value: 'sudo', label: 'Run it now via sudo', hint: 'streams output here' },
          { value: 'delegate', label: "I'll run it myself as root", hint: 'paste & run, then confirm' },
        ],
        initialValue: 'sudo',
      });
      if (choice === CANCEL) throw new StepCancelled();
      mode = choice;
    }

    if (mode === 'sudo') {
      const code = await ctx.runner.interactive('sudo', ['bash', '-lc', opts.command]);
      if (code !== 0) ui.warn(`command exited with code ${code}`);
    } else {
      ui.note(display, 'Run this as root on the server, then confirm below');
      if (!ctx.assumeYes) {
        const done = await ui.confirm({ message: 'Have you run it?', initialValue: true });
        if (done === CANCEL) throw new StepCancelled();
      }
    }

    if (await opts.verify(ctx)) {
      ui.success('Verified.');
      return;
    }

    ui.error('That did not take effect — the verification check still fails.');
    if (ctx.assumeYes) throw new StepAborted(`verification failed for: ${opts.command}`);
    const redo = await ui.confirm({ message: 'Try again?', initialValue: true });
    if (redo === CANCEL || redo === false) throw new StepAborted(`gave up on: ${opts.command}`);
  }
}

/** Convenience: an `owned` file/service/etc. artifact. */
export function owned(type: string, fields: Omit<StepArtifact, 'kind' | 'type'>): StepArtifact {
  return { kind: 'owned', type, ...fields };
}
/** Convenience: a `shared` artifact (listed, not removed, on uninstall). */
export function shared(type: string, fields: Omit<StepArtifact, 'kind' | 'type'>): StepArtifact {
  return { kind: 'shared', type, ...fields };
}

/**
 * The dependency step, built from `detectEnvironment()` (reused verbatim). It
 * shows the missing tools as a checkbox, installs the selected ones, and prints
 * the per-tool authorization instruction (agent CLIs need an interactive login
 * a wizard cannot fully automate). `detect` is injectable for tests.
 */
/** How a given platform installs one missing tool. Platform-agnostic seam. */
export type ToolInstaller = (ctx: InstallContext, name: string) => Promise<void>;

export interface DepStepOpts {
  detect?: () => Promise<BackendCheck[]>;
  /** Per-platform installer; defaults to the apt/npm (Ubuntu) one. */
  installTool?: ToolInstaller;
  /** Per-tool manual-removal hint shown by uninstall. */
  removeHint?: (name: string) => string;
}

export function depCheckStep(opts: DepStepOpts = {}): InstallStep {
  const detect = opts.detect ?? detectEnvironment;
  const install = opts.installTool ?? aptInstallTool;
  const hintFor = opts.removeHint ?? removeHintFor;
  return {
    id: 'deps',
    title: 'Dependencies (agent CLIs + gh)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const checks = await detect();
      // Satisfied when at least one agent CLI is present and authed.
      return checks.some((c) => ['claude', 'codex', 'opencode'].includes(c.name) && c.available);
    },
    async run(ctx) {
      const checks = await detect();
      const missing = checks.filter((c) => !c.available && c.name !== 'git');
      if (missing.length === 0) {
        ctx.ui.success('All dependencies present.');
        return { artifacts: [] };
      }
      const pick = await ctx.ui.multiselect<string>({
        message: 'Missing tools — select the ones to install',
        options: missing.map((c) => ({ value: c.name, label: c.name, hint: c.hint })),
        required: false,
      });
      if (pick === CANCEL) throw new StepCancelled();

      const installed: StepArtifact[] = [];
      for (const name of pick) {
        const check = missing.find((c) => c.name === name);
        await install(ctx, name);
        installed.push(shared('package', { name, removeHint: hintFor(name) }));
        if (check?.hint) ctx.ui.note(check.hint, `Authorize ${name}`);
      }
      return { artifacts: installed };
    },
    async undo(ctx, created) {
      // Dependencies are `shared` — never auto-removed. List them for the operator.
      const pkgs = created?.artifacts ?? [];
      if (pkgs.length === 0) return;
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'These tools were installed for cezar but may be used elsewhere — remove manually if you want them gone',
      );
    },
  };
}

const NPM_GLOBAL: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/** Ubuntu/Debian installer: apt for gh, sudo npm -g for the agent CLIs (system node). */
export const aptInstallTool: ToolInstaller = async (ctx, name) => {
  if (name === 'gh') {
    await sudoStep(ctx, {
      description: 'Install the GitHub CLI (only needed for PR creation).',
      command: 'apt-get update && apt-get install -y gh',
      verify: (c) => verifyCommand(c, 'gh', ['--version']),
    });
    return;
  }
  await installViaNpmOrNote(ctx, name, true);
};

/** macOS installer: brew (no sudo) for gh, npm -g for the agent CLIs. */
export const brewInstallTool: ToolInstaller = async (ctx, name) => {
  if (name === 'gh') {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would run: brew install gh');
      return;
    }
    await ctx.runner.interactive('brew', ['install', 'gh']);
    return;
  }
  await installViaNpmOrNote(ctx, name, false);
};

async function installViaNpmOrNote(ctx: InstallContext, name: string, sudo: boolean): Promise<void> {
  if (name === 'opencode') {
    ctx.ui.note('Install OpenCode from https://opencode.ai, then re-run.', 'opencode');
    return;
  }
  const pkg = NPM_GLOBAL[name];
  if (!pkg) {
    ctx.ui.warn(`no known installer for ${name} — install it manually`);
    return;
  }
  if (sudo) {
    await sudoStep(ctx, {
      description: `Install ${name} globally via npm.`,
      command: `npm install -g ${pkg}`,
      verify: (c) => verifyCommand(c, name, ['--version']),
    });
    return;
  }
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would run: npm install -g ${pkg}`);
    return;
  }
  await ctx.runner.interactive('npm', ['install', '-g', pkg]);
}

function removeHintFor(name: string): string {
  const npm: Record<string, string> = {
    claude: 'npm rm -g @anthropic-ai/claude-code',
    codex: 'npm rm -g @openai/codex',
  };
  if (name === 'gh') return 'sudo apt-get remove -y gh';
  return npm[name] ?? `# remove ${name} manually`;
}

/** macOS-flavored removal hints (brew instead of apt). */
export function brewRemoveHint(name: string): string {
  const npm: Record<string, string> = {
    claude: 'npm rm -g @anthropic-ai/claude-code',
    codex: 'npm rm -g @openai/codex',
  };
  if (name === 'gh') return 'brew uninstall gh';
  return npm[name] ?? `# remove ${name} manually`;
}
