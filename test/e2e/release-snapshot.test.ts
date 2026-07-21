import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repoRoot, 'scripts', 'release-snapshot.mjs');

// The orchestrator imports dist/release/snapshot.js, so this suite (like the
// packaged-CLI e2e) runs after `npm run build` — both locally in the gate order
// and in CI's verify job.

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-snapshot-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-root', version: '0.9.9', files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'index.js'), 'export {};\n');
  await mkdir(join(root, 'alias-cezar'));
  await writeFile(
    join(root, 'alias-cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: 'fake-alias',
        version: '0.9.9',
        files: ['bin.js'],
        dependencies: { '@scope/fake-root': '^0.9.9' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'alias-cezar', 'bin.js'), '#!/usr/bin/env node\n');
  return root;
}

function runScript(fixtureRoot: string, extraEnv: Record<string, string>, args: string[] = []) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CEZ_SNAPSHOT_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    ...extraEnv,
  };
  return execFile(process.execPath, [script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

test('dry-run publish stamps both manifests, pins the alias exact, and emits the result JSON', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(
      root,
      {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_NUMBER: '77',
        PR_HEAD_REPO: 'open-mercato/cezar',
        GITHUB_REPOSITORY: 'open-mercato/cezar',
        GITHUB_RUN_NUMBER: '5',
        GITHUB_RUN_ATTEMPT: '1',
      },
      ['--dry-run'],
    );

    const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    const aliasPkg = JSON.parse(await readFile(join(root, 'alias-cezar', 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    assert.equal(rootPkg.version, '0.9.9-pr77.5');
    assert.equal(aliasPkg.version, '0.9.9-pr77.5');
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '0.9.9-pr77.5' });

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^attempted=true$/m);
    assert.match(output, /^dryRun=true$/m);
    const resultLine = output.split('\n').find((line) => line.startsWith('result='));
    assert.ok(resultLine, 'GITHUB_OUTPUT should carry the result JSON');
    const result = JSON.parse(resultLine.slice('result='.length)) as {
      distTag: string;
      installLines: string[];
    };
    assert.equal(result.distTag, 'pr-77');
    assert.ok(
      result.installLines.some((line) => line.includes('npx fake-alias@0.9.9-pr77.5')),
      'install lines should use the actual alias name and exact version',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing NPM token forces a dry run instead of failing the job', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag and no NODE_AUTH_TOKEN: the script must degrade, not throw.
    const { stdout } = await runScript(root, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'develop',
      GITHUB_REPOSITORY: 'open-mercato/cezar',
      GITHUB_RUN_NUMBER: '8',
    });
    assert.match(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^dryRun=true$/m);
    assert.match(output, /"distTag":"develop"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-publishable event exits 0 without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'feat/some-branch',
      GITHUB_REPOSITORY: 'open-mercato/cezar',
      GITHUB_RUN_NUMBER: '9',
    });
    const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(rootPkg.version, '0.9.9');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^attempted=false$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
