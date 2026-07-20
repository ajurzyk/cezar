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
const script = join(repoRoot, 'scripts', 'release.mjs');

// The orchestrator imports dist/release/stable.js, so this suite (like the
// snapshot e2e) runs after `npm run build`.

async function makeFixture(version = '0.1.5'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-root', version, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'index.js'), 'export {};\n');
  await mkdir(join(root, 'alias-cezar'));
  await writeFile(
    join(root, 'alias-cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: 'fake-alias',
        version,
        files: ['bin.js'],
        dependencies: { '@scope/fake-root': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'alias-cezar', 'bin.js'), '#!/usr/bin/env node\n');
  return root;
}

function runScript(fixtureRoot: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CEZ_RELEASE_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    ...extraEnv,
  };
  return execFile(process.execPath, [script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

test('a patch bump stamps both manifests, keeps the alias caret range, and emits the version', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);
    assert.match(stdout, /dist-tag latest/);

    const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    const aliasPkg = JSON.parse(await readFile(join(root, 'alias-cezar', 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    assert.equal(rootPkg.version, '0.1.6');
    assert.equal(aliasPkg.version, '0.1.6');
    // Caret, not an exact pin — the stable-release contract.
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '^0.1.6' });

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=0\.1\.6$/m);
    assert.match(output, /^published=false$/m);
    assert.match(output, /^dryRun=true$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the existing bump publishes the committed version verbatim', { timeout: 120_000 }, async () => {
  const root = await makeFixture('2.3.4');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, ['existing', '--dry-run']);
    const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(rootPkg.version, '2.3.4');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=2\.3\.4$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing NPM token forces a dry run instead of publishing', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag and no NODE_AUTH_TOKEN: the script must degrade, not publish.
    const { stdout } = await runScript(root, ['minor']);
    assert.match(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=false$/m);
    assert.match(output, /^version=0\.2\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown bump exits non-zero without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await assert.rejects(runScript(root, ['snapshot', '--dry-run']));
    const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(rootPkg.version, '0.1.5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
