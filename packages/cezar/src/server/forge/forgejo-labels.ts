import { FJ_PAGE_LIMIT, firstLine, messageFromBody } from './forgejo-http.ts';
import type { ForgejoHttp } from './forgejo-http.ts';
import type { ForgeEnsureLabelsResult, ForgeLabelDrift, ForgeLabelSpec } from './types.ts';

/**
 * Forgejo label provisioning (#47) — put the pipeline taxonomy in place so the `om-*` claim/lock
 * protocol and the review signalling have labels to signal ON. Without them every `apply_label`
 * degrades to a logged skip and the protocol stops working while each step still reports success.
 *
 * Create-only, always. Nothing here issues `DELETE` or `PATCH`, and that promise is inherited from
 * `labels-sync.sh:16` rather than invented: a sync that pruned unknown labels would eat a
 * project's own backlog taxonomy (`epic/*`, `type/*`, `agent/aldric` on `ajr/orakton`).
 *
 * THREE MEASURED FORGEJO BEHAVIOURS SHAPE THIS FILE. All read live against
 * http://q7010-dev:8929 on 2026-08-26, not carried over from the GitHub path:
 *
 *  1. `POST /repos/{o}/{r}/labels` with a name that already exists answers **201** and creates a
 *     SECOND label with a new id. There is no `422 already_exists` — the safety net
 *     `labels-sync.sh:195-203` leans on, which lets the GitHub script treat a lost race as
 *     "already present". Here the read is the ONLY protection against duplication, which is why an
 *     incomplete listing is a hard refusal below and not a best-effort continue.
 *  2. Label names are **case-sensitive**: `Bug` and `bug` coexist as separate labels. So the
 *     `case:` / `mismatched` branch of `labels-sync.sh` has no analogue and is deliberately not
 *     ported — a repository carrying `Bug` simply keeps it and gets `bug` alongside. On GitHub that
 *     same state is unrepairable drift the script fails loudly over, because label uniqueness there
 *     is case-INSENSITIVE.
 *  3. **Paging engages only once `page` is sent, and then `limit` is capped at 50.** Measured on a
 *     repository holding 58 labels — the numbers below are row counts from that one repo, so they
 *     are directly comparable:
 *
 *         GET .../labels                  -> 58 rows   (X-Total-Count: 58)
 *         GET .../labels?limit=50         -> 58 rows   <- `limit` ALONE is ignored
 *         GET .../labels?page=1           -> 30 rows   <- default_paging_num
 *         GET .../labels?page=1&limit=50  -> 50 rows   <- max_response_items caps `limit`
 *
 *     So the hazard is not that an unparameterised read truncates — it does not. It is that
 *     `ForgejoHttp.paginate` ALWAYS sends `page`, which puts this transport unconditionally in the
 *     paging regime: a reader that took page 1 and stopped would see 50 of 58 and, with (1),
 *     duplicate the other eight on the next pass. Walking the pages is therefore mandatory here
 *     even though a hand-rolled `curl` would have got away without it — and relying on the
 *     unparameterised form instead would mean asking an unbounded endpoint for everything, which
 *     is exactly what `paginate`'s budget and page cap exist to refuse.
 *
 * Colour is accepted with or without a leading `#` and always returned without one, so the
 * `#`-less spelling in `label-taxonomy.ts` compares by plain string equality. `exclusive` and
 * `is_archived` (which GitHub has no equivalent of) stay at their `false` defaults and are not
 * part of this contract.
 */

/** 1000 labels at 50 to a page. A repository past that is not a taxonomy problem. */
const LABEL_MAX_PAGES = 20;

export interface ForgejoLabelTarget {
  owner: string;
  repo: string;
}

/** As Forgejo answers a label. `exclusive`/`is_archived`/`url` are present on the wire and
 *  deliberately unread — see the module comment. */
interface ForgejoLabelRow {
  name?: unknown;
  color?: unknown;
  description?: unknown;
}

function labelsPath(target: ForgejoLabelTarget): string {
  return `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/labels`;
}

/** Defensive rather than cosmetic: a row without a string `name` cannot be matched against, and
 *  silently treating it as "not present" would POST a duplicate of a label that already exists. */
function readRow(row: unknown): { name: string; color: string; description: string } | null {
  if (!row || typeof row !== 'object') return null;
  const { name, color, description } = row as ForgejoLabelRow;
  if (typeof name !== 'string' || name === '') return null;
  return {
    name,
    // Forgejo answers a `#`-less colour; a leading `#` is stripped anyway so a hand-set value
    // through the web UI compares the same way, and case is folded for the same reason.
    color: (typeof color === 'string' ? color : '').replace(/^#/, '').toLowerCase(),
    description: typeof description === 'string' ? description : '',
  };
}

/**
 * The full listing, or nothing. `ForgejoPage.stoppedShort` is the entire safety margin: it is true
 * whenever the walk hit its page cap, ran out of budget, or lost a later page to an error, and in
 * every one of those cases the rows in hand are indistinguishable BY COUNT from a complete read of
 * a smaller repository. Guessing wrong duplicates every label the walk never saw.
 *
 * `labels-sync.sh:138-141` refuses on the same reasoning ("a failed listing is indistinguishable
 * from an empty one"); this path has strictly more to lose, because its POST has no
 * `already_exists` net to fall back on.
 */
async function listAllLabels(
  http: ForgejoHttp,
  target: ForgejoLabelTarget,
): Promise<{ ok: true; rows: { name: string; color: string; description: string }[] } | { ok: false; error: string }> {
  const path = labelsPath(target);
  let page;
  try {
    page = await http.paginate((n, limit) => `${path}?page=${n}&limit=${limit}`, {
      // Full enumeration, so `want` must never be the thing that stops the walk — only a natural
      // end (a short page, or `X-Total-Count` satisfied) may. A finite `want` here would report
      // `stoppedShort: 'limit'` on a big repo and turn a correct read into a refusal.
      want: Number.MAX_SAFE_INTEGER,
      pageLimit: FJ_PAGE_LIMIT,
      maxPages: LABEL_MAX_PAGES,
    });
  } catch (err) {
    // Page 1 rethrows out of `paginate` (nothing was collected, so there is nothing to salvage).
    return { ok: false, error: `cannot list the labels of ${target.owner}/${target.repo}: ${describe(err)}` };
  }
  if (page.stoppedShort) {
    return {
      ok: false,
      error:
        `the label listing of ${target.owner}/${target.repo} stopped short (${page.stopReason ?? 'unknown'}) — ` +
        'refusing to create anything, because a truncated listing is indistinguishable from a complete one and ' +
        'Forgejo answers a duplicate POST with 201 rather than an already-exists error',
    };
  }
  const rows: { name: string; color: string; description: string }[] = [];
  for (const raw of page.rows) {
    const row = readRow(raw);
    if (row) rows.push(row);
  }
  return { ok: true, rows };
}

function describe(err: unknown): string {
  return err instanceof Error ? firstLine(err.message) : String(err);
}

/**
 * Ensure every label in `taxonomy` exists on `target`.
 *
 * Names are compared BYTE-EXACT, deliberately (behaviour 2 above, and the tracker's own
 * `label_exists` guard compares with `grep -Fxq`): a repository carrying `Bug` still gets `bug`,
 * because on Forgejo the two are different labels and only the exact spelling is addressable.
 */
export async function ensureForgejoLabels(
  http: ForgejoHttp,
  target: ForgejoLabelTarget,
  taxonomy: readonly ForgeLabelSpec[],
  opts: { checkOnly?: boolean } = {},
): Promise<ForgeEnsureLabelsResult> {
  const checkOnly = opts.checkOnly === true;
  const name = `${target.owner}/${target.repo}`;

  const listing = await listAllLabels(http, target);
  if (!listing.ok) return { ok: false, error: listing.error };

  // Last one wins is irrelevant — a duplicate NAME on the forge (possible, see behaviour 1) means
  // both are addressable by that name, so either row proves the label exists.
  const existing = new Map(listing.rows.map((row) => [row.name, row]));

  const created: string[] = [];
  const present: string[] = [];
  const missing: string[] = [];
  const drifted: ForgeLabelDrift[] = [];

  for (const label of taxonomy) {
    const have = existing.get(label.name);
    if (have) {
      if (have.color === label.color && have.description === label.description) {
        present.push(label.name);
      } else {
        // Left alone on purpose. Recolouring is a mutation of somebody's deliberate edit, and the
        // create-only promise is what makes this safe to point at a repository with a backlog of
        // its own. Reported so the drift is visible rather than swallowed into "already present".
        drifted.push({ ...have, wantColor: label.color, wantDescription: label.description });
      }
      continue;
    }
    if (checkOnly) {
      missing.push(label.name);
      continue;
    }
    const res = await http.send('POST', labelsPath(target), {
      name: label.name,
      color: label.color,
      description: label.description,
    });
    if (res.status < 200 || res.status >= 300) {
      // Loud and immediate. Continuing past a rejected write would leave a half-provisioned repo
      // reported as complete, which is the same silent-degradation shape #47 exists to end — and
      // unlike the GitHub script there is no already_exists case to forgive here, because a
      // duplicate name does not fail in the first place.
      const detail = messageFromBody(res.json, res.text) || `HTTP ${res.status}`;
      return { ok: false, error: `failed to create '${label.name}' in ${name}: ${detail}` };
    }
    created.push(label.name);
  }

  return {
    ok: true,
    target: name,
    checkOnly,
    dryRun: false,
    complete: missing.length === 0,
    created,
    present,
    missing,
    drifted,
  };
}
