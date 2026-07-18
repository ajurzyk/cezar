import { describe, expect, it } from 'vitest';

import { parseAskRequest, type AskRequest } from './ask.js';

const valid: AskRequest = {
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
};

describe('parseAskRequest', () => {
  it('accepts a well-formed single-question request', () => {
    expect(parseAskRequest(valid)).toEqual(valid);
  });

  it('accepts up to 4 questions with multiSelect and optional descriptions', () => {
    const req = {
      questions: [
        {
          id: 'q1',
          header: 'Sections',
          question: 'Which sections?',
          multiSelect: true,
          options: [{ label: 'Profile' }, { label: 'Billing' }],
        },
        {
          header: 'Theme',
          question: 'Which theme?',
          options: [{ label: 'Light' }, { label: 'Dark' }, { label: 'System' }],
        },
      ],
    };
    expect(parseAskRequest(req)).toEqual(req);
  });

  it('rejects an empty questions array', () => {
    expect(parseAskRequest({ questions: [] })).toBeNull();
  });

  it('rejects more than 4 questions', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, q, q, q, q] })).toBeNull();
  });

  it('rejects a question with fewer than 2 options', () => {
    expect(
      parseAskRequest({
        questions: [{ header: 'H', question: 'Q?', options: [{ label: 'only' }] }],
      }),
    ).toBeNull();
  });

  it('rejects a question with more than 4 options', () => {
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects a header longer than 12 chars', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'thirteen char', question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique option labels within a question', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'H', question: 'Q?', options: [{ label: 'same' }, { label: 'same' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique question texts', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, { ...q }] })).toBeNull();
  });

  it('rejects unknown top-level and per-option keys (strict)', () => {
    expect(parseAskRequest({ questions: valid.questions, extra: 1 })).toBeNull();
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [
              { label: 'a', color: 'red' },
              { label: 'b' },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseAskRequest(null)).toBeNull();
    expect(parseAskRequest('CEZ:ASK')).toBeNull();
    expect(parseAskRequest(42)).toBeNull();
  });
});
