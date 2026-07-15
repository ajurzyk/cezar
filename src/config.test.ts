import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * `config.json` schema roundtrips (R2 2.3: `systemPrompt?`). The invariants
 * under test: the key is additive (old files keep loading exactly as before),
 * a bad value degrades per-key instead of discarding the whole config, and
 * the value is trimmed with blank treated as unset.
 */
describe('loadConfig systemPrompt', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  it('is undefined when no config file exists (zero-config default)', async () => {
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
  });

  it('old config files without the key still load unchanged (additive proof)', async () => {
    write({ maxParallel: 5, defaultRunner: 'codex', baseBranch: 'develop' });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(5);
    expect(config.defaultRunner).toBe('codex');
    expect(config.baseBranch).toBe('develop');
  });

  it('roundtrips a configured prompt, trimmed', async () => {
    write({ systemPrompt: '  Always answer in Polish.  ' });
    expect((await loadConfig(repoRoot)).systemPrompt).toBe('Always answer in Polish.');
  });

  it('treats a whitespace-only prompt as unset without touching other keys', async () => {
    write({ systemPrompt: '   ', maxParallel: 3 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(3);
  });

  it('degrades an over-long prompt (>20k) to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 'x'.repeat(20_001), maxParallel: 4 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(4);
  });

  it('accepts a prompt at exactly the 20k cap', async () => {
    write({ systemPrompt: 'x'.repeat(20_000) });
    expect((await loadConfig(repoRoot)).systemPrompt).toHaveLength(20_000);
  });

  it('degrades a wrong-typed prompt to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 42, maxParallel: 6 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(6);
  });

  it('malformed JSON degrades to the full default (never throws)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{not json', 'utf8');
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(2);
  });

  /** `defaultModels?` (R6 1.5) rides the same additive-key rules as `systemPrompt`. */
  describe('defaultModels', () => {
    it('is undefined when absent — old config files load unchanged', async () => {
      write({ maxParallel: 5 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(5);
    });

    it('round-trips per-runner presets, trimmed', async () => {
      write({ defaultModels: { claude: ' opus ', opencode: 'openai/gpt-5.1' } });
      expect((await loadConfig(repoRoot)).defaultModels).toEqual({
        claude: 'opus',
        opencode: 'openai/gpt-5.1',
      });
    });

    it('degrades a bad value to unset per-key, keeping the rest of the config', async () => {
      write({ defaultModels: { claude: 42 }, maxParallel: 6 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(6);
    });
  });
});
