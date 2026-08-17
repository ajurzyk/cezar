import type { RepoInfo } from '../git.ts';
import { createForgejoDriver } from './forgejo.ts';
import { createGithubDriver } from './github.ts';
import type { ForgeDriver, ForgeKind, ForgeSettings } from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver — recognized either from the host table
 * (github.com → GitHub) or from a repo's own `.ai/cezar/config.json` `forge`
 * key (self-hosted forges the host table can't reveal); the table wins where
 * it has an answer, so the config fills its gap and never overrides it.
 * Anything else (GitLab, self-hosted with no config, no remote,
 * not a repo) → null. The health route serializes the result as
 * `forge: {kind, available, reason?} | null`; a null forge means plain-git
 * features only (diffs, commit, push, branches).
 */

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into host/owner/repo. Handles the scheme forms
 * (`https://`, `ssh://`, `git://`, with optional credentials and port) and the
 * scp-like form (`git@host:owner/repo.git`). Null for local paths and anything
 * else that doesn't look like a forge remote.
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string | undefined;
  let path: string | undefined;
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (url) {
    [, host, path] = url;
  } else {
    // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path)
    // can't match the host group, so plain directories fall through to null.
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (!host || !path) return null;
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { host: host.toLowerCase(), owner, repo };
}

/** Remote host → forge kind. The one host table both `resolveForge` and the
 *  registry probe read; GitLab lands here later as one more row. A `Map`, not an object
 *  literal: `FORGE_HOSTS[host]` with a host of `__proto__` or `constructor` returns an
 *  INHERITED `Object.prototype` member — truthy, non-nullish, and passed straight through
 *  `??` as if it were a ForgeKind. A Map has no prototype chain to walk into. */
const FORGE_HOSTS = new Map<string, ForgeKind>([['github.com', 'github']]);

/**
 * The one precedence rule both `forgeKindOfRemote` and `resolveForge` must apply identically.
 *
 * The host table answers FIRST and the repo config only fills the gap it leaves. The config is
 * the only way to name a forge on a host the table cannot reveal, but it must never be able to
 * take away a driver the table would have given: `github.com` paired with `kind: 'forgejo'`
 * keeps the working GitHub driver rather than trading it for the `null` a missing Forgejo
 * driver returns.
 *
 * `kind: 'github'` from a config is inert on purpose. The GitHub driver is hardwired to
 * github.com — it shells out to `gh` with no `--hostname`, and `viewUrl` builds a
 * `https://github.com/` base — so honouring the declaration on a self-hosted host would aim
 * `repos/<owner>/<repo>`, parsed from the SELF-HOSTED remote, at a same-named github.com
 * repository, up to and including `gh api --method PUT …/merge`. On github.com the table has
 * already answered, so the declaration has nothing to add there either. When the driver grows a
 * host parameter, this guard is what to revisit.
 *
 * Pulled into its own function rather than left as a repeated expression so the "probe and
 * resolver must agree" invariant is enforced by a shared call site, not just asserted in a comment.
 */
function classifyForgeKind(host: string, forge?: ForgeSettings): ForgeKind | null {
  const known = FORGE_HOSTS.get(host);
  if (known) return known;
  if (forge?.kind === 'github') return null;
  return forge?.kind ?? null;
}

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * plain string parsing, no `gh` shell-out — so the sidebar can gate each
 * project's GitHub tab on the project's own remote. `forge`, when given, is
 * the repo's own `.ai/cezar/config.json` declaration; it fills the gap the
 * host table leaves (the only way to name a self-hosted forge) and never wins
 * over a host the table already recognizes — see `classifyForgeKind`.
 *
 * A remote that doesn't parse to `{host, owner, repo}` stays `null` even with
 * a config present: `parseRemote` is the only source of `owner`/`repo`, so
 * `resolveForge` could never build a driver for it anyway — this probe must
 * not claim a forge exists that the resolver can't act on.
 */
export function forgeKindOfRemote(remote: string | undefined, forge?: ForgeSettings): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  return classifyForgeKind(parsed.host, forge);
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null when neither the host table nor
 * the repo's own config can name one.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, owner, repo}` leaves nothing to leak.
 * That holds on BOTH branches below — only the base differs, never where `owner`/`repo` come from.
 *
 * `forge`, when given, is the repo's own `.ai/cezar/config.json` declaration, and it follows the
 * same precedence rule `forgeKindOfRemote` applies (see `classifyForgeKind`): the host table
 * answers first and the config only fills the gap it leaves, so a `github.com` remote paired with
 * `kind: 'forgejo'` still yields the github.com root. `forgeSettingsSchema` has already pinned
 * `webUrl` to `http`/`https`, so the composed root cannot carry a scheme no consumer expected.
 *
 * What this does NOT do is verify that the declared `webUrl` and the remote's host describe the
 * same instance — `classifyForgeKind` answers `forgejo` for ANY host the table cannot name once the
 * config declares one, so a repo whose remote points elsewhere gets a link into the configured
 * instance. That is the trust `resolveForge` already extends to the same config value; the only
 * thing new here is that such a mistake becomes a visibly wrong link rather than a failing API
 * call. Config-declared, hand-edited, code-trusted — stated so a future "why does this row link to
 * the wrong server" starts here.
 */
export function forgeWebRoot(remote: string | undefined, forge?: ForgeSettings): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  // `parseRemote` is the only source of `owner`/`repo`, so an unparseable remote has no root to
  // compose even with a config present — same reason `forgeKindOfRemote` stays null for one.
  if (!parsed) return null;
  // `FORGE_HOSTS.has(...)`, not `host in FORGE_HOSTS`: the table is a Map (see its comment), and
  // `in` against a Map asks about the Map's OWN properties — never its entries — so every host
  // would answer "unknown" and this would return null for github.com too.
  //
  // The table's own answer is returned unencoded, exactly as before: this value is the one the
  // cockpit has always rendered for a GitHub project and it stays byte-identical.
  if (FORGE_HOSTS.has(parsed.host)) return `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
  // Not `forge?.webUrl` directly: routing through `classifyForgeKind` is what keeps the probe, the
  // resolver and this function on ONE precedence rule, and it is also what refuses a self-hosted
  // `kind: 'github'` here for the same reason it refuses one there.
  if (!forge || classifyForgeKind(parsed.host, forge) === null) return null;
  // Encoded per segment exactly as `forgejoViewUrl` encodes the same pair — `parseRemote` only
  // checks `owner`/`repo` for non-emptiness, so this is what keeps a DELIMITER inside a segment from
  // reshaping a URL the cockpit renders and links: `encodeURIComponent('a?b#c')` → `'a%3Fb%23c'`,
  // `encodeURIComponent('a%2Fb')` → `'a%252Fb'` (both run in node, not assumed).
  //
  // It does NOT neutralize a `..` segment: dots are unreserved, so `encodeURIComponent('..')` is
  // `'..'` verbatim. That is accepted rather than overlooked — a remote of `host/../repo` composes
  // `webUrl/../repo`, which resolves to a sibling path on the SAME configured host, so the worst
  // case is a wrong link inside the instance the config already points at, never another origin.
  //
  // `webUrl`'s trailing slashes are trimmed because nothing else trims them (`apiUrl` is trimmed on
  // its way into `ForgejoHttp`; `webUrl` is trimmed nowhere — `forgejoViewUrl` still composes
  // `${webUrl}/${owner}/${repo}` raw), so a config ending in '/' would otherwise render
  // `https://host//owner/repo`.
  const base = forge.webUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
}

/** Remote host (or, for a host the table can't reveal, a repo-config `ForgeSettings`) → driver |
 *  null. GitLab lands here later as one more host-table case. */
export function resolveForge(repoInfo: RepoInfo | null, forge?: ForgeSettings): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  const kind = classifyForgeKind(parsed.host, forge);
  if (kind === 'github') {
    // Reachable only from the host table — `classifyForgeKind` never answers 'github' for a repo
    // config — so `parsed.host` is github.com here and the driver's hardwired base is correct.
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo });
  }
  if (kind === 'forgejo') {
    // Guard is defensive, not load-bearing: `classifyForgeKind` only ever returns 'forgejo' when a
    // repo-config `forge` was supplied (the host table has no forgejo entries), so `forge` is
    // always defined on this branch — the `? :` just keeps the compiler's flow analysis honest.
    return forge
      ? createForgejoDriver({ repoRoot: repoInfo.root, owner: parsed.owner, repo: parsed.repo, settings: forge })
      : null;
  }
  return null;
}

/** The `/api/v1/github*` route family answered via `gh` for EVERY repo before this seam existed:
 *  no remote, a remote outside the host table, and `CEZ_DRY_RUN` all landed in `fetchGithub*`'s own
 *  degrade paths/mocks. So this family's routes get a fallback to the GitHub driver (`repoRef null`)
 *  instead of gating on `null` — that keeps those payloads byte-for-byte unchanged. Scoped to this
 *  route family only; health, automations and `createPR` keep calling `resolveForge` directly. */
export function resolveForgeOrGithub(repoRoot: string, repoInfo: RepoInfo | null, forge?: ForgeSettings): ForgeDriver {
  return resolveForge(repoInfo, forge) ?? createGithubDriver(repoRoot, null);
}

export type {
  ForgeDriver,
  ForgeAvailability,
  ForgeItem,
  ForgeKind,
  ForgePrStatus,
  ForgeRefKind,
  ForgeSettings,
} from './types.ts';
