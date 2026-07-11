import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConfig, type SkillsRepoSource } from './config.js';
import { parseFrontmatter, type Skill } from './skills.js';

/**
 * Team skills from remote git repos (spec 005), janitor-style: a bare clone
 * without a checkout, listed with `git ls-tree` and read with `git show`.
 * The cache lives in `~/.cache/cez/skills/<owner>__<name>/` — global, so one
 * fetch serves every project. Everything degrades: no network / no access to
 * the skills repo means the team skills quietly disappear from the list while
 * local skills keep working. Nothing here ever blocks startup.
 */

const LIST_TIMEOUT_MS = 10_000; // ls-tree / show / rev-parse
const CLONE_TIMEOUT_MS = 60_000; // clone / fetch

// ---- git plumbing ------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], timeoutMs: number, cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** `owner/name` shorthand → GitHub HTTPS; anything else (URL, file://, local path) as-is. */
function remoteFor(repo: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

/** Stable cache directory name: the last two path segments, `owner__name`. */
export function bareDirFor(repo: string): string {
  const trimmed = repo
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^~\//, '');
  const segments = trimmed.split(/[/:]/).filter(Boolean).map(sanitizeSegment);
  const key = segments.slice(-2).join('__') || 'skills';
  return join(homedir(), '.cache', 'cez', 'skills', key);
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, '-');
}

/** Clone the skills repo bare (no checkout) into the global cache, once. */
export async function ensureBareClone(repo: string): Promise<{ bareDir: string; created: boolean }> {
  const bareDir = bareDirFor(repo);
  if (existsSync(join(bareDir, 'HEAD'))) return { bareDir, created: false };
  await mkdir(dirname(bareDir), { recursive: true });
  const remote = remoteFor(repo);
  const res = await git(['clone', '--bare', remote, bareDir], CLONE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`git clone --bare ${remote} failed: ${res.stderr.trim()}`);
  return { bareDir, created: true };
}

/** "Refresh" — update every branch head in the bare clone from origin. */
export async function fetchAll(bareDir: string): Promise<void> {
  const res = await git(
    ['fetch', 'origin', '--prune', '+refs/heads/*:refs/heads/*'],
    CLONE_TIMEOUT_MS,
    bareDir,
  );
  if (!res.ok) throw new Error(`git fetch failed: ${res.stderr.trim() || res.stdout.trim()}`);
}

async function resolveRef(bareDir: string, ref: string): Promise<string> {
  for (const candidate of [ref, `refs/heads/${ref}`, 'HEAD']) {
    const probe = await git(['rev-parse', '--verify', '--quiet', candidate], LIST_TIMEOUT_MS, bareDir);
    if (probe.ok) return candidate;
  }
  return ref;
}

// ---- skill discovery (three conventions) --------------------------------------

interface SkillPathHit {
  /** null → the name comes from the file's frontmatter (markdown convention). */
  name: string | null;
  kind: 'skill' | 'command' | 'markdown';
}

/**
 * Match the janitor conventions plus our own:
 *  - `**\/SKILL.md`          → skill named after the parent directory (with references/)
 *  - `**\/commands/<n>.md`   → skill `<n>`
 *  - `.ai/skills/**\/*.md` or `.ai/cezar/skills/**\/*.md` → frontmatter/basename name
 */
function matchSkillPath(line: string): SkillPathHit | null {
  if (line === 'SKILL.md' || line.endsWith('/SKILL.md')) {
    const parts = line.split('/');
    if (parts.length < 2) return null;
    const parent = parts[parts.length - 2];
    return parent && parent !== '.' ? { name: parent, kind: 'skill' } : null;
  }
  const cmd = /(?:^|\/)commands\/([^/]+)\.md$/.exec(line);
  if (cmd) return { name: cmd[1] as string, kind: 'command' };
  if (/(?:^|\/)\.ai\/(?:cezar\/)?skills\/.+\.md$/.test(line)) return { name: null, kind: 'markdown' };
  return null;
}

/** Read one file from the bare clone at the source's ref. Null on any failure. */
export async function readRemoteSkill(src: SkillsRepoSource, path: string): Promise<string | null> {
  const bareDir = bareDirFor(src.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return null;
  const ref = await resolveRef(bareDir, src.ref);
  const res = await git(['show', `${ref}:${path}`], LIST_TIMEOUT_MS, bareDir);
  return res.ok ? res.stdout : null;
}

/**
 * List every skill the repo defines at `src.ref`. Reads from the local bare
 * clone only — no network. Empty list when the clone doesn't exist yet or
 * the ref can't be resolved.
 */
export async function listRemoteSkills(src: SkillsRepoSource): Promise<Skill[]> {
  const bareDir = bareDirFor(src.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return [];
  const ref = await resolveRef(bareDir, src.ref);
  const ls = await git(['ls-tree', '-r', '--name-only', ref], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return [];

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const line of ls.stdout.split('\n')) {
    if (!line) continue;
    const hit = matchSkillPath(line);
    if (!hit) continue;
    const raw = await readRemoteSkill(src, line);
    if (raw === null) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    const name =
      hit.name ??
      (typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(line, '.md'));
    if (seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    skills.push({
      name,
      description,
      body,
      path: `${src.repo}@${src.ref}:${line}`,
      source: 'team',
      team: { repo: src.repo, ref: src.ref, path: line, dir: hit.kind === 'skill' },
    });
  }
  return skills;
}

// ---- materialization (directory skills) ---------------------------------------

/**
 * Copy a directory skill (SKILL.md + references/…) out of the bare clone into
 * `<repoRoot>/.claude/skills/<name>/` so claude sees the references on disk,
 * and keep it out of the user's git via `.git/info/exclude`. Returns false
 * when there is nothing to materialize (not a directory skill, no clone…).
 */
export async function materializeSkillDir(repoRoot: string, skill: Skill): Promise<boolean> {
  if (!skill.team?.dir || !skill.team.path.endsWith('SKILL.md')) return false;
  const bareDir = bareDirFor(skill.team.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return false;
  const ref = await resolveRef(bareDir, skill.team.ref);
  const srcDir = skill.team.path.slice(0, -'/SKILL.md'.length);
  const ls = await git(['ls-tree', '-r', '--name-only', ref, '--', srcDir], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return false;

  const destDir = join(repoRoot, '.claude', 'skills', skill.name);
  let wrote = 0;
  for (const file of ls.stdout.split('\n').filter(Boolean)) {
    const rel = file.slice(srcDir.length + 1);
    // git paths are repo-relative and normalized, but never trust them blindly.
    if (!rel || rel.split('/').includes('..')) continue;
    const show = await git(['show', `${ref}:${file}`], LIST_TIMEOUT_MS, bareDir);
    if (!show.ok) continue;
    const target = join(destDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, show.stdout, 'utf8');
    wrote++;
  }
  if (wrote === 0) return false;
  await excludeFromGit(repoRoot, `.claude/skills/${skill.name}/`);
  return true;
}

/** Append a pattern to git's `info/exclude` (idempotent, non-fatal). */
async function excludeFromGit(repoRoot: string, pattern: string): Promise<void> {
  try {
    // Resolve the real exclude file: in a linked worktree (spec 006) `.git`
    // is a file and `info/exclude` lives in the shared common dir — which
    // also means one exclude entry covers every task worktree.
    const probe = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      LIST_TIMEOUT_MS,
      repoRoot,
    );
    const gitDir = probe.ok && probe.stdout.trim() ? probe.stdout.trim() : join(repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    let prev = '';
    try {
      prev = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (prev.split('\n').includes(pattern)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
  } catch {
    // non-fatal — `.git` might be a linked file (worktree) or absent entirely
  }
}

// ---- in-process cache ----------------------------------------------------------

// Clone attempts are expensive when the network is down (git can hang on
// DNS/TCP), so each source gets one implicit attempt per process. "Refresh"
// always retries.
const cloneAttempted = new Set<string>();
let teamSkills: Skill[] = [];
let firstLoadStarted = false;

/**
 * The current team-skill list, straight from memory. The first call kicks off
 * an async background load (clone + list) and returns immediately — the GUI
 * refetches, so remote skills appear moments later instead of blocking the
 * first `GET /api/skills`.
 */
export function getTeamSkillsCached(repoRoot: string): Skill[] {
  if (!firstLoadStarted) {
    firstLoadStarted = true;
    void loadTeamSkills(repoRoot, false).catch(() => undefined);
  }
  return teamSkills;
}

/** Refresh: clone missing sources, `git fetch` existing ones, reload the list. */
export async function refreshTeamSkills(repoRoot: string): Promise<Skill[]> {
  firstLoadStarted = true;
  return loadTeamSkills(repoRoot, true);
}

async function loadTeamSkills(repoRoot: string, refresh: boolean): Promise<Skill[]> {
  const config = await loadConfig(repoRoot);
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const src of config.skillsRepos) {
    try {
      if (refresh) {
        const { bareDir, created } = await ensureBareClone(src.repo);
        if (!created) await fetchAll(bareDir);
        cloneAttempted.add(src.repo);
      } else if (!cloneAttempted.has(src.repo)) {
        cloneAttempted.add(src.repo);
        await ensureBareClone(src.repo);
      }
    } catch {
      // offline / no access — list whatever an older clone has (or nothing)
    }
    try {
      for (const skill of await listRemoteSkills(src)) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        out.push(skill);
      }
    } catch {
      // degrade: this source contributes nothing
    }
  }
  teamSkills = out;
  return out;
}
