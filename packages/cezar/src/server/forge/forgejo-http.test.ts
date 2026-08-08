import { describe, expect, it, vi } from 'vitest';
import { createForgejoHttp, ForgejoHttpError, messageFromBody, normalizeApiBase, readTotalCount } from './forgejo-http.ts';

/**
 * `forgejo-http.ts` — the HTTP foundation every Forgejo driver method sits on. The repo has no
 * fetch-mocking precedent (the only DI precedent is `vi.mock('node:child_process')` for `gh`), so
 * every test here builds `fetch` as a `vi.fn()` returning hand-built `Response` objects and asserts
 * on the exact request (`fetch.mock.calls[n]`) rather than trusting a helper to have built "close
 * enough". This file guards the two measured `new URL` defects (see `resolveTarget`'s own comment
 * for the two failing cases reproduced on live Node) and the token origin-leak security gate.
 */

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function textResponse(text: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain', ...(init.headers ?? {}) },
  });
}

describe('normalizeApiBase', () => {
  it.each([
    ['http://forgejo:3000', 'http://forgejo:3000/api/v1'],
    ['http://forgejo:3000/api/v1', 'http://forgejo:3000/api/v1'],
    ['http://forgejo:3000/api/v1/', 'http://forgejo:3000/api/v1'],
    ['https://forge.example.com/git/', 'https://forge.example.com/git/api/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeApiBase(input)).toBe(expected);
  });
});

describe('readTotalCount', () => {
  it('reads the header as a number', () => {
    expect(readTotalCount(new Headers({ 'X-Total-Count': '118' }))).toBe(118);
  });

  it('is null when the header is absent', () => {
    expect(readTotalCount(new Headers())).toBeNull();
  });

  it('is null when the header is not numeric', () => {
    expect(readTotalCount(new Headers({ 'X-Total-Count': 'nope' }))).toBeNull();
  });
});

describe('request URL construction (two `new URL` base-resolution defects, verified on live Node)', () => {
  // `new URL('/repos/o/r', 'http://forgejo:3000/api/v1')` drops `/api/v1` (leading slash resets
  // the base's path), and `new URL('repos/o/r', 'http://forgejo:3000/api/v1')` (no trailing `/`
  // on the base) drops the base's LAST segment even for a relative path, landing on
  // `http://forgejo:3000/api/repos/o/r`. Both are reproduced here as full-URL assertions — a
  // header-only assertion would have let the first regression through.
  it('joins a relative path onto the normalized base with the api/v1 segment intact', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await http.getJson('repos/o/r');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://forgejo:3000/api/v1/repos/o/r');
  });

  it('strips a defensive leading slash to the identical URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await http.getJson('/repos/o/r');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://forgejo:3000/api/v1/repos/o/r');
  });

  it('keeps the query string intact', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await http.getJson('repos/o/r/pulls?state=all&page=2');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://forgejo:3000/api/v1/repos/o/r/pulls?state=all&page=2');
  });

  it('is idempotent when the configured apiUrl already carries /api/v1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000/api/v1', { fetch: fetchMock, token: null });
    expect(http.apiBase).toBe('http://forgejo:3000/api/v1');
    await http.getJson('repos/o/r');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://forgejo:3000/api/v1/repos/o/r');
  });
});

describe('Authorization header — decision 2 (token gated on origin)', () => {
  it('attaches "token <t>" — NOT "Bearer" — when the target is the api origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: 'abc123' });
    await http.getJson('repos/o/r');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('token abc123');
  });

  it('reports hasToken() true only when a token is configured', () => {
    const withToken = createForgejoHttp('http://forgejo:3000', { fetch: vi.fn(), token: 'abc' });
    const withoutToken = createForgejoHttp('http://forgejo:3000', { fetch: vi.fn(), token: null });
    expect(withToken.hasToken()).toBe(true);
    expect(withoutToken.hasToken()).toBe(false);
  });

  it('reports hasToken() false for an empty-string token (e.g. `export CEZ_FORGEJO_TOKEN=` in a shell script)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: '' });
    expect(http.hasToken()).toBe(false);
    await http.getJson('repos/o/r');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('omits the header, and still resolves the evil URL, when a full URL in `path` targets another origin', async () => {
    // Security gate: `path` being a full URL overrides the base (`new URL` honors it), so the
    // gate MUST compare the resolved target's origin, not just trust the base. If this test passed
    // trivially (e.g. the helper always glued onto our own base), it would be a tautology, not a
    // proof — hence asserting both the resolved URL AND the absent header.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: 'abc123' });
    await http.getJson('http://evil.example/api/v1/x');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://evil.example/api/v1/x');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('sends no header — and no error — when no token is configured at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('repos/o/r')).resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('reads process.env.CEZ_FORGEJO_TOKEN per request when deps.token is undefined', async () => {
    const saved = process.env.CEZ_FORGEJO_TOKEN;
    process.env.CEZ_FORGEJO_TOKEN = 'from-env';
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock });
      await http.getJson('repos/o/r');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get('authorization')).toBe('token from-env');
    } finally {
      if (saved === undefined) delete process.env.CEZ_FORGEJO_TOKEN;
      else process.env.CEZ_FORGEJO_TOKEN = saved;
    }
  });
});

describe('redirect handling', () => {
  it('requests redirect: "manual" on every call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await http.getJson('repos/o/r');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
  });

  it('treats a 3xx response as an error — no hop ever sees the Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(textResponse('', { status: 302, headers: { location: 'http://forgejo:3000/api/v1/repos/o/r2' } }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: 'abc' });
    await expect(http.getJson('repos/o/r')).rejects.toBeInstanceOf(ForgejoHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never followed
  });
});

describe('error normalization', () => {
  it('does not crash the parser on a text/plain 404 body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('404 page not found\n', { status: 404 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('bogus')).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('404 page not found'),
    });
  });

  it('surfaces the API JSON message field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'repository not found', url: 'x', errors: [] }, { status: 404 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('repos/o/r')).rejects.toMatchObject({ status: 404, message: 'repository not found' });
  });

  it('hints at CEZ_FORGEJO_TOKEN on a 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'token is required', url: 'x' }, { status: 401 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('repos/o/r')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('CEZ_FORGEJO_TOKEN'),
    });
  });

  it('an empty body (no JSON message, no text) degrades to the status code, not messageFromBody\'s own default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('', { status: 500 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('repos/o/r')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});

describe('messageFromBody', () => {
  it('returns the empty string, not a hardcoded default, when neither json nor text carry a message', () => {
    // Distinct from `firstLine`'s own 'request failed' default — callers (`describeErrorBody`,
    // `forgejo.ts`'s `sendErrorMessage`) each need their OWN status/action-specific default, and can
    // only supply one if this function's "found nothing" signal is falsy, not itself a non-empty string.
    expect(messageFromBody(null, '')).toBe('');
    expect(messageFromBody({}, '   \n  ')).toBe('');
  });

  it('still prefers the JSON message field, then the first non-blank text line', () => {
    expect(messageFromBody({ message: 'repository not found' }, 'ignored')).toBe('repository not found');
    expect(messageFromBody(null, '\n404 page not found\n')).toBe('404 page not found');
  });
});

describe('timeout', () => {
  it('aborts instead of hanging forever', async () => {
    const fetchMock = vi.fn(
      (_target: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getJson('repos/o/r', { timeoutMs: 5 })).rejects.toThrow();
  });
});

describe('send', () => {
  it('does not throw on a 4xx response — returns {status, json, text}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'conflict' }, { status: 409 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const result = await http.send('POST', 'repos/o/r/pulls/1/merge', { Do: 'merge' });
    expect(result.status).toBe(409);
    expect(result.json).toEqual({ message: 'conflict' });
  });

  it('sends the body as JSON with a redirect:"manual" POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, { status: 201 }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await http.send('POST', 'repos/o/r/pulls', { head: 'x', base: 'main' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual({ head: 'x', base: 'main' });
  });
});

describe('getText', () => {
  it('returns the raw response body without attempting JSON parsing', async () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
    const fetchMock = vi.fn().mockResolvedValue(textResponse(diff));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.getText('repos/o/r/pulls/1.diff', { accept: 'text/plain' })).resolves.toBe(diff);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('text/plain');
  });
});

describe('paginate', () => {
  const pageUrl = (page: number, limit: number) => `repos/o/r/issues?page=${page}&limit=${limit}`;
  const rowsOfLength = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('stops once X-Total-Count says every row is in hand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50), { headers: { 'x-total-count': '100' } }))
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50), { headers: { 'x-total-count': '100' } }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 100, pageLimit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.rows).toHaveLength(100);
    expect(page.stoppedShort).toBe(false);
    expect(page.stopReason).toBeUndefined();
  });

  it('a server that silently caps the page size below the requested limit loses no rows', async () => {
    // Measured on the live instance: `?limit=1000` still returns pages of 50. `pageSize` for the
    // total-count arithmetic MUST come from the first page's actual length, not the requested
    // limit — comparing against the requested 1000 would misfire "short page" after page 1.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50), { headers: { 'x-total-count': '118' } }))
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50), { headers: { 'x-total-count': '118' } }))
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(18), { headers: { 'x-total-count': '118' } }));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 120, pageLimit: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(page.rows).toHaveLength(118);
    expect(page.stoppedShort).toBe(false);
  });

  it('a later page shorter than the established page size ends the walk without X-Total-Count', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50))) // no total header — establishes pageSize=50
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(20)));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 1000, pageLimit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.rows).toHaveLength(70);
    expect(page.stoppedShort).toBe(false);
  });

  it('gives up at maxPages and marks the result stoppedShort with stopReason:"limit" — a deterministic ceiling, not a one-off failure', async () => {
    // A fresh Response per call — a shared mock Response's body stream can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(rowsOfLength(50))));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 1000, pageLimit: 50, maxPages: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.rows).toHaveLength(100);
    expect(page.stoppedShort).toBe(true);
    expect(page.stopReason).toBe('limit');
  });

  it('gives up when the shared time budget runs out before the next page could finish, stopReason:"budget"', async () => {
    let now = 0;
    const fetchMock = vi.fn(() => {
      now += 4_000; // simulate each page costing 4s
      return Promise.resolve(jsonResponse(rowsOfLength(50)));
    });
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, now: () => now, token: null });
    const page = await http.paginate(pageUrl, { want: 1000, pageLimit: 50, budgetMs: 5_000, minPageMs: 2_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 5000 - 4000 = 1000 remaining < minPageMs(2000)
    expect(page.stoppedShort).toBe(true);
    expect(page.stopReason).toBe('budget');
  });

  it('stops as soon as "want" rows are collected before the natural end, stopReason:"limit" (the same deterministic-ceiling category as maxPages)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rowsOfLength(50))); // full pages, no header — could go forever
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 30, pageLimit: 50, maxPages: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.rows).toHaveLength(50);
    expect(page.stoppedShort).toBe(true);
    expect(page.stopReason).toBe('limit');
  });

  it('"want" reached exactly at the natural end (short page) is NOT stoppedShort', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50)))
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(20)));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 70, pageLimit: 50 });
    expect(page.rows).toHaveLength(70);
    expect(page.stoppedShort).toBe(false);
  });

  it('a request failure on page 1 propagates — nothing was collected yet (documented choice)', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down'));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    await expect(http.paginate(pageUrl, { want: 10, pageLimit: 50 })).rejects.toThrow('network down');
  });

  it('a request failure on a later page keeps the rows already collected and marks stoppedShort with stopReason:"error" — a one-off, not a deterministic ceiling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rowsOfLength(50)))
      .mockRejectedValueOnce(new Error('network down'));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 1000, pageLimit: 50 });
    expect(page.rows).toHaveLength(50);
    expect(page.stoppedShort).toBe(true);
    expect(page.stopReason).toBe('error');
  });

  it('an empty first page (no rows, no X-Total-Count) is the natural end — never walks the remaining pages', async () => {
    // Without the explicit `pageRows.length === 0` check, `pageSize` is set to 0 from this same
    // empty page, so `pageRows.length < pageSize` reads `0 < 0` (false) forever — the walk would
    // burn every one of `maxPages` requests and report a false `stoppedShort:true`.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rowsOfLength(0)));
    const http = createForgejoHttp('http://forgejo:3000', { fetch: fetchMock, token: null });
    const page = await http.paginate(pageUrl, { want: 1000, pageLimit: 50, maxPages: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.rows).toHaveLength(0);
    expect(page.stoppedShort).toBe(false);
  });
});
