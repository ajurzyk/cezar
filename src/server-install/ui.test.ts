import { describe, expect, it, vi } from 'vitest';
import { CANCEL } from './types.js';
import { createAutoUi, createClackUi, type PromptBackend } from './ui.js';

const CANCEL_SYMBOL = Symbol('clack.cancel');

function fakeBackend(over: Partial<PromptBackend>): PromptBackend {
  const noop = () => undefined;
  return {
    intro: noop,
    outro: noop,
    note: noop,
    log: { info: noop, success: noop, warn: noop, error: noop, message: noop, step: noop } as never,
    select: vi.fn(),
    multiselect: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    spinner: () => ({ start: noop, stop: noop, message: noop }) as never,
    isCancel: (v: unknown): v is symbol => v === CANCEL_SYMBOL,
    ...over,
  };
}

describe('createClackUi', () => {
  it('maps a cancelled prompt to the CANCEL sentinel, never throws', async () => {
    const ui = createClackUi(fakeBackend({ select: vi.fn().mockResolvedValue(CANCEL_SYMBOL) }));
    await expect(ui.select({ message: 'pick', options: [{ value: 'a', label: 'A' }] })).resolves.toBe(
      CANCEL,
    );
  });

  it('returns the value when the user answers', async () => {
    const ui = createClackUi(fakeBackend({ confirm: vi.fn().mockResolvedValue(true) }));
    await expect(ui.confirm({ message: 'ok?' })).resolves.toBe(true);
  });
});

describe('createAutoUi', () => {
  it('answers with initial values / first option and never blocks', async () => {
    const ui = createAutoUi();
    expect(await ui.confirm({ message: 'ok?', initialValue: false })).toBe(false);
    expect(await ui.select({ message: 'pick', options: [{ value: 'x', label: 'X' }] })).toBe('x');
    expect(await ui.text({ message: 'name', placeholder: 'def' })).toBe('def');
    expect(await ui.multiselect({ message: 'many', options: [] })).toEqual([]);
  });

  it('honors per-message answer overrides', async () => {
    const ui = createAutoUi({ 'pick tools': ['gh', 'codex'] });
    expect(await ui.multiselect({ message: 'pick tools', options: [] })).toEqual(['gh', 'codex']);
  });
});
