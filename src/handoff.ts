import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-task handoff journal (spec 007): `.ai/cezar/runs/<runId>.handoff.md`,
 * next to the run's NDJSON events and outside the task worktree — it survives
 * worktree removal. Cez seeds the skeleton and appends heartbeats; the agent
 * (told via CEZ_HANDOFF_FILE + the system-prompt fragment below) keeps the
 * "Progress log" and "Resume notes" sections up to date. Everything here is
 * best-effort: the handoff is a journal, never a reason to fail a run.
 */

export function handoffPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.handoff.md`);
}

export interface HandoffSeed {
  id: string;
  title: string;
  workflow: string;
  task: string;
  branch?: string;
  worktreePath?: string;
}

/** Create the handoff skeleton. Idempotent — an existing file (resume,
 *  continuation) is never overwritten. Returns the file path. */
export function seedHandoffFile(dataDir: string, run: HandoffSeed): string {
  const file = handoffPath(dataDir, run.id);
  if (existsSync(file)) return file;
  const header =
    `# Handoff — ${run.title}\n\n` +
    `**Task id:** ${run.id}\n` +
    `**Workflow:** ${run.workflow}\n` +
    (run.branch ? `**Branch:** ${run.branch}\n` : '') +
    (run.worktreePath ? `**Worktree:** ${run.worktreePath}\n` : '') +
    `\n## Goal\n\n${run.task.trim()}\n\n` +
    `## Progress log\n\n` +
    `## Resume notes\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header, 'utf8');
  } catch {
    // best effort — a read-only data dir must not break the run
  }
  return file;
}

/**
 * Cez's own heartbeat (the janitor pattern): insert `- <ISO ts> — <note>`
 * right under the `## Progress log` header (newest at the top), so the file
 * stays current even when the agent forgets to write. Missing header →
 * append at the end of the file; missing file → no-op.
 */
export function appendHandoffHeartbeat(dataDir: string, runId: string, note: string): void {
  const file = handoffPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // not seeded — nothing to heartbeat
  }
  const line = `- ${new Date().toISOString()} — ${note}\n`;
  const marker = '## Progress log\n';
  const idx = text.indexOf(marker);
  const next =
    idx >= 0
      ? `${text.slice(0, idx + marker.length)}\n${line}${text.slice(idx + marker.length).replace(/^\n+/, '')}`
      : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${line}`;
  try {
    writeFileSync(file, next, 'utf8');
  } catch {
    // best effort
  }
}

/** Full handoff markdown, or '' when the file doesn't exist (yet). */
export function readHandoff(dataDir: string, runId: string): string {
  try {
    return readFileSync(handoffPath(dataDir, runId), 'utf8');
  } catch {
    return '';
  }
}

/**
 * First few non-empty lines under "## Progress log" (spec 010 — the variant
 * comparison columns). Stops at the next `## ` header; '' when there's no
 * Progress log section or it's empty.
 */
export function handoffProgressExcerpt(text: string, maxLines = 3): string {
  const marker = '## Progress log';
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  const lines: string[] = [];
  for (const line of text.slice(idx + marker.length).split('\n')) {
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines.push(trimmed);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}

export function deleteHandoff(dataDir: string, runId: string): void {
  try {
    rmSync(handoffPath(dataDir, runId), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Appended to every agent step's `--append-system-prompt` (spec 007). The
 * matching env vars (CEZ_HANDOFF_FILE / CEZ_TODOS_FILE / CEZ_TASK_ID) are set
 * on the spawned claude process.
 */
export const HANDOFF_INSTRUCTIONS = `## Handoff & follow-ups (cezar)

CEZ_HANDOFF_FILE (env) is the absolute path to this task's rolling handoff file. Treat it like a HANDOFF.md:
1. At the start of work, read it — "Resume notes" left by a previous session is your starting context.
2. After every meaningful milestone (passing tests, a commit, a PR, a scope decision), append one terse timestamped line under "## Progress log", newest at the top.
3. Before finishing or pausing, update "## Resume notes" with what's done, what's next and any blockers. Leave it empty only when the task is truly complete.

CEZ_TODOS_FILE (env) is the absolute path to the user's follow-up inbox — a JSON array. When you finish the task and a concrete follow-up remains for the user or a next agent, read the file (treat a missing file as []), append ONE object and write the whole array back:
{ "ts": "<ISO 8601>", "taskId": "<value of CEZ_TASK_ID>", "summary": "<one sentence: what was done / what's next>", "action": "<imperative user action, optional>", "prUrl": "<optional>", "suggestedSkill": "<optional skill name for the follow-up>", "suggestedArgs": "<optional>", "suggestedPrompt": "<optional freeform prompt for the follow-up task>" }
Never modify or remove existing entries — append only.`;
