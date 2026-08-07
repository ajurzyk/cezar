import type { RepoInfo } from '../git.ts';
import { createGithubDriver } from './github.ts';
import type { ForgeDriver, ForgeKind, ForgeSettings } from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver — recognized either from the host table
 * (github.com → GitHub) or from a repo's own `.ai/cezar/config.json` `forge`
 * key (self-hosted forges the host table can't reveal); the config wins when
 * both apply. Anything else (GitLab, self-hosted with no config, no remote,
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
 *  registry probe read; GitLab lands here later as one more row. */
const FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github' };

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * plain string parsing, no `gh` shell-out — so the sidebar can gate each
 * project's GitHub tab on the project's own remote. `forge`, when given, is
 * the repo's own `.ai/cezar/config.json` declaration and wins over the host
 * table (it is the only way to name a self-hosted forge).
 *
 * A remote that doesn't parse to `{host, owner, repo}` stays `null` even with
 * a config present: `parseRemote` is the only source of `owner`/`repo`, so
 * `resolveForge` could never build a driver for it anyway — this probe must
 * not claim a forge exists that the resolver can't act on.
 */
export function forgeKindOfRemote(remote: string | undefined, forge?: ForgeSettings): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  return forge?.kind ?? FORGE_HOSTS[parsed.host] ?? null;
}

/** Remote host (or a repo-config `ForgeSettings` override) → driver | null. GitLab lands here
 *  later as one more host-table case. */
export function resolveForge(repoInfo: RepoInfo | null, forge?: ForgeSettings): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  const kind = forge?.kind ?? FORGE_HOSTS[parsed.host] ?? null;
  if (kind === 'github') {
    // `apiUrl`/`webUrl` are unused for `kind: 'github'` here: the GitHub driver speaks through
    // `gh` and its `viewUrl` hardcodes the `https://github.com/` base (github.ts), so a repo
    // config declaring `kind: 'github'` on a self-hosted host still produces github.com links.
    // That is a driver limit, not this function's — parameterizing the driver's host is future
    // work, not this recognition step.
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo });
  }
  if (kind === 'forgejo') {
    // Recognition only: no Forgejo driver exists yet. `forge.apiUrl`/`forge.webUrl` are exactly
    // what a future driver would consume — deliberately unread here. No stub, no throw: a
    // consumer sees the same `null` it would for any other forge with no driver.
    return null;
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
