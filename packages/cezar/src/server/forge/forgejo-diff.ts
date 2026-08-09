/**
 * Splits a Forgejo `GET /pulls/{n}.diff` unified-diff response into one entry per file, keyed by
 * that file's NEW path — the same `filename` a `/pulls/{n}/files` row carries, so `forgejo.ts`'s
 * `prDiff` can join the two by that key (never by position, never by re-parsing the `diff --git`
 * header as the primary source — a misread header would hand one file's patch to a different
 * file, the exact bug this module's join contract exists to prevent).
 *
 * Deliberately NOT a diff engine: no hunk parsing, no rename-similarity math, nothing beyond
 * finding file boundaries and lifting out the handful of header lines this driver actually reads
 * (`+++`/`---`, `rename from`/`rename to`, the two binary markers). Zero I/O, pure string
 * processing — `forgejo.ts` is the only caller.
 */

export interface ForgejoDiffEntry {
  path: string;
  previousPath?: string;
  patch?: string;
  binary: boolean;
}

/**
 * Git quotes a path (wraps it in `"…"`, C-style-escaped) only when it contains a character that
 * would otherwise be ambiguous in a diff header — a literal `"`, a backslash, a control
 * character, or (with the default `core.quotePath=true`) any non-ASCII byte, escaped as octal
 * `\NNN`. Bytes are collected individually and decoded as UTF-8 only once, at the end — a single
 * non-ASCII code point is usually SEVERAL consecutive `\NNN` escapes (one per UTF-8 byte), not
 * one, so decoding byte-by-byte via `String.fromCharCode` would mangle anything outside Latin-1.
 * A string that isn't quoted at all (the common case — most paths need no escaping) passes
 * through unchanged.
 *
 * Sibling implementation: `git-changes.ts`'s own `unquoteGitPath` (git-changes.ts:169-187) does
 * the same job for `git diff --patch` output rather than the Forgejo REST diff text this module
 * parses — a candidate for future consolidation, not attempted here (out of this fix's scope).
 */
export function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = inner[i + 1];
    if (next === 't') {
      bytes.push(9);
      i++;
    } else if (next === 'n') {
      bytes.push(10);
      i++;
    } else if (next === 'r') {
      bytes.push(13);
      i++;
    } else if (next === 'f') {
      bytes.push(12);
      i++;
    } else if (next === '"') {
      bytes.push(34);
      i++;
    } else if (next === '\\') {
      bytes.push(92);
      i++;
    } else if (next !== undefined && next >= '0' && next <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8) & 0xff);
      i += 3;
    } else {
      // Unrecognized escape — keep the backslash literally; `next` (if any) is picked up as its
      // own character on the following loop iteration.
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Unquotes, then strips a leading `a/`/`b/` prefix — the form every `+++`/`---`/header-line path
 *  arrives in. `/dev/null` (the "this side doesn't exist" marker for added/deleted files) is
 *  passed through verbatim so callers can recognize and special-case it. */
function stripAbPrefix(token: string): string {
  const unquoted = unquoteGitPath(token.trim());
  if (unquoted === '/dev/null') return unquoted;
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * Best-effort split of the `diff --git a/X b/Y` header line into its two paths — used ONLY as the
 * last-resort path source, for the one case that has neither a `+++`/`---` pair, a `rename to`,
 * nor a binary marker to supply a path: a pure file-mode change. A header where both sides are
 * individually quoted (`"a/…" "b/…"`) is unambiguous; an unquoted header is split on the LAST
 * ` b/` — good enough, since a legitimate path is not expected to contain that exact substring.
 */
function parseHeaderPaths(headerLine: string): { a: string; b: string } | null {
  if (headerLine.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(headerLine);
    if (!m) return null;
    return { a: stripAbPrefix(m[1]!), b: stripAbPrefix(m[2]!) };
  }
  const idx = headerLine.lastIndexOf(' b/');
  if (idx === -1) return null;
  return { a: stripAbPrefix(headerLine.slice(0, idx)), b: stripAbPrefix(headerLine.slice(idx + 1)) };
}

/** One file's block — everything between one `diff --git ` match and the next (or the end of the
 *  text), with the `diff --git ` prefix itself already stripped by the caller's `.split()`. */
function parseDiffBlock(block: string): ForgejoDiffEntry | null {
  // A block normally ends with a trailing '\n' right before the next "diff --git " (or before
  // end-of-string, if the whole diff itself ends with one) — drop it so `patch` never carries a
  // spurious trailing blank line the wire response never actually had.
  const body = block.endsWith('\n') ? block.slice(0, -1) : block;
  const lines = body.split('\n');

  let plusPath: string | null = null;
  let minusPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let binary = false;
  let hunkStart = -1;

  // Header lines (`+++`/`---`/`rename from`/`rename to`/binary markers) only ever appear BEFORE
  // the first hunk — never after. A hunk's own content can legitimately contain lines that start
  // with the same prefixes (a removed SQL comment `-- foo` reads as `--- foo`; an added `++ i;`
  // reads as `+++ i;`), so scanning must stop the instant the first `@@` is seen, or those content
  // lines silently clobber plusPath/minusPath/etc. with garbage.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      hunkStart = i;
      break;
    } else if (line.startsWith('+++ ')) plusPath = stripAbPrefix(line.slice(4));
    else if (line.startsWith('--- ')) minusPath = stripAbPrefix(line.slice(4));
    else if (line.startsWith('rename from ')) renameFrom = unquoteGitPath(line.slice('rename from '.length).trim());
    else if (line.startsWith('rename to ')) renameTo = unquoteGitPath(line.slice('rename to '.length).trim());
    else if (line.startsWith('Binary files ')) {
      binary = true;
      const m = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (m) {
        minusPath = minusPath ?? stripAbPrefix(m[1]!);
        plusPath = plusPath ?? stripAbPrefix(m[2]!);
      }
    } else if (line.startsWith('GIT binary patch')) {
      binary = true;
    }
  }

  // Priority chain for the map key (the file's NEW path): a real `+++ b/…` wins when present (the
  // common, most precise case); a pure rename with no content diff has no `+++` at all, so
  // `rename to` is next; `--- a/…` covers a deleted file (`+++ /dev/null`, so `plusPath` is
  // discarded above); the `diff --git` header is the last resort, for a mode-only change that has
  // none of the above.
  const path =
    (plusPath && plusPath !== '/dev/null' ? plusPath : null) ??
    renameTo ??
    (minusPath && minusPath !== '/dev/null' ? minusPath : null) ??
    parseHeaderPaths(lines[0] ?? '')?.b ??
    null;
  if (!path) return null;

  const candidatePrevious = renameFrom ?? (minusPath && minusPath !== '/dev/null' ? minusPath : null);
  const previousPath = candidatePrevious && candidatePrevious !== path ? candidatePrevious : undefined;

  const patch = !binary && hunkStart !== -1 ? lines.slice(hunkStart).join('\n') : undefined;

  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    ...(patch !== undefined ? { patch } : {}),
    binary,
  };
}

/** `forgejo.ts`'s `prDiff` is the only caller. `.slice(1)`: the first element of the split is
 *  whatever precedes the FIRST "diff --git " match (empty for a well-formed diff response) — it
 *  can never be a file block, and is dropped defensively either way. */
export function splitUnifiedDiff(diffText: string): Map<string, ForgejoDiffEntry> {
  const result = new Map<string, ForgejoDiffEntry>();
  const blocks = diffText.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const entry = parseDiffBlock(block);
    if (entry) result.set(entry.path, entry);
  }
  return result;
}
