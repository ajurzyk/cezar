import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
