import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openInTerminal } from './open-in-terminal.js';

/**
 * "Open in…" session takeover (#open-in): detect the editors / file managers / terminals on THIS
 * machine, and open a run's worktree in the one the user picks — the desktop-app equivalent of
 * the "cd <path>" hint. Local-only; the server gates these behind `localHandoff` (CEZ_REMOTE).
 *
 * Detection is best-effort and cross-platform: an editor counts as present if its CLI is on PATH
 * or (macOS) its .app bundle is installed. Finder/file-manager and Terminal are always offered.
 */

export interface OpenTarget {
  id: string;
  label: string;
}

interface EditorDef {
  id: string;
  label: string;
  /** CLI launcher name on PATH, if any. */
  cli?: string;
  /** macOS .app bundle name (without `.app`), for `open -a` when no CLI is present. */
  mac?: string;
}

const EDITORS: EditorDef[] = [
  { id: 'vscode', label: 'VS Code', cli: 'code', mac: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor', cli: 'cursor', mac: 'Cursor' },
  { id: 'zed', label: 'Zed', cli: 'zed', mac: 'Zed' },
  { id: 'windsurf', label: 'Windsurf', cli: 'windsurf', mac: 'Windsurf' },
  { id: 'sublime', label: 'Sublime Text', cli: 'subl', mac: 'Sublime Text' },
  { id: 'webstorm', label: 'WebStorm', cli: 'webstorm', mac: 'WebStorm' },
  { id: 'idea', label: 'IntelliJ IDEA', cli: 'idea', mac: 'IntelliJ IDEA' },
  { id: 'xcode', label: 'Xcode', mac: 'Xcode' },
  { id: 'warp', label: 'Warp', mac: 'Warp' },
];

const FILE_MANAGER_LABEL =
  process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'Explorer' : 'Files';

/** Is `bin` an executable somewhere on PATH? Pure filesystem probe — no child process. */
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/** macOS: is `<name>.app` installed in a standard Applications dir? */
function macAppExists(name: string): boolean {
  if (process.platform !== 'darwin') return false;
  return [
    `/Applications/${name}.app`,
    join(homedir(), 'Applications', `${name}.app`),
    `/System/Applications/${name}.app`,
  ].some((p) => existsSync(p));
}

function editorAvailable(editor: EditorDef): boolean {
  if (editor.cli && onPath(editor.cli)) return true;
  if (editor.mac && macAppExists(editor.mac)) return true;
  return false;
}

/** Coding-agent CLIs a session can be handed off to (#cli-handoff). Selecting one opens a
 *  terminal that resumes THIS run's session when the runner matches, or launches a fresh CLI in
 *  the worktree otherwise. The actual command is built server-side (needs the run's session). */
const AGENT_CLIS: Array<{ runner: 'claude' | 'codex' | 'opencode'; label: string; bin: string; envBin?: string }> = [
  { runner: 'claude', label: 'Claude CLI', bin: 'claude', envBin: process.env.CEZ_CLAUDE_BIN },
  { runner: 'codex', label: 'Codex CLI', bin: 'codex', envBin: process.env.CEZ_CODEX_BIN },
  { runner: 'opencode', label: 'OpenCode', bin: 'opencode', envBin: process.env.CEZ_OPENCODE_BIN },
];

/** The runner behind a `cli:<runner>` open target, or null when the id isn't a CLI handoff. */
export function agentCliRunner(targetId: string): 'claude' | 'codex' | 'opencode' | null {
  const match = AGENT_CLIS.find((c) => `cli:${c.runner}` === targetId);
  return match ? match.runner : null;
}

/** The open targets available on this machine: the file manager, a terminal, every detected
 *  editor, and every installed coding-agent CLI. Order is stable so the menu never reshuffles. */
export function detectOpenTargets(): OpenTarget[] {
  const targets: OpenTarget[] = [
    { id: 'finder', label: FILE_MANAGER_LABEL },
    { id: 'terminal', label: 'Terminal' },
  ];
  for (const editor of EDITORS) {
    if (editorAvailable(editor)) targets.push({ id: editor.id, label: editor.label });
  }
  for (const cli of AGENT_CLIS) {
    if ((cli.envBin && existsSync(cli.envBin)) || onPath(cli.bin)) {
      targets.push({ id: `cli:${cli.runner}`, label: cli.label });
    }
  }
  return targets;
}

/** Open `dir` in the file manager, natively per platform. */
async function openFileManager(dir: string): Promise<boolean> {
  if (process.platform === 'darwin') return runDetached('open', [dir]);
  if (process.platform === 'win32') return runDetached('explorer', [dir]);
  return runDetached('xdg-open', [dir]);
}

/** Open `dir` in the given target. Unknown/unavailable target → false (the caller 409s). */
export async function openInApp(targetId: string, dir: string): Promise<boolean> {
  if (targetId === 'finder') return openFileManager(dir);
  // A bare interactive shell at the worktree — `:` is a no-op so no command actually runs.
  if (targetId === 'terminal') return openInTerminal(dir, ':');

  const editor = EDITORS.find((e) => e.id === targetId);
  if (!editor) return false;
  if (editor.cli && onPath(editor.cli)) return runDetached(editor.cli, [dir]);
  if (editor.mac && macAppExists(editor.mac)) return runDetached('open', ['-a', editor.mac, dir]);
  return false;
}

/** Spawn detached; success = no error within a short settle window (mirrors open-in-terminal). */
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
