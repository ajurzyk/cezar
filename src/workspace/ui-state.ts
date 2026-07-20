import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workspaceUiStatePath } from '../paths.js';

/**
 * `~/.cezar/ui-state.json` — global GUI state, the workspace twin of the
 * per-repo `.ai/cezar/ui-state.json` (spec 2026-07-20-multi-project-workspace,
 * Data Model). Same split as `src/ui-state.ts`: this module owns the tolerant
 * read and the atomic write; the schema and key cap live at the route boundary
 * (`GET/PUT /api/workspace/ui-state`, step 2.7). The state is an opaque
 * `.passthrough()`-style bag — cross-project prefs (appearance, notifications,
 * per-project sidebar collapse) live here; project-scoped prefs stay in each
 * repo's own file.
 */

/** Read `~/.cezar/ui-state.json` on demand — never cached, never throws.
 *  Missing, unreadable, malformed, or non-object all degrade to `{}`. */
export async function readWorkspaceUiState(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workspaceUiStatePath(), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read-modify-write for `~/.cezar/ui-state.json`, written with the same atomic
 * tmp+rename `0600` pattern (dir `0700`) as `mergeWriteWorkspaceConfig`. A
 * missing or corrupt file merges from `{}`. The mutator may mutate its
 * argument in place or return a replacement. Throws on write failure (e.g. a
 * read-only home) — degrading is the caller's policy, per house rules.
 */
export async function mergeWriteWorkspaceUiState(
  mutator: (state: Record<string, unknown>) => Record<string, unknown> | void,
): Promise<Record<string, unknown>> {
  const path = workspaceUiStatePath();
  const current = await readWorkspaceUiState();
  const next = mutator(current) ?? current;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600); // best-effort — ignored on some filesystems
  } catch {
    // non-fatal
  }
  return next;
}
