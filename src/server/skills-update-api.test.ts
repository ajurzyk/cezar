import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.js';
import { SkillsUpdateService } from '../skills-update.js';
import { mergeWriteWorkspaceConfig } from '../workspace/config.js';
import type { RunManager } from '../workflows/run.js';
import { apiRequest } from './loopback-request.testkit.js';
import { createApp } from './server.js';

describe('workspace skills update API', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let missingRoot: string;
  let store: RunStore;
  let service: SkillsUpdateService;
  let app: Hono;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-skills-update-api-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-skills-update-repo-'));
    missingRoot = join(home, 'gone');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [
        { id: 'repo', name: 'Repo', root: repoRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
        { id: 'gone', name: 'Gone', root: missingRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
      ];
    });
    service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => null });
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager,
      version: 'test', skillsUpdate: service });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns the cached snapshot immediately and schedules a detection-only check', async () => {
    const snapshot = vi.spyOn(service, 'snapshot');
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/workspace/skills-update?projectId=repo');
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'idle' });
    expect(snapshot).toHaveBeenCalledWith(repoRoot);
    expect(check).toHaveBeenCalledWith(repoRoot);
  });

  it('forces a check using only the registered project root', async () => {
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/workspace/skills-update/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'repo' }),
    });
    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(repoRoot, true);
  });

  it('rejects executable input and invalid bodies without checking', async () => {
    const check = vi.spyOn(service, 'check');
    for (const body of [{}, { projectId: 'repo', command: 'rm' }, { projectId: 'repo', skills: ['x'] }]) {
      const response = await apiRequest(app, '/api/workspace/skills-update/check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('uses the existing unknown and gone project contract', async () => {
    expect((await apiRequest(app, '/api/workspace/skills-update?projectId=unknown')).status).toBe(404);
    expect((await apiRequest(app, '/api/workspace/skills-update?projectId=gone')).status).toBe(409);
    expect((await apiRequest(app, '/api/workspace/skills-update')).status).toBe(400);
  });
});
