import { describe, expect, it } from 'vitest';
import { skillStackOf, workflowStepSchema, type WorkflowStepDef } from './types.ts';

/**
 * `timeoutMinutes` (#48) — the opt-up out of `DEFAULT_RUN_TIMEOUT_MS` for a step
 * that legitimately runs long. A run whose `implement` step was killed at 30
 * minutes recorded `status: "failed"`, so `verify`/`review`/`e2e`/`qa`/
 * `acceptance` never ran, while the branch and the PR it had already pushed made
 * it look finished from the outside.
 *
 * The field is small; the ways it can go MISSING are not, and each case below
 * pins one of them.
 */
describe('workflowStepSchema timeoutMinutes', () => {
  it('a step may declare timeoutMinutes and it survives parsing', () => {
    const parsed = workflowStepSchema.parse({
      id: 'implement',
      skill: 'om-auto-create-pr',
      prompt: '{{task}}',
      timeoutMinutes: 90,
    });

    expect(parsed.timeoutMinutes).toBe(90);
  });

  it('timeoutMinutes rejects zero, negatives, non-integers and the upper bound', () => {
    const step = { id: 'implement', prompt: '{{task}}' };
    // `positive()` alone accepts 999999, which quietly deletes the safety net
    // this field is supposed to keep — hence the explicit 240-minute ceiling.
    for (const timeoutMinutes of [0, -1, -90, 1.5, 241, 999_999]) {
      expect(workflowStepSchema.safeParse({ ...step, timeoutMinutes }).success).toBe(false);
    }
    for (const timeoutMinutes of [1, 90, 240]) {
      expect(workflowStepSchema.safeParse({ ...step, timeoutMinutes }).success).toBe(true);
    }
  });

  it('a check step may not carry timeoutMinutes', () => {
    // A deliberate behaviour change, not a preserved invariant: a check step is
    // a shell command, and its duration is the shell's business, not the agent
    // runner's. Nothing has ever been able to write this shape, so narrowing
    // the schema here cannot eat an already-queued run (`runs/store.ts`).
    const result = workflowStepSchema.safeParse({
      id: 'verify',
      command: 'npm test',
      timeoutMinutes: 90,
    });

    expect(result.success).toBe(false);

    // The pre-existing XOR rule keeps its own message and behaviour.
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'npm test' }).success).toBe(true);
    expect(
      workflowStepSchema.safeParse({ id: 'both', command: 'npm test', prompt: '{{task}}' }).success,
    ).toBe(false);
  });

  it('skillStackOf refuses the compact form for a step with timeoutMinutes', () => {
    // The silent-drop path: `POST /workflows` (`server/server.ts`) writes the
    // compact `skills:` shorthand back whenever `skillStackOf` returns a list,
    // and the shorthand has nowhere to put a timeout. Without the guard the
    // route saves the workflow WITHOUT the field and reports no error.
    const steps: WorkflowStepDef[] = [
      { id: 'review', name: 'review', skill: 'review', prompt: '{{task}}' },
      { id: 'implement', name: 'implement', skill: 'implement', prompt: '{{task}}', timeoutMinutes: 90 },
    ];

    expect(skillStackOf(steps)).toBeNull();
    // The same pair without the field is still compactable — the guard must not
    // have widened into "no step may ever take the shorthand".
    expect(skillStackOf(steps.map(({ timeoutMinutes: _drop, ...s }) => s))).toEqual([
      'review',
      'implement',
    ]);
  });
});
