import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The global follow-up inbox (spec 007): `.ai/cezar/todos.json`, a flat JSON
 * array agents append to (via CEZ_TODOS_FILE). Agent entries are external
 * data — each one is zod-validated on read and malformed ones are skipped
 * with a warning, never fatal. Server writes are serialized with an
 * in-process lock (the janitor `withLock` pattern) and land atomically
 * (tmp + rename, the runs.json pattern).
 */

export const todoSchema = z.object({
  id: z.string().min(1).optional(),
  ts: z.string().optional(),
  taskId: z.string().optional(),
  summary: z.string().min(1),
  action: z.string().optional(),
  prUrl: z.string().optional(),
  suggestedSkill: z.string().optional(),
  suggestedArgs: z.string().optional(),
  suggestedPrompt: z.string().optional(),
  /** Explicit intent; legacy entries infer it from an executable suggestion. */
  runnable: z.boolean().optional(),
  /** Set by the server when "▶ Run" turned this entry into a task. */
  startedTaskId: z.string().optional(),
});

export type TodoItem = z.infer<typeof todoSchema> & { id: string };

export function todosPath(dataDir: string): string {
  return join(dataDir, 'todos.json');
}

// ---- in-process lock (15-line port of janitor's storage.withLock) ----------

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((r) => {
    release = r;
  });
  locks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ---- read / write -----------------------------------------------------------

/** Parse + validate the file. Broken JSON / non-array → []; bad entries are
 *  skipped with a warning; entries without an id get one assigned. */
async function readRaw(dataDir: string): Promise<{ items: TodoItem[]; needsRewrite: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(todosPath(dataDir), 'utf8');
  } catch {
    return { items: [], needsRewrite: false }; // no file yet — empty inbox
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] todos.json is not valid JSON — showing an empty inbox (${message})`);
    return { items: [], needsRewrite: false };
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] todos.json is not a JSON array — showing an empty inbox');
    return { items: [], needsRewrite: false };
  }
  const items: TodoItem[] = [];
  let needsRewrite = false;
  for (const entry of parsed) {
    const result = todoSchema.safeParse(entry);
    if (!result.success) {
      console.warn(`[cez] skipped a malformed todos.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (!result.data.id) {
      // Agent entries arrive without ids — assign one so the GUI can address
      // the entry; the file is rewritten (under the lock) on this read.
      needsRewrite = true;
      items.push({ ...result.data, id: randomUUID() });
    } else {
      items.push({ ...result.data, id: result.data.id });
    }
  }
  return { items, needsRewrite };
}

async function writeAtomic(dataDir: string, items: TodoItem[]): Promise<void> {
  const file = todosPath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function readTodos(dataDir: string): Promise<TodoItem[]> {
  return withLock(dataDir, async () => {
    const { items, needsRewrite } = await readRaw(dataDir);
    if (needsRewrite) {
      await writeAtomic(dataDir, items).catch(() => undefined); // best effort
    }
    return items;
  });
}

/** Check off (delete) an entry. False when the id isn't there. */
export async function removeTodo(dataDir: string, id: string): Promise<boolean> {
  return withLock(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const next = items.filter((t) => t.id !== id);
    if (next.length === items.length) return false;
    await writeAtomic(dataDir, next);
    return true;
  });
}

/** The task text "▶ Run" turns an entry into: the suggested prompt (or the summary when the
 *  entry carries none), plus the suggested args as a trailing line. The single server-side
 *  source for `POST /api/todos/:id/start`; the cockpit's prefill copy
 *  (`web/app/src/routes/inbox.tsx`, #374) lives in another process and cannot import this, so
 *  the two are pinned to the shared cases in `test/fixtures/todo-task-text.json`. */
export function todoTaskText(
  todo: Pick<TodoItem, 'summary' | 'suggestedPrompt' | 'suggestedArgs'>,
): string {
  let task = (todo.suggestedPrompt ?? todo.summary).trim() || todo.summary;
  if (todo.suggestedArgs) task += `\n\nArguments: ${todo.suggestedArgs}`;
  return task;
}

/** Record that "▶ Run" turned the entry into task `taskId`. The entry stays
 *  in the file as an audit trail; the GUI hides started entries. First start wins: an entry
 *  that already carries a `startedTaskId` is left untouched and answers false, so the
 *  best-effort `todoId` bookkeeping on `POST /api/runs` (#374) can never overwrite the audit
 *  trail — the check shares this lock, so two concurrent launches cannot both claim the entry. */
export async function markStarted(dataDir: string, id: string, taskId: string): Promise<boolean> {
  return withLock(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const item = items.find((t) => t.id === id);
    if (!item || item.startedTaskId) return false;
    item.startedTaskId = taskId;
    await writeAtomic(dataDir, items);
    return true;
  });
}

// ---- change notifications ----------------------------------------------------

const emitter = new EventEmitter();
emitter.setMaxListeners(100);
let watching = false;

/** Watch `.ai/cezar/` for todos.json changes (agents write it from another
 *  process) and emit debounced change events. Degrades to no watch on error. */
export function startTodosWatch(dataDir: string): void {
  if (watching) return;
  watching = true;
  try {
    mkdirSync(dataDir, { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename && filename !== 'todos.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => emitter.emit('changed'), 300);
      timer.unref?.();
    });
    watcher.on('error', () => undefined); // a dying watcher must not kill the server
    watcher.unref?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] todos watch unavailable — the Inbox updates on refresh only (${message})`);
  }
}

/** Subscribe to inbox changes; returns the unsubscribe function. */
export function onTodosChanged(cb: () => void): () => void {
  emitter.on('changed', cb);
  return () => emitter.off('changed', cb);
}
