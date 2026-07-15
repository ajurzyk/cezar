/**
 * Auto-summary titles (#389): derive a short display title for a run from the
 * text of an agent turn. Pure by design — the RunManager calls this on
 * turn-end and stores the first informative answer as `RunRecord.titleSummary`.
 *
 * Honest absence beats a garbage title: when the turn text yields nothing
 * better than the raw task's first line (too short, markdown noise only,
 * or a verbatim echo of the task), the answer is `undefined` and the UI
 * keeps showing the raw `title`.
 */

/** Display cap, in code points — matches `makeTitle`'s 80-char convention. */
const MAX_LEN = 80;

/** A summary shorter than this many words says nothing — skip it. */
const MIN_WORDS = 4;

/** Conversational lead-ins that carry no information about the task. Applied
 *  repeatedly, so "Sure! I'll go ahead and fix …" strips down to "fix …". */
const FLUFF_RES = [
  /^(?:sure|okay|ok|alright|great|certainly|understood|got it|sounds good|of course)[,.!:]*\s+/i,
  /^(?:i(?:'|’)?ll|i will|i(?:'|’)?m going to|i(?:'|’)?m about to|let me|let(?:'|’)?s|first,?|now,?)\s+/i,
  /^(?:go ahead and|start by|begin by)\s+/i,
];

/** Strip inline markdown emphasis/code from one line. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '') // heading marker
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '') // list marker
    .replace(/^>\s+/, '') // blockquote marker
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1$2') // word-bound _emphasis_, not snake_case
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) → text
    .trim();
}

/**
 * First sentence of `s`. Sentence end = `.`/`!`/`?` followed by whitespace or
 * end of string — so dots inside paths (`src/store.ts`) don't cut it short.
 */
function firstSentence(s: string): string {
  const match = /^(.*?[.!?])(?:\s|$)/.exec(s);
  return (match?.[1] ?? s).replace(/[.!?]+$/, '').trim();
}

/**
 * Derive a display title from an agent turn's text, or `undefined` when the
 * text yields nothing more informative than the task itself.
 */
export function deriveTitleSummary(text: string, task: string): string | undefined {
  // Fenced code blocks are never titles — drop them (incl. an unclosed one).
  const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');

  const line = withoutFences
    .split('\n')
    .map((l) => stripInlineMarkdown(l))
    .find((l) => l.length > 0);
  if (!line) return undefined;

  // Fluff first, sentence second: "Sure! I'll fix …" — the fluff IS the
  // first sentence, so stripping after extraction would keep only "Sure".
  let s = line;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const re of FLUFF_RES) {
      const next = s.replace(re, '');
      if (next !== s) {
        s = next;
        stripped = true;
      }
    }
  }
  s = firstSentence(s.trim());

  // Cap by code points, not UTF-16 units — no split surrogate pairs.
  const chars = [...s];
  if (chars.length > MAX_LEN) s = `${chars.slice(0, MAX_LEN - 1).join('').trimEnd()}…`;

  // Informative? More than a few words, and not an echo of the task.
  if (s.split(/\s+/).filter(Boolean).length < MIN_WORDS) return undefined;
  const taskFirstLine = (task.trim().split('\n')[0] ?? '').trim().toLowerCase();
  if (s.toLowerCase() === taskFirstLine) return undefined;

  const first = [...s][0] ?? '';
  return first.toUpperCase() + s.slice(first.length);
}
