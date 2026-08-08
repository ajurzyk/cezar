import { describe, expect, it } from 'vitest';
import { splitUnifiedDiff, unquoteGitPath } from './forgejo-diff.ts';

/**
 * `splitUnifiedDiff` is a splitter, not a diff engine: it cuts a unified diff (as returned by
 * `GET /pulls/{n}.diff`) into one entry per file, keyed by that file's NEW path (from `+++ b/…`,
 * or the best fallback a header/marker line offers when no `+++` line exists at all — a binary
 * file or a pure rename/mode-change has no `+++`/`---` lines). `forgejo.ts`'s `prDiff` is the only
 * consumer, and it joins these entries against `/pulls/{n}/files` rows by `path` — never by
 * position or by the raw `diff --git` header: a misparsed header would silently hand one file's
 * patch to a different file, which is exactly the bug the "joining by filename" test below exists
 * to catch.
 */

describe('unquoteGitPath', () => {
  it('returns a plain (unquoted) path unchanged', () => {
    expect(unquoteGitPath('a/plain/path.ts')).toBe('a/plain/path.ts');
  });

  it('unescapes \\t, \\", and \\\\ inside a quoted path', () => {
    expect(unquoteGitPath('"a/pa\\th"')).toBe('a/pa\th');
    expect(unquoteGitPath('"a/quo\\"te"')).toBe('a/quo"te');
    expect(unquoteGitPath('"a/back\\\\slash"')).toBe('a/back\\slash');
  });

  it('decodes an octal byte escape (\\NNN) as a UTF-8 byte', () => {
    // "é" is U+00E9, UTF-8 bytes 0303 0251 (octal) — git emits exactly this for a non-ASCII
    // byte inside a quoted path.
    expect(unquoteGitPath('"a/caf\\303\\251.txt"')).toBe('a/café.txt');
  });
});

describe('splitUnifiedDiff', () => {
  it('cuts on /^diff --git /m, keys each entry by the NEW path from "+++ b/…", and starts patch at the first "@@"', () => {
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old a',
      '+new a',
      ' context a',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old b',
      '+new b',
      '',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect([...entries.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(entries.get('src/a.ts')).toEqual({
      path: 'src/a.ts',
      binary: false,
      patch: '@@ -1,2 +1,2 @@\n-old a\n+new a\n context a',
    });
    expect(entries.get('src/b.ts')).toEqual({
      path: 'src/b.ts',
      binary: false,
      patch: '@@ -1 +1 @@\n-old b\n+new b',
    });
  });

  it('sets previousPath from "--- a/…" only when it differs from the new path', () => {
    const diffText = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 90%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1 +1 @@',
      '-old name',
      '+new name',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('src/new-name.ts')).toEqual({
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      binary: false,
      patch: '@@ -1 +1 @@\n-old name\n+new name',
    });
  });

  it('an unchanged content diff (same path on both sides) never gets a previousPath', () => {
    const diffText = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y'].join(
      '\n',
    );

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('src/a.ts')?.previousPath).toBeUndefined();
  });

  it('marks "Binary files … differ" as binary:true, keyed by the "b/…" path, with no patch', () => {
    const diffText = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('assets/logo.png')).toEqual({ path: 'assets/logo.png', binary: true });
  });

  it('marks "GIT binary patch" as binary:true, keyed off the diff --git header, with no patch', () => {
    const diffText = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 12',
      'some binary garbage here',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('assets/logo.png')).toEqual({ path: 'assets/logo.png', binary: true });
  });

  it('a rename with no content change (no hunks) still yields an entry with previousPath, no patch, binary:false', () => {
    const diffText = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('src/new.ts')).toEqual({
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      binary: false,
    });
  });

  it('a mode-only change (no rename, no hunks, no +++/---) still yields an entry keyed from the diff --git header', () => {
    const diffText = ['diff --git a/bin/run.sh b/bin/run.sh', 'old mode 100644', 'new mode 100755'].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('bin/run.sh')).toEqual({ path: 'bin/run.sh', binary: false });
  });

  it('unquotes a git-escaped path from "+++ b/…" into the map key', () => {
    const diffText = [
      'diff --git "a/pa\\th" "b/pa\\th"',
      'index 1111111..2222222 100644',
      '--- "a/pa\\th"',
      '+++ "b/pa\\th"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect([...entries.keys()]).toEqual(['pa\th']);
  });

  it('joining by filename (not by position) survives a file order that does not match the /files listing', () => {
    // The two diff blocks are deliberately in the OPPOSITE order a caller might expect from a
    // `/files` listing sorted some other way — proves a caller must look entries up by path,
    // never assume `[...map.values()][i]` lines up with the i-th `/files` row.
    const diffText = [
      'diff --git a/z.ts b/z.ts',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -1 +1 @@',
      '-z old',
      '+z new',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a old',
      '+a new',
    ].join('\n');

    const entries = splitUnifiedDiff(diffText);

    expect(entries.get('a.ts')?.patch).toBe('@@ -1 +1 @@\n-a old\n+a new');
    expect(entries.get('z.ts')?.patch).toBe('@@ -1 +1 @@\n-z old\n+z new');
  });
});
