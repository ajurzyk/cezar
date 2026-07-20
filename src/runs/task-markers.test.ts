import { describe, expect, it } from 'vitest';
import { parseTaskMarkers, stripTaskMarkers } from './task-markers.js';

/** Spec 2026-07-18-task-ref-markers — the in-band declaration layer above the fuzzy tiers. */
describe('parseTaskMarkers', () => {
  it('reads each marker off its own line', () => {
    expect(parseTaskMarkers('Working on it.\nCEZ:PR=442\nCEZ:ISSUE=433\nCEZ:TITLE=fixing plan rendering\ndone soon')).toEqual({
      pr: 442,
      issue: 433,
      title: 'fixing plan rendering',
    });
  });

  it('the last occurrence of a marker wins', () => {
    expect(parseTaskMarkers('CEZ:PR=1\nsome progress\nCEZ:PR=500')).toEqual({ pr: 500 });
    expect(parseTaskMarkers('CEZ:TITLE=first guess\nCEZ:TITLE=implementing comment threads')).toEqual({
      title: 'implementing comment threads',
    });
  });

  it('is line-anchored — prose mentions and inline text never parse', () => {
    expect(parseTaskMarkers('I will emit CEZ:PR=442 when the PR exists')).toEqual({});
    expect(parseTaskMarkers('  CEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=442 (the review PR)')).toEqual({});
  });

  it('the instruction placeholder and junk values are inert', () => {
    expect(parseTaskMarkers('CEZ:PR=<number>')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=0')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=99999999999')).toEqual({});
    expect(parseTaskMarkers('CEZ:TITLE=   ')).toEqual({});
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    expect(parseTaskMarkers('CEZ:PR=7  \r\nCEZ:ISSUE=9\r\n')).toEqual({ pr: 7, issue: 9 });
  });

  it('finds nothing in plain prose', () => {
    expect(parseTaskMarkers('renamed the settings page')).toEqual({});
    expect(parseTaskMarkers('')).toEqual({});
  });
});

describe('stripTaskMarkers', () => {
  it('removes complete marker lines and keeps the surrounding text', () => {
    expect(stripTaskMarkers('Opened the PR.\nCEZ:PR=442\nCEZ:TITLE=fixing plan rendering\nNext: tests.')).toBe(
      'Opened the PR.\nNext: tests.',
    );
  });

  it('leaves prose mentions and non-marker lines alone', () => {
    const text = 'I will emit CEZ:PR=442 later\nnormal line';
    expect(stripTaskMarkers(text)).toBe(text);
  });

  it('is a no-op on text without any CEZ prefix', () => {
    expect(stripTaskMarkers('plain progress update')).toBe('plain progress update');
  });
});
