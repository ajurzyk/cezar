import { mkdtempSync, rmSync } from 'node:fs';
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
import { createApp, type ProjectsResponse, type ServerDeps } from './server.js';

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
