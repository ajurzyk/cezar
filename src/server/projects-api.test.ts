import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import {
  allocateProjectSlug,
  clearProjectProbeCache,
  registerProject,
} from '../workspace/projects.js';
import { mergeWriteWorkspaceConfig } from '../workspace/config.js';
import {
  WorkspaceEventBus,
  createApp,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
} from './server.js';

/**
 * Multi-project workspace API (spec 2026-07-20-multi-project-workspace, step
 * 1.6): the new `GET /api/projects` registry listing, and `/api/health`'s
 * additive `projects` + `bootProject` fields — with the #431 guarantee that
 * health (the one CORS-open route) never carries a project's absolute root.
 */

interface HealthBody {
  version: string;
  repoRoot: string;
  repo: unknown;
  checks: unknown[];
  defaultRunner?: string;
  forge: unknown;
  capabilities: { localHandoff: boolean; followups: boolean };
  projects: { id: string; name: string }[];
  bootProject: string;
}

describe('workspace projects API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-workspace-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-projects-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-projects-other-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FOLLOWUPS;
    // Deterministic on any machine: no network, no real agent CLIs.
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const getProjects = async (over: Partial<ServerDeps> = {}): Promise<ProjectsResponse> => {
    const res = await makeApp(over).request('/api/projects');
    expect(res.status).toBe(200);
    return (await res.json()) as ProjectsResponse;
  };

  const getHealth = async (over: Partial<ServerDeps> = {}): Promise<HealthBody> => {
    const res = await makeApp(over).request('/api/health');
    expect(res.status).toBe(200);
    return (await res.json()) as HealthBody;
  };

  describe('GET /api/projects', () => {
    it('answers an empty registry with projects:[] and defaults — never a 404', async () => {
      const body = await getProjects();
      expect(body.projects).toEqual([]);
      // Unregistered boot repo (e.g. worktree/$HOME/unreadable workspace):
      // bootProject degrades to the repo's would-be slug, not an error.
      expect(body.bootProject).toBe(allocateProjectSlug(repoRoot, []));
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('lists registered projects with root + status and derives bootProject from the registry', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getProjects(); // no bootProjectId — legacy caller path
      expect(body.projects).toHaveLength(2);
      const byId = new Map(body.projects.map((p) => [p.id, p]));
      // Plain temp dirs: exist but have no .git — the fully-usable degraded status.
      expect(byId.get(boot.id)).toMatchObject({
        id: boot.id,
        name: boot.name,
        root: boot.root,
        status: 'not-git',
        source: 'local',
      });
      expect(byId.get(boot.id)?.lastOpenedAt).toBe(boot.lastOpenedAt);
      expect(byId.get(other.id)).toMatchObject({ id: other.id, root: other.root, status: 'not-git' });
      // Derived lazily by realpath lookup — the boot repo, not the other one.
      expect(body.bootProject).toBe(boot.id);
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('reports a deleted root as missing', async () => {
      const other = await registerProject(otherRoot);
      rmSync(otherRoot, { recursive: true, force: true });
      clearProjectProbeCache(); // drop the TTL cache so the probe re-looks
      const body = await getProjects();
      expect(body.projects.find((p) => p.id === other.id)?.status).toBe('missing');
    });

    it('prefers the plumbed deps.bootProjectId over any lookup', async () => {
      await registerProject(repoRoot);
      const body = await getProjects({ bootProjectId: 'plumbed-boot' });
      expect(body.bootProject).toBe('plumbed-boot');
    });
  });

  describe('POST /api/projects — the folder-browser dialog (step 4.2)', () => {
    const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
      const res = await makeApp(over).request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as RegisterProjectResponse & { error?: string } };
    };

    it('registers a NON-GIT folder and answers the entry — the spec\'s "any folder works"', async () => {
      // A plain temp dir with no `.git`: selectable in the dialog, registerable
      // here, and `not-git` is the fully-usable degraded status (never a block).
      const { status, body } = await post({ root: otherRoot });
      expect(status).toBe(200);
      expect(body.project).toMatchObject({
        root: await realpath(otherRoot),
        status: 'not-git',
        source: 'local',
        name: basename(otherRoot),
      });
      expect(body.error).toBeUndefined();
      // The id is what the dialog navigates to (`/p/<id>/`), so it must be a
      // real slug AND resolvable through the list route immediately after.
      expect(body.project.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      const listed = await getProjects();
      expect(listed.projects.map((p) => p.id)).toContain(body.project.id);
    });

    it('registers a git repo as status ok and emits project-added once', async () => {
      mkdirSync(join(otherRoot, '.git'), { recursive: true });
      clearProjectProbeCache();
      const bus = new WorkspaceEventBus();
      const seen: { event: string; data: unknown }[] = [];
      bus.on((event, data) => seen.push({ event, data }));
      const { status, body } = await post({ root: otherRoot }, { workspaceEvents: bus });
      expect(status).toBe(200);
      expect(body.project.status).toBe('ok');
      expect(seen).toEqual([{ event: 'project-added', data: { project: body.project } }]);
    });

    it('re-registering answers 409 with the EXISTING entry and emits nothing', async () => {
      const first = await registerProject(otherRoot);
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      // A different spelling of the same folder — the registry dedupes by
      // realpath, so a trailing slash must not mint a second project.
      const { status, body } = await post({ root: `${otherRoot}/` }, { workspaceEvents: bus });
      expect(status).toBe(409);
      expect(body.project.id).toBe(first.id);
      expect(body.error).toContain(first.id);
      expect(seen).toEqual([]);
      expect((await getProjects()).projects).toHaveLength(1);
    });

    it('400s a non-absolute path, a missing folder, a file, and a malformed body', async () => {
      const file = join(otherRoot, 'not-a-dir.txt');
      writeFileSync(file, 'x', 'utf8');
      for (const root of ['relative/path', join(otherRoot, 'nope'), file]) {
        const { status, body } = await post({ root });
        expect(status, root).toBe(400);
        expect(typeof body.error).toBe('string');
      }
      expect((await post({})).status).toBe(400);
      expect((await post({ root: '   ' })).status).toBe(400);
      // No 400 path may have written anything.
      expect((await getProjects()).projects).toEqual([]);
    });

    it('refuses $HOME itself — the dialog starts there and could otherwise add it', async () => {
      const { status, body } = await post({ root: '~' });
      expect(status).toBe(400);
      expect(body.error).toContain('home directory');
      expect((await getProjects()).projects).toEqual([]);
    });

    it('hosted mode: a folder outside projectsDir is refused, one inside is registered', async () => {
      // Hosted narrows `/api/fs/browse` to projectsDir; the register route
      // re-checks the same containment, or a hand-made POST would walk around
      // the narrowing entirely.
      const checkoutRoot = join(home, 'checkouts');
      const inside = join(checkoutRoot, 'app');
      mkdirSync(inside, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.projectsDir = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const refused = await post({ root: otherRoot });
      expect(refused.status).toBe(400);
      // The message must not name the root it is protecting (fs-browse's rule).
      expect(refused.body.error).not.toContain(checkoutRoot);
      expect((await getProjects()).projects).toEqual([]);
      const allowed = await post({ root: inside });
      expect(allowed.status).toBe(200);
      expect(allowed.body.project.root).toBe(await realpath(inside));
    });
  });

  describe('GET /api/health — additive projects + bootProject', () => {
    it('keeps the pre-workspace shape byte-identical and adds only projects + bootProject', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getHealth();
      // The exact key set: every pre-existing field (BACKWARD_COMPATIBILITY.md
      // §2 — the bookmarklet contract) plus the two new additive fields, and
      // nothing else. `latestVersion` is absent while no update is known.
      expect(Object.keys(body).sort()).toEqual(
        [
          'bootProject',
          'capabilities',
          'checks',
          'defaultRunner',
          'forge',
          'projects',
          'repo',
          'repoRoot',
          'version',
        ].sort(),
      );
      // Pre-existing field values, unchanged by the workspace additions.
      expect(body.version).toBe('0.0.0-test');
      expect(body.repoRoot).toBe(repoRoot);
      expect(body.repo).toBeNull(); // tmp dir — not a git repo
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.defaultRunner).toBe('claude');
      expect(body.forge).toBeNull();
      expect(body.capabilities).toEqual({ localHandoff: true, followups: false });
      // New fields: registered projects enumerated, boot project named.
      expect(body.projects.map((p) => p.id).sort()).toEqual([boot.id, other.id].sort());
      expect(body.bootProject).toBe(boot.id);
    });

    it('health project entries carry id + name ONLY — never root (#431)', async () => {
      await registerProject(repoRoot);
      await registerProject(otherRoot);
      const body = await getHealth();
      expect(body.projects.length).toBeGreaterThan(0);
      for (const entry of body.projects) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'name']);
      }
    });

    it("regression: the health payload never contains another project's absolute root", async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const raw = JSON.stringify(await getHealth());
      // Health is CORS-open: a cross-origin reader must not learn the
      // absolute path (and thus username) of any registered project (#431).
      expect(raw).not.toContain(other.root);
      expect(raw).not.toContain(otherRoot);
    });

    it('hosted mode (CEZ_REMOTE=1): no absolute root at all — boot repo included (#431)', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      process.env.CEZ_REMOTE = '1';
      const body = await getHealth();
      expect(body.repoRoot).toBe(basename(repoRoot)); // existing trim, untouched
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(boot.root);
      expect(raw).not.toContain(other.root);
    });

    it('degrades to projects:[] with a slug bootProject when nothing is registered', async () => {
      const body = await getHealth();
      expect(body.projects).toEqual([]);
      expect(body.bootProject).toBe(allocateProjectSlug(repoRoot, []));
    });
  });
});
