import { MAX_REF } from './task-refs.js';

/**
 * In-band task-reference markers (spec 2026-07-18-task-ref-markers): the main
 * agent thread declares its subject PR/issue — and optionally a title — the
 * same way it declares completion with `CEZ:DONE`. Parsed from the accumulated
 * turn text only (the agent's own words, never tool output), so a task that
 * merely *reads* the marker contract cannot poison its record. Marker values
 * outrank the fuzzy discovery layers; precedence lives in the spec's table.
 */

export interface TaskMarkers {
  pr?: number;
  issue?: number;
  title?: string;
}

// Line-anchored so prose that mentions a marker never parses; the instruction
// fragment's own `CEZ:PR=<number>` placeholder is non-numeric and inert.
const PR_MARKER_RE = /^CEZ:PR=(\d+)\s*$/gm;
const ISSUE_MARKER_RE = /^CEZ:ISSUE=(\d+)\s*$/gm;
const TITLE_MARKER_RE = /^CEZ:TITLE=(.+)$/gm;

function lastNumber(text: string, re: RegExp): number | undefined {
  let value: number | undefined;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && n < MAX_REF) value = n;
  }
  return value;
}

/** The turn's declared references. The last occurrence of each marker wins —
 *  an agent that corrects itself mid-turn is believed, not averaged. */
export function parseTaskMarkers(text: string): TaskMarkers {
  const markers: TaskMarkers = {};
  const source = text ?? '';
  const pr = lastNumber(source, PR_MARKER_RE);
  if (pr !== undefined) markers.pr = pr;
  const issue = lastNumber(source, ISSUE_MARKER_RE);
  if (issue !== undefined) markers.issue = issue;
  let title: string | undefined;
  for (const match of source.matchAll(TITLE_MARKER_RE)) {
    const t = match[1]?.trim();
    if (t) title = t;
  }
  if (title !== undefined) markers.title = title;
  return markers;
}

const MARKER_LINE = /^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/;

/**
 * Remove complete marker lines from display text — the `stripDoneMarker`
 * precedent. Best-effort by design: a marker split across streamed v1 chunks
 * may transiently render; parsing always runs on the whole turn text, so the
 * record is never affected. Mirrored for v2 display in the cockpit's
 * `thread-state.ts`.
 */
export function stripTaskMarkers(text: string): string {
  if (!text.includes('CEZ:')) return text;
  return text
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line))
    .join('\n');
}
