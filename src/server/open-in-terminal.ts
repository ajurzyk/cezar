import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Open a real terminal window at `cwd` running `command` — the "take over the
 * agent session locally" handoff. Cross-platform strategy ported from
 * github-janitor's `openInTerminal.ts`: macOS via osascript, Windows via
 * cmd/start, Linux by probing common emulators with a temp launch script
 * (which sidesteps per-emulator quoting rules).
 *
 * Returns true when a launcher was started without an immediate error; the
 * caller shows a copy-the-command fallback otherwise.
 */
export async function openInTerminal(cwd: string, command: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    const script = `cd ${shellQuote(cwd)} && ${command}`;
    return runDetached('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${appleScriptQuote(script)}`,
    ]);
  }

  if (process.platform === 'win32') {
    const inner = `cd /d "${cwd}" && ${command}`;
    // Windows Terminal first, classic cmd window as fallback.
    if (await runDetached('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/K', command])) {
      return true;
    }
    return runDetached('cmd', ['/c', 'start', '', 'cmd', '/K', inner]);
  }

  // Linux/other: a temp script avoids each emulator's own quoting rules.
  const dir = mkdtempSync(join(tmpdir(), 'cez-term-'));
  const scriptPath = join(dir, 'launch.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\ncd ${shellQuote(cwd)}\n${command}\nexec bash\n`, 'utf8');
  chmodSync(scriptPath, 0o755);

  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', scriptPath]],
    ['gnome-terminal', ['--', scriptPath]],
    ['konsole', ['-e', scriptPath]],
    ['wezterm', ['start', '--', scriptPath]],
    ['kitty', [scriptPath]],
    ['alacritty', ['-e', scriptPath]],
    ['xterm', ['-e', scriptPath]],
  ];
  for (const [bin, args] of candidates) {
    if (await runDetached(bin, args)) return true;
  }
  return false;
}

/** Spawn detached; success = no error within a short settle window. */
function runDetached(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once('error', () => settle(false));
    setTimeout(() => {
      child.unref();
      settle(true);
    }, 250);
  });
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
