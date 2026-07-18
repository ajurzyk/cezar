import { describe, expect, it } from 'vitest';

import { parseAskMarker, parseAskRequest, stripAskMarker, type AskRequest } from './ask.js';

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

const askJson = JSON.stringify(valid);

describe('parseAskMarker', () => {
  it('extracts a valid request from a trailing CEZ:ASK marker', () => {
    const turn = `Here are the options.\nCEZ:ASK ${askJson}`;
    expect(parseAskMarker(turn)).toEqual(valid);
  });

  it('tolerates trailing whitespace/newlines after the JSON', () => {
    expect(parseAskMarker(`text\nCEZ:ASK ${askJson}\n  \n`)).toEqual(valid);
  });

  it('returns null when there is no marker', () => {
    expect(parseAskMarker('just a normal answer, no marker')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseAskMarker('CEZ:ASK {not json')).toBeNull();
  });

  it('returns null when the JSON is valid but fails the schema', () => {
    expect(parseAskMarker('CEZ:ASK {"questions":[]}')).toBeNull();
  });

  it('ignores a marker that is not at the end of the turn', () => {
    expect(parseAskMarker(`CEZ:ASK ${askJson}\nand then more text after`)).toBeNull();
  });
});

describe('stripAskMarker', () => {
  it('removes a trailing CEZ:ASK marker for display', () => {
    expect(stripAskMarker(`Pick one.\nCEZ:ASK ${askJson}`)).toBe('Pick one.');
  });

  it('leaves text without a marker untouched', () => {
    expect(stripAskMarker('no marker here')).toBe('no marker here');
  });
});
