import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearForgejoCachesForTests, createForgejoDriver } from './forgejo.ts';
import { createGithubDriver } from './github.ts';
import type { ForgeDriver, ForgeItem, ForgeSettings } from './types.ts';

/**
 * The cross-driver invariant behind #26: under `CEZ_DRY_RUN=1` the Forgejo catalog and the GitHub
 * catalog (`mockGithub`) must share NO identifying value.
 *
 * Why it deserves a test of its own rather than a comment on each catalog: both are hand-written
 * and hand-maintained, in two files, by whoever last needed one more fixture row. The moment they
 * overlap, an e2e case that believes it is asserting Forgejo behaviour can be satisfied by the
 * GitHub fixtures sitting in front of it — a green run proving nothing, which is exactly the
 * failure mode #26 was opened to close ("no fixture value is shared with `mockGithub()`; a Forgejo
 * assertion cannot be satisfied by GitHub fixtures").
 *
 * Both catalogs are read through the DRIVER seam, not by importing the fixtures: that is the
 * surface the cockpit actually consumes, so a catalog that is disjoint on paper but collides after
 * the driver has composed it still fails here.
 *
 * `createdAt` is deliberately not compared — both catalogs derive it from `Date.now()`, so it is a
 * timestamp, not an identity.
 */

const settings: ForgeSettings = {
  kind: 'forgejo',
  apiUrl: 'http://forgejo.internal:3000',
  webUrl: 'https://forge.example.com',
};

let forgejo: ForgeDriver;
let github: ForgeDriver;

beforeEach(() => {
  process.env.CEZ_DRY_RUN = '1';
  __clearForgejoCachesForTests();
  forgejo = createForgejoDriver(
    { repoRoot: '/repo/dry-run-fixtures', owner: 'acme', repo: 'demo', settings },
    // Injected and never called — a dry-run read that reached the network would fail this outright.
    { fetch: vi.fn(), token: null },
  );
  github = createGithubDriver('/repo/dry-run-fixtures', null);
});

afterEach(() => {
  delete process.env.CEZ_DRY_RUN;
});

async function catalog(driver: ForgeDriver): Promise<ForgeItem[]> {
  const [issues, prs] = await Promise.all([driver.listIssues(), driver.listPRs()]);
  return [...issues.items, ...prs.items];
}

describe('CEZ_DRY_RUN=1 forge fixtures', () => {
  it('both drivers serve a non-empty catalog', async () => {
    expect((await catalog(forgejo)).length).toBeGreaterThan(0);
    expect((await catalog(github)).length).toBeGreaterThan(0);
  });

  it.each([
    ['number', (item: ForgeItem) => String(item.number)],
    ['title', (item: ForgeItem) => item.title],
    ['url', (item: ForgeItem) => item.url],
    ['author', (item: ForgeItem) => item.author],
    ['body', (item: ForgeItem) => item.body],
  ])('shares no %s between the Forgejo and GitHub catalogs', async (_field, read) => {
    const mine = new Set((await catalog(forgejo)).map(read));
    const theirs = new Set((await catalog(github)).map(read));
    expect([...mine].filter((value) => theirs.has(value))).toEqual([]);
  });

  it('shares no label name between the two catalogs', async () => {
    const mine = new Set((await catalog(forgejo)).flatMap((item) => item.labels));
    const theirs = new Set((await catalog(github)).flatMap((item) => item.labels));
    expect(mine.size).toBeGreaterThan(0);
    expect([...mine].filter((label) => theirs.has(label))).toEqual([]);
  });

  it('shares no label colour between the two catalogs', async () => {
    const colorsOf = async (driver: ForgeDriver): Promise<string[]> =>
      Object.values((await driver.listIssues()).labelColors ?? {});
    const mine = await colorsOf(forgejo);
    const theirs = new Set(await colorsOf(github));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((color) => theirs.has(color))).toEqual([]);
  });

  it('the Forgejo catalog links onto the configured webUrl host and never onto github.com', async () => {
    for (const item of await catalog(forgejo)) {
      expect(item.url.startsWith(`${settings.webUrl}/acme/demo/`)).toBe(true);
      expect(item.url).not.toContain('github.com');
    }
  });
});
