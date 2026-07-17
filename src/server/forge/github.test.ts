import { describe, expect, it } from 'vitest';
import { ghCheckRunSchema, rollupToChecks } from './github.js';

/** `rollupToChecks` collapses a `gh … --json statusCheckRollup` array — already zod-validated
 *  via `ghCheckRunSchema` at the call site — down to the single enum the GitHub tab renders,
 *  both on PR rows (#400) and in the detail pane's `ChecksBadge`. */

describe('ghCheckRunSchema', () => {
  it('accepts a real gh rollup entry (conclusion + status, no state)', () => {
    expect(ghCheckRunSchema.parse({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toEqual({
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      state: undefined,
    });
  });

  it('accepts a check-context style entry (state, no status/conclusion)', () => {
    expect(ghCheckRunSchema.parse({ state: 'PENDING' })).toEqual({
      state: 'PENDING',
      status: undefined,
      conclusion: undefined,
    });
  });

  it('accepts nulls for every field — gh omits fields depending on the check provider', () => {
    expect(ghCheckRunSchema.parse({ state: null, status: null, conclusion: null })).toEqual({
      state: null,
      status: null,
      conclusion: null,
    });
  });

  it('rejects a non-object entry', () => {
    expect(() => ghCheckRunSchema.parse('SUCCESS')).toThrow();
  });
});

describe('rollupToChecks', () => {
  it('returns null when the rollup is absent, null, or empty', () => {
    expect(rollupToChecks(undefined)).toBeNull();
    expect(rollupToChecks(null)).toBeNull();
    expect(rollupToChecks([])).toBeNull();
  });

  it('returns "passing" when every entry concluded SUCCESS', () => {
    expect(
      rollupToChecks([
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
      ]),
    ).toBe('passing');
  });

  it.each(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'returns "failing" when any entry concluded %s, even alongside passing ones',
    (conclusion) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion, status: null, state: null },
        ]),
      ).toBe('failing');
    },
  );

  it.each(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'])(
    'returns "pending" when any entry is still %s and none have failed',
    (status) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion: null, status, state: null },
        ]),
      ).toBe('pending');
    },
  );

  it('failing wins over pending when both are present', () => {
    expect(
      rollupToChecks([
        { conclusion: null, status: 'IN_PROGRESS', state: null },
        { conclusion: 'FAILURE', status: null, state: null },
      ]),
    ).toBe('failing');
  });

  it('falls back through conclusion → state → status, then treats a blank as pending', () => {
    expect(rollupToChecks([{ conclusion: null, status: null, state: 'FAILURE' }])).toBe('failing');
    expect(rollupToChecks([{ conclusion: null, status: null, state: null }])).toBe('pending');
  });
});
