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

export type {
  ForgeDriver,
  ForgeAvailability,
  ForgeItem,
  ForgeKind,
  ForgePrStatus,
  ForgeRefKind,
  ForgeSettings,
} from './types.ts';
