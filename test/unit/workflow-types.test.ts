import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chainStepNote,
  normalizeWorkflowDoc,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
} from '../../src/workflows/types.js';

test('portable skill stacks normalize into unique agent steps', () => {
  const parsed = workflowFileSchema.parse({
    name: 'review-twice',
    skills: ['code-review', 'code-review'],
  });

  assert.deepEqual(normalizeWorkflowDoc(parsed), {
    name: 'review-twice',
    steps: [
      { id: 'code-review', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
      { id: 'code-review-2', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
    ],
  });
});

test('workflow files require exactly one step representation', () => {
  assert.equal(workflowFileSchema.safeParse({ name: 'empty' }).success, false);
  assert.equal(
    workflowFileSchema.safeParse({
      name: 'ambiguous',
      skills: ['review'],
      steps: [{ id: 'review', prompt: '{{task}}' }],
    }).success,
    false,
  );
});

test('retry targets must refer to an earlier unique step', () => {
  assert.equal(
    stepsIssue([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    ]),
    null,
  );
  assert.equal(
    stepsIssue([
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
      { id: 'implement', prompt: '{{task}}' },
    ]),
    'step "verify": onFail.retry must reference an earlier step (got "implement")',
  );
  assert.equal(
    stepsIssue([
      { id: 'duplicate', prompt: '{{task}}' },
      { id: 'duplicate', command: 'npm test' },
    ]),
    'duplicate step id "duplicate"',
  );
});

test('only plain agent skill steps compact back to a portable stack', () => {
  assert.deepEqual(skillStackOf(skillsToSteps(['implement', 'review'])), ['implement', 'review']);
  assert.equal(skillStackOf([{ id: 'verify', command: 'npm test' }]), null);
  assert.equal(
    skillStackOf([{ id: 'review', name: 'Custom name', skill: 'review', prompt: '{{task}}' }]),
    null,
  );
});

// #410: a chain of 2+ skills gave every step the SAME task text and shared
// one run-level handoff journal — a later step's fresh session had nothing
// telling it "an earlier step's own completion doesn't cover you", so it
// could read the earlier step's "done" signal and self-terminate (`CEZ:DONE`)
// on its first turn without doing its own step's work. `chainStepNote` is the
// prompt-level guard against that; these pin its exact contract.
test('chainStepNote is absent for a single-step run (the common case, unchanged)', () => {
  const [step] = skillsToSteps(['implement']);
  assert.equal(chainStepNote(step!, 0, 1), undefined);
});

test('chainStepNote names the step position, total, and skill for every step of a chain', () => {
  const steps = skillsToSteps(['om-auto-review-pr', 'om-auto-verify-pr-ui']);
  const first = chainStepNote(steps[0]!, 0, steps.length);
  const second = chainStepNote(steps[1]!, 1, steps.length);

  assert.ok(first?.includes('step 1 of 2'));
  assert.ok(first?.includes('om-auto-review-pr'));
  assert.ok(second?.includes('step 2 of 2'));
  assert.ok(second?.includes('om-auto-verify-pr-ui'));
  // The whole point: tell the LATER step an earlier step's completion isn't
  // its own — every note in a chain repeats this guard, not just the last one.
  for (const note of [first, second]) {
    assert.ok(note?.includes("does not mean your step's work is done"));
    assert.ok(note?.includes('CEZ:DONE'));
  }
});

test('chainStepNote falls back to the step name, then a generic label, when there is no skill', () => {
  const named = chainStepNote({ id: 'verify', name: 'Run the test suite', prompt: '{{task}}' }, 0, 2);
  assert.ok(named?.includes('"Run the test suite"'));

  const bare = chainStepNote({ id: 'step-1', prompt: '{{task}}' }, 0, 2);
  assert.ok(bare?.includes('this step'));
});
