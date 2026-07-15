import { describe, expect, it } from 'vitest';
import { deriveTitleSummary } from './title-summary.js';

const TASK = 'fix the login bug\nusers get a 500 on wrong passwords';

describe('deriveTitleSummary', () => {
  const cases: Array<{
    name: string;
    text: string;
    task?: string;
    expected: string | undefined;
  }> = [
    {
      name: 'plain first sentence, trailing period dropped',
      text: 'The login handler swallows the auth error. Full details below.',
      expected: 'The login handler swallows the auth error',
    },
    {
      name: 'only the first sentence survives',
      text: 'Fixed the 500 on wrong passwords by catching AuthError! Then I added a regression test.',
      expected: 'Fixed the 500 on wrong passwords by catching AuthError',
    },
    {
      name: 'dots inside file paths do not end the sentence',
      text: 'Renamed the handler in src/auth/login.ts to match the route table. More below.',
      expected: 'Renamed the handler in src/auth/login.ts to match the route table',
    },
    {
      name: 'leading "I\'ll" fluff is stripped and the rest re-capitalized',
      text: "I'll refactor the session store to use atomic writes.",
      expected: 'Refactor the session store to use atomic writes',
    },
    {
      name: 'stacked fluff strips repeatedly',
      text: "Sure! I'll go ahead and rewrite the retry loop with backoff.",
      expected: 'Rewrite the retry loop with backoff',
    },
    {
      name: '"Let me" fluff',
      text: 'Let me start by reading the failing test to understand the regression.',
      expected: 'Reading the failing test to understand the regression',
    },
    {
      name: 'markdown heading + bold + inline code cleaned',
      text: '## **Plan**: fix the `RunStore` index corruption on shutdown\n\ndetails…',
      expected: 'Plan: fix the RunStore index corruption on shutdown',
    },
    {
      name: 'list marker and link syntax cleaned',
      text: '- fix the flaky [SSE test](docs/sse.md) by awaiting the replay barrier',
      expected: 'Fix the flaky SSE test by awaiting the replay barrier',
    },
    {
      name: 'leading code fence is skipped, prose after it wins',
      text: '```ts\nconst x = 1;\n```\nSwitched the parser to a streaming tokenizer for large files.',
      expected: 'Switched the parser to a streaming tokenizer for large files',
    },
    {
      name: 'unclosed code fence swallows the rest — nothing informative left',
      text: '```\ngit diff --shortstat\n1 file changed',
      expected: undefined,
    },
    {
      name: 'empty text',
      text: '',
      expected: undefined,
    },
    {
      name: 'whitespace only',
      text: '  \n\n\t ',
      expected: undefined,
    },
    {
      name: 'too short to be informative',
      text: 'Done.',
      expected: undefined,
    },
    {
      name: 'three words is still too short',
      text: 'Fixed the bug.',
      expected: undefined,
    },
    {
      name: 'four words qualifies',
      text: 'Fixed the login bug.',
      expected: 'Fixed the login bug',
    },
    {
      name: 'echo of the task first line is not a summary',
      text: 'fix the login bug',
      task: TASK,
      expected: undefined,
    },
    {
      name: 'task echo is compared case-insensitively',
      text: 'Fix The Login Bug',
      task: TASK,
      expected: undefined,
    },
    {
      // 'Fix parser handling of ' is 23 code points; slice(0, 79) keeps 56 of
      // the astral-plane emoji intact — a UTF-16 slice would split a pair.
      name: 'unicode: capped at 80 code points with an ellipsis, no split surrogate pairs',
      text: `Fix parser handling of ${'🚀'.repeat(100)}`,
      expected: `Fix parser handling of ${'🚀'.repeat(56)}…`,
    },
    {
      name: 'exactly 80 code points passes uncapped',
      text: `Fix ${'a'.repeat(72)} b c`,
      expected: `Fix ${'a'.repeat(72)} b c`,
    },
    {
      name: 'snake_case identifiers survive the emphasis stripper',
      text: 'Renamed max_parallel to maxParallel across the config loader.',
      expected: 'Renamed max_parallel to maxParallel across the config loader',
    },
  ];

  it.each(cases)('$name', ({ text, task, expected }) => {
    expect(deriveTitleSummary(text, task ?? TASK)).toBe(expected);
  });

  it('caps to at most 80 code points', () => {
    const result = deriveTitleSummary(`${'word '.repeat(60)}tail.`, TASK);
    expect(result).toBeDefined();
    expect([...(result as string)].length).toBeLessThanOrEqual(80);
    expect(result?.endsWith('…')).toBe(true);
  });
});
