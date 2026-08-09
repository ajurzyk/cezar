/**
 * The Forgejo HTTP foundation — auth, error normalization, timeouts and a bounded paginator,
 * shared by every method the Forgejo driver (`forgejo.ts`) grows over time. Nothing here knows
 * about issues/PRs/reviews; that mapping belongs one layer up, in the driver's own mappers.
 * `fetch` is injected (`deps.fetch`, default `globalThis.fetch`) so the whole module is testable
 * with zero network I/O.
 */

export const FJ_TIMEOUT_MS = 15_000;
/** Live-instance fact: the server silently caps a page to 50 rows no matter what `limit` asks
 *  for — `paginate` never trusts this constant for its own bookkeeping (it measures the actual
 *  first-page length instead), but it is still the sane default to request. */
export const FJ_PAGE_LIMIT = 50;
export const FJ_LIST_MAX_PAGES = 20; // = GH_MAX_LIMIT 1000 / FJ_PAGE_LIMIT 50
export const FJ_FILES_MAX_PAGES = 6; // 300 files at 50/page
/** One budget shared by the whole walk, not a per-page allowance — mirrors `TIMELINE_BUDGET_MS`
 *  (github.ts:584-591): a fixed per-request timeout times `maxPages` would put the ceiling an
 *  order of magnitude above what a single bounded walk should ever cost. */
export const FJ_WALK_BUDGET_MS = 15_000;
export const FJ_MIN_PAGE_MS = 2_000;

export interface ForgejoHttpDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Test override. `undefined` (the default) means "read `process.env.CEZ_FORGEJO_TOKEN` fresh on
   *  every request" — a token set/cleared mid-test-run must be observed immediately, not cached at
   *  construction time. */
  token?: string | null;
  /** Injected delay, defaulted (in `forgejo.ts`) to a real `setTimeout`-backed promise. Not used by
   *  this module itself — `createForgejoHttp` never sleeps — but threaded through the same `deps`
   *  bag `createForgejoDriver` already accepts so `prMergeState`'s `mergeable:false` retry
   *  (`normalizeForgejoMergeState`'s doc comment) can be tested with zero real wall-clock wait: a
   *  test passes `sleep: async () => {}` instead of reaching for `vi.useFakeTimers`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown by `getJson`/`getText`/`paginate` on any non-2xx response (3xx included — see the
 *  `redirect: 'manual'` comment on `doRequest` for why a redirect counts as a failure here).
 *  `send` deliberately never throws this; it hands the status back to the caller instead, because
 *  `mergePR`/`createPR` need to inspect 4xx/5xx bodies to build a typed `ForgeMergeResult`. */
export class ForgejoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    message: string,
  ) {
    super(message);
    this.name = 'ForgejoHttpError';
  }
}

/** `apiUrl` from `.ai/cezar/config.json` is just an origin (`http://forgejo:3000`) or may already
 *  carry `/api/v1` (accepted idempotently) — normalize to the canonical form used as the cache key
 *  everywhere in `forgejo.ts`: no trailing slash. The trailing slash is re-added only at the point
 *  a request target is resolved (`resolveTarget` below) — see that function for why both matter. */
export function normalizeApiBase(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

export function readTotalCount(headers: Headers): number | null {
  const raw = headers.get('x-total-count');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface ForgejoPage {
  rows: unknown[];
  /** true = "more rows may exist beyond what was fetched": budget/`minPageMs` cutoff, an error on
   *  page >= 2, exit via `maxPages`, OR `want` was satisfied before the walk reached a natural end.
   *  false ONLY on full enumeration: a short page, or `page * pageSize >= X-Total-Count`. A caller
   *  that decides whether a fallback lookup is safe (e.g. "is it proven there is no open PR with
   *  this branch?") must gate that decision on this field staying honest — never assume completion
   *  from row count alone. */
  stoppedShort: boolean;
  /** WHY `stoppedShort` is true — `undefined` when `stoppedShort` is false (a natural end has no
   *  reason to record). `'limit'` covers BOTH ways the walk can hit its own fixed, deterministic
   *  ceiling — `rows.length >= want` inside the loop, or falling out at `page > maxPages` — which a
   *  caller can treat as a PERSISTENT trait of the repo/branch being walked (the same ceiling will
   *  be hit again on the next call, until the underlying data actually shrinks). `'budget'`
   *  (the `minPageMs`/`budgetMs` time cutoff) and `'error'` (a later page's request itself failing)
   *  are both one-off, more likely transient conditions instead — a caller must NOT treat either as
   *  a stable answer worth remembering past the current call. Exists so a caller like
   *  `resolveForgejoPrStatus` can distinguish "this repo always has more history than this walk's
   *  own budget allows" (worth a short negative cache, see `forgejo.ts`'s
   *  `FORGEJO_PR_STATUS_UNRESOLVED_PERSISTENT`) from "the server hiccuped this one time" (must
   *  never be cached, not even briefly). */
  stopReason?: 'budget' | 'error' | 'limit';
}

export interface ForgejoHttp {
  readonly apiBase: string;
  hasToken(): boolean;
  getJson(path: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  getText(path: string, opts?: { accept?: string; timeoutMs?: number }): Promise<string>;
  send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{ status: number; json: unknown | null; text: string }>;
  paginate(
    pageUrl: (page: number, limit: number) => string,
    opts: { want: number; pageLimit?: number; maxPages?: number; budgetMs?: number; minPageMs?: number },
  ): Promise<ForgejoPage>;
}

/**
 * The ONE place a request URL is built. `new URL`'s own base-resolution rules hide two footguns
 * here, both reproduced on live Node before this function existed:
 *
 *  1. `new URL('/repos/o/r', 'http://forgejo:3000/api/v1')` → `http://forgejo:3000/repos/o/r` —
 *     a leading slash on `path` resets the base's own path entirely, silently dropping `/api/v1`.
 *  2. `new URL('repos/o/r', 'http://forgejo:3000/api/v1')` (base WITHOUT a trailing `/`) →
 *     `http://forgejo:3000/api/repos/o/r` — the base's last path segment (`v1`) is treated as a
 *     "file" and replaced, not kept, even for a plain relative path with no leading slash.
 *
 * The fix is both halves at once: strip any leading slash from `path` (defends against mistake 1
 * — this also quietly neutralizes a protocol-relative `//evil.example/x`, which `^\/+` reduces to
 * `evil.example/x` and which then resolves on OUR OWN origin, not evil's; do not "harden" this
 * strip to stop at a single slash, that would reopen the origin gate below), and always resolve
 * against `${apiBase}/` with an explicit trailing slash (defends against mistake 2). `apiBase`
 * itself (from `normalizeApiBase`) stays trailing-slash-free because it doubles as a cache key
 * across `forgejo.ts` — the slash is added here, at resolution time, not stored.
 *
 * A `path` that is itself a full URL (`http://evil.example/x`) still overrides the base — that is
 * required `URL` behavior, not a bug — which is exactly why the Authorization header is attached
 * in `doRequest` only AFTER comparing `resolveTarget(...).origin` against the api origin, not
 * assumed from the base.
 */
function resolveTarget(apiBase: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ''), `${apiBase}/`);
}

/** Exported so `forgejo.ts` doesn't grow a second copy of the same one-liner (github.ts has its
 *  own, out of scope — see the comment on this module's header for why that file is untouched). */
export function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'request failed';
}

/** Extracts a human-readable message from an already-parsed error body: the JSON `message` field
 *  wins when present and non-empty, otherwise the first non-blank line of the raw text, otherwise
 *  the EMPTY string — deliberately NOT `firstLine`'s own `'request failed'` default. Both callers
 *  (`describeErrorBody` below, `forgejo.ts`'s `sendErrorMessage`) need to tell "found a real message"
 *  from "found nothing" so THEY can supply their own status/action-specific default (`HTTP {status}`,
 *  or an action-specific `fallback` string); a hardcoded default here would make both of those
 *  defaults permanently unreachable. Exported so `sendErrorMessage` doesn't grow a second copy of
 *  this exact extraction — that one works off `send()`'s already-drained `{status, json, text}`
 *  (`send` never throws, so there is no live `Response` left to drain by the time that caller runs),
 *  while `describeErrorBody` below both drains the `Response` AND adds its own status-specific
 *  401/403 hint on top — the hint stays local to `describeErrorBody`, deliberately NOT folded in
 *  here, because `forgejo.ts`'s own create/merge callers each want their own wording for an auth
 *  failure (`mergePR`'s 403 message never mentions the token at all, for instance). */
export function messageFromBody(json: unknown, text: string): string {
  if (json && typeof json === 'object' && 'message' in json) {
    const m = (json as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : '';
}

/**
 * `hasToken` is threaded in rather than read here because this function is module-level while the
 * token lives in `createForgejoHttp`'s closure — and BOTH status-specific rules below need it. It is
 * passed as the already-evaluated boolean, not the `hasToken` function, so the answer is the one
 * that was true for THIS request (the token is re-read from the environment per request, see
 * `currentToken`) rather than whatever it happens to be by the time the error is described.
 */
async function describeErrorBody(res: Response, hasToken: boolean): Promise<{ text: string; message: string }> {
  const text = await res.text().catch(() => '');
  // The live instance answers a bad path with `404 page not found\n` as `text/plain`, but a real
  // API error is `{"message":…,"url":…,"errors":[]}` — read the text FIRST, then try to parse it,
  // so a non-JSON body never throws inside this catch-all and masks itself as "unexpected token".
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON — messageFromBody falls back to the text-derived message
  }

  // An auth failure's body is DISCARDED, never merely filtered. Measured against the live instance
  // (15.0.3+gitea-1.22.0, 2026-08-09): Forgejo echoes the credential it just rejected straight back
  // in `message` — `{"message":"access token does not exist [sha: <the token you sent>]"}` — and
  // this string is contract-bound for humans, not for debugging: `forgejo.ts`'s `describeError`
  // hands it on as `ForgeAvailability.reason`, which the cockpit renders and the server logs. A
  // regex stripping the observed `[sha: …]` shape would be the weaker fix: that is the only shape
  // anyone has SEEN, and nothing stops the next version from wrapping the secret differently. The
  // status code plus our own hint carry everything a user can act on anyway. (The raw body survives
  // on `ForgejoHttpError#bodyText` for debugging; no code path renders or logs that field.)
  if (res.status === 401 || res.status === 403) {
    // Which hint depends on whether a token was actually sent — "set CEZ_FORGEJO_TOKEN" is a lie
    // when it is already set and the server is telling us it is wrong or insufficient.
    const hint = hasToken ? 'CEZ_FORGEJO_TOKEN was rejected by Forgejo' : 'set CEZ_FORGEJO_TOKEN to authenticate';
    return { text, message: `HTTP ${res.status} — ${hint}` };
  }

  // `messageFromBody` returns '' when the body carried nothing usable — this function's own default
  // is the status code, not `firstLine`'s generic 'request failed'.
  let message = messageFromBody(parsed, text) || `HTTP ${res.status}`;

  // Also measured live: a PRIVATE repo answers an ANONYMOUS request with 404, not 401, and the body
  // ("The target couldn't be found.") is byte-identical to a repo that genuinely does not exist. So
  // without a token the 404 is ambiguous, and the token hint is most needed exactly where it never
  // used to fire. Gated on `hasToken` for the same reason the 401 hint is: once a token IS in play a
  // 404 really does mean "no such repo", and suggesting the token there would start lying.
  if (res.status === 404 && !hasToken) {
    message = `${message} — or the repository is private: set CEZ_FORGEJO_TOKEN to authenticate`;
  }
  return { text, message };
}

async function throwIfError(res: Response, hasToken: boolean): Promise<void> {
  if (res.status >= 200 && res.status < 300) return;
  const { text, message } = await describeErrorBody(res, hasToken);
  throw new ForgejoHttpError(res.status, text, message);
}

export function createForgejoHttp(apiUrl: string, deps: ForgejoHttpDeps = {}): ForgejoHttp {
  const apiBase = normalizeApiBase(apiUrl);
  const apiOrigin = new URL(apiBase).origin;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  function currentToken(): string | null {
    // An empty (or whitespace-only) string is treated the same as absent: `export CEZ_FORGEJO_TOKEN=`
    // in a shell script sets the variable to `''`, not unset, and `doRequest` below already gates the
    // header on `token && …` (truthy) — but `hasToken()` compared against `!== null` alone, so a blank
    // token reported `true` while no Authorization header was ever sent, mis-flagging a public repo's
    // anonymous request as `unauthorized` in `normalizeForgejoMergeState`'s eligibility ladder.
    const raw = deps.token !== undefined ? deps.token : (process.env.CEZ_FORGEJO_TOKEN ?? null);
    return raw && raw.trim() !== '' ? raw : null;
  }

  function hasToken(): boolean {
    return currentToken() !== null;
  }

  /** Every request funnels through here: same-origin auth gate, `redirect: 'manual'` (a 3xx is
   *  treated as a failure by the caller — no hop ever sees the Authorization header), and a hard
   *  abort so a hung Forgejo instance cannot wedge a driver call forever. */
  async function doRequest(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const target = resolveTarget(apiBase, path);
    const headers = new Headers(opts.headers);
    const token = currentToken();
    if (token && target.origin === apiOrigin) {
      headers.set('Authorization', `token ${token}`);
    }
    return fetchImpl(target, {
      method,
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? FJ_TIMEOUT_MS),
    });
  }

  async function getJson(path: string, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const res = await doRequest('GET', path, { headers: { Accept: 'application/json' }, timeoutMs: opts.timeoutMs });
    await throwIfError(res, hasToken());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function getText(path: string, opts: { accept?: string; timeoutMs?: number } = {}): Promise<string> {
    const headers: Record<string, string> = opts.accept ? { Accept: opts.accept } : {};
    const res = await doRequest('GET', path, { headers, timeoutMs: opts.timeoutMs });
    await throwIfError(res, hasToken());
    return res.text();
  }

  async function send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown | null; text: string }> {
    const res = await doRequest(method, path, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
    });
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  async function fetchPageRows(path: string): Promise<{ rows: unknown[]; total: number | null }> {
    const res = await doRequest('GET', path, { headers: { Accept: 'application/json' } });
    await throwIfError(res, hasToken());
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : [];
    if (!Array.isArray(parsed)) {
      throw new ForgejoHttpError(res.status, text, `Expected an array response from ${path}`);
    }
    return { rows: parsed, total: readTotalCount(res.headers) };
  }

  /** Hand-rolled bounded walk — mirrors `fetchTimelinePages` (github.ts:874-915) but reads
   *  `X-Total-Count` as its primary stop signal (the timeline walk has no such header). `pageSize`
   *  is measured from the FIRST page's actual row count, never assumed from `pageLimit`: the live
   *  instance silently caps `?limit=1000` to 50, so multiplying by the requested limit instead of
   *  the delivered one would misjudge "page * pageSize >= total" after page 1. Because `pageSize`
   *  is only known once page 1 has answered, the short-page check is compared against it starting
   *  from that same page — on page 1 the comparison is against itself and never fires, which is
   *  correct: a first page at the server's cap must not be mistaken for a short/final page. */
  async function paginate(
    pageUrlFn: (page: number, limit: number) => string,
    opts: { want: number; pageLimit?: number; maxPages?: number; budgetMs?: number; minPageMs?: number },
  ): Promise<ForgejoPage> {
    const pageLimit = opts.pageLimit ?? FJ_PAGE_LIMIT;
    const maxPages = opts.maxPages ?? FJ_LIST_MAX_PAGES;
    const budgetMs = opts.budgetMs ?? FJ_WALK_BUDGET_MS;
    const minPageMs = opts.minPageMs ?? FJ_MIN_PAGE_MS;
    const want = opts.want;

    const deadline = now() + budgetMs;
    const rows: unknown[] = [];
    let stoppedShort = false;
    let stopReason: ForgejoPage['stopReason'];
    let pageSize: number | null = null;
    let page = 1;

    for (; page <= maxPages; page++) {
      const remaining = deadline - now();
      // Never start a page that cannot finish — a bare `remaining <= 0` guard only catches the
      // exact boundary; the realistic case is a few hundred ms left, which starts a request that
      // cannot complete and looks indistinguishable from a real endpoint failure.
      if (remaining < minPageMs) {
        stoppedShort = true;
        stopReason = 'budget';
        break;
      }

      let pageRows: unknown[];
      let total: number | null;
      try {
        const fetched = await fetchPageRows(pageUrlFn(page, pageLimit));
        pageRows = fetched.rows;
        total = fetched.total;
      } catch (err) {
        // Page 1 rethrows: nothing was collected, so there is nothing this loop can salvage — the
        // caller decides whether a fallback helps. A later page keeps the rows already in hand
        // instead (documented choice — mirrors fetchTimelinePages' page===1 split, github.ts:874-915).
        if (page === 1) throw err;
        stoppedShort = true;
        stopReason = 'error';
        break;
      }

      rows.push(...pageRows);
      if (pageSize === null) pageSize = pageRows.length;

      // An EMPTY page is always a natural end, checked before the `pageRows.length < pageSize`
      // comparison below: when the first page itself comes back empty, `pageSize` is 0 too (just
      // set above), so `0 < 0` is false and would otherwise walk every remaining page for nothing,
      // reporting a fake `stoppedShort:true` that callers use as a completeness gate (e.g.
      // `prStatus`'s fallback).
      const atNaturalEnd = pageRows.length === 0 || pageRows.length < pageSize || (total !== null && page * pageSize >= total);
      if (atNaturalEnd) {
        stoppedShort = false;
        stopReason = undefined;
        break;
      }
      if (rows.length >= want) {
        stoppedShort = true;
        stopReason = 'limit';
        break;
      }
    }
    if (page > maxPages) {
      stoppedShort = true; // fell out on the page cap
      stopReason = 'limit'; // same deterministic-ceiling category as the in-loop `want` cutoff above
    }

    return { rows, stoppedShort, ...(stopReason ? { stopReason } : {}) };
  }

  return { apiBase, hasToken, getJson, getText, send, paginate };
}
