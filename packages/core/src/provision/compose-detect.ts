import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The compose file names Cezar auto-detects, in precedence order. */
export const COMPOSE_FILENAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const;

/**
 * Returns the first compose file present at the repo root (relative path), or
 * `null` if none. Cheap, synchronous — used by `kind: 'auto'` resolution.
 */
export function detectComposeFile(repoRoot: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    if (existsSync(join(repoRoot, name))) return name;
  }
  return null;
}

/**
 * Best-effort: pull the first service name out of a compose file's top-level
 * `services:` block. Used when the workspace didn't name an app service.
 *
 * Deliberately a tiny line-scanner rather than a YAML dep — we only need the
 * first key under `services:`, and a malformed file should degrade to `null`
 * (the caller then errors with a clear "set compose.service" message) rather
 * than crash the run.
 */
export function firstComposeService(repoRoot: string, composeFile: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, composeFile), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  let inServices = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (!inServices) {
      if (/^services\s*:/.test(line)) inServices = true;
      continue;
    }
    // A new top-level key (no indentation) ends the services block.
    if (/^\S/.test(line)) break;
    // Service entries are indented exactly one level: `  name:`.
    const m = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:/);
    if (m) return m[1];
  }
  return null;
}
