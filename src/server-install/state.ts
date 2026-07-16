import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { cezarHomeDir, serverLockPath, serverStatePath } from '../paths.js';
import { freshServerState, serverStateSchema, type ServerState, type StepOutcome } from './types.js';

/**
 * `~/.cezar/server.json` I/O and the single-writer lock. Reads degrade to a
 * fresh record on any corruption (house pattern — never crash the wizard);
 * writes are atomic (tmp + rename) and `0600`, since the file is the input to
 * uninstall's "reverse exactly what was created" logic.
 */

/** Load the host-level state, degrading to a fresh record on any error. */
export function loadServerState(): ServerState {
  const path = serverStatePath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return freshServerState();
  }
  try {
    const parsed = serverStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to fresh
  }
  return freshServerState();
}

/** Atomically persist state as `0600`, creating `~/.cezar` (`0700`) if needed. */
export function saveServerState(state: ServerState): void {
  const path = serverStatePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600); // best-effort — ignored on some filesystems
  } catch {
    // non-fatal
  }
}

/** A step is resolved (needs no run on resume) when it is done or skipped. */
export function isResolved(outcome: StepOutcome | undefined): boolean {
  return outcome?.status === 'done' || outcome?.status === 'skipped';
}

/**
 * First step id in `orderedIds` that is not yet resolved — the resume point.
 * `undefined` means every step is resolved (install complete).
 */
export function firstIncompleteStep(orderedIds: readonly string[], state: ServerState): string | undefined {
  return orderedIds.find((id) => !isResolved(state.steps[id]));
}

export class LockHeldError extends Error {}

/**
 * Acquire the exclusive install lock. Throws `LockHeldError` if a *live*
 * process already holds it; a stale lock (dead pid) is reclaimed. Returns a
 * release function.
 */
export function acquireLock(): () => void {
  const path = serverLockPath();
  mkdirSync(cezarHomeDir(), { recursive: true, mode: 0o700 });

  if (existsSync(path)) {
    const holder = readLockPid(path);
    if (holder !== null && holder !== process.pid && isProcessAlive(holder)) {
      throw new LockHeldError(
        `another server-install/uninstall is already running (pid ${holder}). ` +
          `If that is wrong, remove ${path} and retry.`,
      );
    }
    // stale (dead pid, unreadable, or our own) — reclaim
    try {
      rmSync(path);
    } catch {
      // fall through; write below will overwrite
    }
  }

  writeFileSync(path, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(path) && readLockPid(path) === process.pid) rmSync(path);
    } catch {
      // non-fatal
    }
  };
}

function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive)
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
