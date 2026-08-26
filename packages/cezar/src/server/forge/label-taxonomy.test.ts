import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIPELINE_LABEL_TAXONOMY } from './label-taxonomy.ts';

/**
 * The drift guard between the compiled-in taxonomy and the two files that already declare it.
 *
 * `label-taxonomy.ts` is a THIRD copy of a contract that exists twice already — the label SET in
 * `.ai/agentic.config.json`, and the colours/descriptions in `label_meta()`
 * (`.ai/scripts/labels-sync.sh:60-91`). It has to be a copy: the repository cezar provisions
 * labels INTO is not where cezar's pipeline configuration lives, and a run's worktree has no
 * authenticated `gh` with which to read `ajurzyk/cezar` over the wire. So the copy is deliberate
 * and this test is the price of it — the alternative is two forges drifting apart silently, which
 * is the whole failure mode #47 exists to end.
 *
 * Read as FILES, not imported: `labels-sync.sh` is bash and `agentic.config.json` is not part of
 * any package. `bc-route-inventory.test.ts` sets the precedent for a test that reads repo files.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../../..');

/** The taxonomy's SET, in the order `labels-sync.sh` assembles it: the five config groups in
 *  declaration order, then `do-not-close` appended (`labels-sync.sh:136`). */
function namesFromConfig(): string[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, '.ai/agentic.config.json'), 'utf8')) as {
    labels: Record<string, unknown>;
  };
  const groups = ['pipeline', 'category', 'meta', 'priority', 'risk'] as const;
  const names = groups.flatMap((group) => (config.labels[group] as string[] | undefined) ?? []);
  return [...names, 'do-not-close'];
}

/** `    review)            echo "0366d6|Ready for code review" ;;` → `['review', '0366d6', 'Ready …']`.
 *  The `*)` neutral-grey default cannot match `[a-z0-9-]+`, so it never lands in the table. */
function metaFromScript(): Map<string, { color: string; description: string }> {
  const script = readFileSync(join(REPO_ROOT, '.ai/scripts/labels-sync.sh'), 'utf8');
  const table = new Map<string, { color: string; description: string }>();
  for (const line of script.split('\n')) {
    const match = /^\s*([a-z0-9-]+)\)\s+echo "([0-9a-f]{6})\|([^"]+)" ;;\s*$/.exec(line);
    if (match) table.set(match[1]!, { color: match[2]!, description: match[3]! });
  }
  return table;
}

describe('PIPELINE_LABEL_TAXONOMY mirrors the taxonomy the GitHub path already provisions', () => {
  it('is the 26 config labels plus do-not-close, in that order', () => {
    expect(PIPELINE_LABEL_TAXONOMY.map((label) => label.name)).toEqual(namesFromConfig());
  });

  it('is 27 labels', () => {
    // The count `labels-sync.sh --check` prints. Asserted separately from the list above so a
    // failure says WHICH property broke — a renamed label and a dropped one read very differently.
    expect(PIPELINE_LABEL_TAXONOMY).toHaveLength(27);
  });

  it('carries label_meta()`s colour and description for every entry', () => {
    const meta = metaFromScript();
    // Proves the parser found a real table rather than silently matching nothing — without this a
    // regex that stopped matching would make every comparison below vacuously pass.
    expect(meta.size).toBe(27);
    for (const label of PIPELINE_LABEL_TAXONOMY) {
      expect({ name: label.name, color: label.color, description: label.description }).toEqual({
        name: label.name,
        ...meta.get(label.name)!,
      });
    }
  });

  it('spells every colour as six lowercase hex digits with no leading #', () => {
    // Forgejo accepts a colour with or without `#` and always answers WITHOUT one (measured on
    // http://q7010-dev:8929, 2026-08-26). Storing the `#`-less form is what lets a drift comparison
    // against a read-back label be a plain string equality rather than a normalisation dance.
    for (const label of PIPELINE_LABEL_TAXONOMY) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it('has no duplicate names', () => {
    // Load-bearing rather than tidy: Forgejo's POST is not idempotent (a duplicate name answers 201
    // and creates a SECOND label), so a duplicated entry here would provision a duplicate label on
    // the very first pass, before any of the read-side deduplication could see it.
    expect(new Set(PIPELINE_LABEL_TAXONOMY.map((label) => label.name)).size).toBe(PIPELINE_LABEL_TAXONOMY.length);
  });
});
