import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForgejoDriver } from './forgejo.ts';
import { createForgejoHttp } from './forgejo-http.ts';
import { ensureForgejoLabels } from './forgejo-labels.ts';
import { PIPELINE_LABEL_TAXONOMY } from './label-taxonomy.ts';
import type { ForgeLabelSpec, ForgeSettings } from './types.ts';

/**
 * The hermetic tier for Forgejo label provisioning (#47).
 *
 * Assertions are on what was **sent** — method, path, body — never on a return value alone. An
 * `ok: true` cannot distinguish a write that landed from one that was never attempted, and #16's
 * defects hid in exactly that gap. Every case below therefore reads `requests`, the recorded
 * request log, and several of them assert on requests that must NOT exist.
 *
 * Four live-measured Forgejo behaviours drive the design; each has its own case here:
 *
 *  1. `POST …/labels` with an existing name answers **201** and creates a SECOND label. There is no
 *     `422 already_exists` net (GitHub's, which `labels-sync.sh:195-203` leans on), so a complete
 *     read is the only thing standing between a re-run and a duplicated taxonomy.
 *  2. Names are **case-sensitive**: `Bug` and `bug` coexist. Treated as distinct, deliberately —
 *     the `case:` / `mismatched` branch of `labels-sync.sh` has no analogue here.
 *  3. Paging cuts at `default_paging_num: 30` / `max_response_items: 50`. A provisioned repo with a
 *     backlog taxonomy of its own holds 40, so an unpaged read sees 30 and (1) then duplicates ten.
 *  4. Colour is returned **without** a leading `#`.
 */

interface FjLabel {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/** The 13 labels `ajr/orakton` actually carries (read live, 2026-08-26). The real shape of the
 *  "repository with a backlog taxonomy of its own" case: it intersects the pipeline taxonomy in
 *  ZERO places, exactly and case-insensitively, so anything this provisioning touches of theirs is
 *  a bug the fixture can see. */
const ORAKTON_LABELS = [
  'agent/aldric',
  'epic/E1-dane',
  'epic/E2-portfel',
  'epic/E3-analityka',
  'epic/E4-backtester',
  'epic/E5-informacje',
  'epic/E6-alerty',
  'epic/infra',
  'priority/p1',
  'priority/p2',
  'priority/p3',
  'type/feature',
  'type/spike',
];

function asLabels(names: string[], start = 1): FjLabel[] {
  return names.map((name, index) => ({ id: start + index, name, color: 'ededed', description: 'theirs' }));
}

/** Every taxonomy entry as the server would answer it back — the "already provisioned" state. */
function provisioned(): FjLabel[] {
  return PIPELINE_LABEL_TAXONOMY.map((label, index) => ({
    id: 100 + index,
    name: label.name,
    color: label.color,
    description: label.description,
  }));
}

/**
 * A Forgejo label endpoint that pages the way the live instance does: it serves at most `pageSize`
 * rows whatever `limit` asked for, and (by default) answers `X-Total-Count`. `POST` always
 * succeeds with 201 — modelling behaviour 1, so a test that expects idempotence has to earn it by
 * not sending the request at all.
 */
function labelServer(
  existing: FjLabel[],
  opts: { pageSize?: number; totalHeader?: boolean; failPage?: number } = {},
): { fetchMock: ReturnType<typeof vi.fn>; requests: Recorded[] } {
  const pageSize = opts.pageSize ?? 50;
  const totalHeader = opts.totalHeader ?? true;
  const requests: Recorded[] = [];
  let nextId = 900;

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ method, url, body });

    if (method === 'POST') {
      const payload = body as { name: string; color: string; description: string };
      existing.push({ id: nextId++, ...payload });
      return new Response(JSON.stringify({ id: nextId, ...payload }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }

    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    if (opts.failPage === page) {
      return new Response('{"message":"internal"}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
    const rows = existing.slice((page - 1) * pageSize, page * pageSize);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(totalHeader ? { 'x-total-count': String(existing.length) } : {}),
      },
    });
  });

  return { fetchMock, requests };
}

function httpFor(fetchMock: ReturnType<typeof vi.fn>) {
  return createForgejoHttp('http://q7010-dev:8929', { fetch: fetchMock as unknown as typeof fetch, token: 'tok' });
}

const TARGET = { owner: 'ajr', repo: 'cezar-qa' };

function run(fetchMock: ReturnType<typeof vi.fn>, opts?: { checkOnly?: boolean; taxonomy?: readonly ForgeLabelSpec[] }) {
  return ensureForgejoLabels(httpFor(fetchMock), TARGET, opts?.taxonomy ?? PIPELINE_LABEL_TAXONOMY, {
    ...(opts?.checkOnly !== undefined ? { checkOnly: opts.checkOnly } : {}),
  });
}

const posts = (requests: Recorded[]) => requests.filter((r) => r.method === 'POST');
const gets = (requests: Recorded[]) => requests.filter((r) => r.method === 'GET');

describe('ensureForgejoLabels provisions a repository that has none of them', () => {
  it('creates all 27 with the taxonomy`s own colours and descriptions', async () => {
    const { fetchMock, requests } = labelServer([]);
    const result = await run(fetchMock);

    expect(result).toMatchObject({ ok: true, target: 'ajr/cezar-qa', complete: true, checkOnly: false });
    expect(result.ok && result.created).toEqual(PIPELINE_LABEL_TAXONOMY.map((label) => label.name));
    expect(result.ok && result.missing).toEqual([]);

    const sent = posts(requests);
    expect(sent).toHaveLength(27);
    expect(sent.map((r) => r.body)).toEqual(
      PIPELINE_LABEL_TAXONOMY.map((label) => ({
        name: label.name,
        color: label.color,
        description: label.description,
      })),
    );
    for (const request of sent) {
      expect(request.url).toBe('http://q7010-dev:8929/api/v1/repos/ajr/cezar-qa/labels');
    }
  });

  it('reads the listing through a paged URL, not a bare one', async () => {
    // Behaviour 3: an unparameterised GET answers 30 rows whatever the repository holds. The page
    // and limit params are the difference between a complete read and a plausible one.
    const { fetchMock, requests } = labelServer([]);
    await run(fetchMock);
    expect(gets(requests)[0]!.url).toBe('http://q7010-dev:8929/api/v1/repos/ajr/cezar-qa/labels?page=1&limit=50');
  });
});

describe('ensureForgejoLabels is idempotent against Forgejo`s actual semantics', () => {
  it('creates nothing on a second pass over a 40-label repository served 30 rows to a page', async () => {
    // The case that makes paging mandatory rather than an optimisation: 27 + 13 = 40 labels behind
    // a 30-row page. An implementation reading one page sees 30 of them and re-creates the other
    // ten — and because a duplicate POST answers 201 (behaviour 1), nothing downstream would notice.
    const { fetchMock, requests } = labelServer([...provisioned(), ...asLabels(ORAKTON_LABELS)], { pageSize: 30 });
    const result = await run(fetchMock);

    expect(posts(requests)).toEqual([]);
    expect(result).toMatchObject({ ok: true, complete: true });
    expect(result.ok && result.present).toEqual(PIPELINE_LABEL_TAXONOMY.map((label) => label.name));
    expect(gets(requests).map((r) => r.url)).toEqual([
      'http://q7010-dev:8929/api/v1/repos/ajr/cezar-qa/labels?page=1&limit=50',
      'http://q7010-dev:8929/api/v1/repos/ajr/cezar-qa/labels?page=2&limit=50',
    ]);
  });

  it('a real first pass followed by a real second pass converges to 27 labels and no writes', async () => {
    // End to end against ONE mutable server, rather than two hand-built fixtures: the second pass
    // reads back exactly what the first pass wrote, so a colour the writer and the reader spell
    // differently shows up here as ten re-creations instead of passing two separate fixtures.
    const store: FjLabel[] = [];
    const first = labelServer(store);
    await run(first.fetchMock);
    expect(posts(first.requests)).toHaveLength(27);

    const second = labelServer(store);
    const result = await run(second.fetchMock);
    expect(posts(second.requests)).toEqual([]);
    expect(result).toMatchObject({ ok: true, complete: true });
    expect(store).toHaveLength(27);
  });
});

describe('ensureForgejoLabels never deletes, renames or recolours', () => {
  it('leaves a repository`s own backlog taxonomy untouched', async () => {
    const { fetchMock, requests } = labelServer(asLabels(ORAKTON_LABELS));
    const result = await run(fetchMock);

    expect(result).toMatchObject({ ok: true, complete: true });
    const names = posts(requests).map((r) => (r.body as { name: string }).name);
    expect(names).toEqual(PIPELINE_LABEL_TAXONOMY.map((label) => label.name));
    // Their 13 appear in no request body and in no path — `epic/*`, `type/*` and `agent/aldric`
    // are that project's backlog, and a sync that pruned unknown labels would eat them.
    for (const theirs of ORAKTON_LABELS) {
      expect(requests.some((r) => JSON.stringify(r.body ?? '').includes(theirs) || r.url.includes(theirs))).toBe(false);
    }
  });

  it('leaves a same-name label with a different colour and description alone, and reports it', async () => {
    const drifted: FjLabel[] = [{ id: 7, name: 'review', color: 'ff0000', description: 'hand-edited' }];
    const { fetchMock, requests } = labelServer(drifted);
    const result = await run(fetchMock);

    // Both halves of the assertion the issue asks for: no repair was attempted, AND the name is
    // reported rather than swallowed into "already present".
    expect(requests.filter((r) => r.method === 'PATCH' || r.method === 'DELETE' || r.method === 'PUT')).toEqual([]);
    expect(posts(requests).map((r) => (r.body as { name: string }).name)).not.toContain('review');
    expect(result.ok && result.drifted).toEqual([
      {
        name: 'review',
        color: 'ff0000',
        description: 'hand-edited',
        wantColor: '0366d6',
        wantDescription: 'Ready for code review',
      },
    ]);
    // Drift is not incompleteness: the label exists, so the pipeline can address it.
    expect(result).toMatchObject({ ok: true, complete: true });
    expect(result.ok && result.present).not.toContain('review');
  });
});

describe('ensureForgejoLabels treats names case-sensitively', () => {
  it('creates `bug` on a repository that already carries `Bug`', async () => {
    // Behaviour 2, and the deliberate divergence from the GitHub path: there, `Bug` blocks `bug`
    // (label names are case-insensitively unique) and `labels-sync.sh` fails loudly asking for a
    // human rename. Here the two coexist as separate labels, so the taxonomy's own spelling is
    // simply created and the repository keeps theirs.
    const { fetchMock, requests } = labelServer([{ id: 3, name: 'Bug', color: 'd73a4a', description: 'Theirs' }]);
    const result = await run(fetchMock);

    expect(posts(requests).map((r) => (r.body as { name: string }).name)).toContain('bug');
    expect(result.ok && result.created).toContain('bug');
    expect(result.ok && result.drifted).toEqual([]);
    expect(result.ok && result.present).toEqual([]);
  });
});

describe('ensureForgejoLabels in check-only mode', () => {
  it('creates nothing and names what is missing', async () => {
    const { fetchMock, requests } = labelServer(asLabels(['review', 'in-progress'], 50));
    const result = await run(fetchMock, { checkOnly: true });

    expect(posts(requests)).toEqual([]);
    // `complete` is the exit-code equivalent: `labels-sync.sh --check` exits 1 on an incomplete
    // repository, and an HTTP action has no exit code to carry that with.
    expect(result).toMatchObject({ ok: true, checkOnly: true, complete: false });
    expect(result.ok && result.missing).toHaveLength(25);
    expect(result.ok && result.missing).toContain('qa-approved');
    expect(result.ok && result.missing).not.toContain('review');
    expect(result.ok && result.created).toEqual([]);
  });

  it('is complete on a fully provisioned repository', async () => {
    const { fetchMock, requests } = labelServer(provisioned());
    const result = await run(fetchMock, { checkOnly: true });
    expect(posts(requests)).toEqual([]);
    expect(result).toMatchObject({ ok: true, checkOnly: true, complete: true });
  });
});

describe('ensureForgejoLabels refuses to write behind an incomplete listing', () => {
  it('fails without sending a single POST when the walk stops short', async () => {
    // A truncated listing is indistinguishable from a short one by row count alone, and guessing
    // wrong duplicates every label the reader never saw. `labels-sync.sh:138-141` refuses on the
    // same reasoning ("a failed listing is indistinguishable from an empty one"); the Forgejo path
    // inherits it, and has more to lose because its POST has no already_exists net.
    const { fetchMock, requests } = labelServer(asLabels(ORAKTON_LABELS.concat(ORAKTON_LABELS.map((n) => `${n}-2`))), {
      pageSize: 13,
      totalHeader: false,
      failPage: 2,
    });
    const result = await run(fetchMock);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/listing/i);
    expect(posts(requests)).toEqual([]);
  });

  it('fails without writing when the very first page errors', async () => {
    const { fetchMock, requests } = labelServer([], { failPage: 1 });
    const result = await run(fetchMock);
    expect(result.ok).toBe(false);
    expect(posts(requests)).toEqual([]);
  });
});

describe('the Forgejo driver exposes ensureLabels behind an explicit-target guard', () => {
  const settings: ForgeSettings = {
    kind: 'forgejo',
    apiUrl: 'http://q7010-dev:8929',
    webUrl: 'http://q7010-dev:8929',
  };

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  function driver(fetchMock: ReturnType<typeof vi.fn>) {
    return createForgejoDriver(
      { repoRoot: '/repo/labels', owner: 'ajr', repo: 'cezar-qa', settings },
      { fetch: fetchMock as unknown as typeof fetch, token: 'tok' },
    );
  }

  it('provisions when the caller names the target the driver resolved', async () => {
    const { fetchMock, requests } = labelServer([]);
    const result = await driver(fetchMock).ensureLabels!({ target: 'ajr/cezar-qa' });
    expect(result).toMatchObject({ ok: true, target: 'ajr/cezar-qa', complete: true, dryRun: false });
    expect(posts(requests)).toHaveLength(27);
  });

  it('refuses, without writing, when the named target is not the one it resolved', async () => {
    // The #16 guard's second half. #16 closed two ways of aiming a taxonomy at the wrong
    // repository (an ambient cwd, and `gh`'s preference for an `upstream` remote) by naming the
    // target explicitly. An explicit target that nobody CHECKS is decoration, so a mismatch is a
    // refusal — a stale cockpit tab or a switched project must not write somewhere else.
    const { fetchMock, requests } = labelServer([]);
    const result = await driver(fetchMock).ensureLabels!({ target: 'ajr/orakton' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('ajr/orakton');
    expect(!result.ok && result.error).toContain('ajr/cezar-qa');
    expect(requests).toEqual([]);
  });

  it('touches no network at all under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const { fetchMock, requests } = labelServer([]);
    const result = await driver(fetchMock).ensureLabels!({ target: 'ajr/cezar-qa' });
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: true, dryRun: true, checkOnly: true, complete: true });
    expect(result.ok && result.created).toEqual([]);
  });
});
