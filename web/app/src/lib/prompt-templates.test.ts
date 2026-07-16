import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROMPT_TEMPLATES,
  insertTemplate,
  makeTemplateId,
  normalizePromptTemplates,
} from './prompt-templates'

describe('normalizePromptTemplates', () => {
  it('an absent key (undefined) falls back to the built-in defaults', () => {
    expect(normalizePromptTemplates(undefined)).toEqual(DEFAULT_PROMPT_TEMPLATES)
  })

  it('garbage (not an array) also falls back to the defaults — corruption must not brick the menu', () => {
    expect(normalizePromptTemplates('nope')).toEqual(DEFAULT_PROMPT_TEMPLATES)
    expect(normalizePromptTemplates({ not: 'an array' })).toEqual(DEFAULT_PROMPT_TEMPLATES)
    expect(normalizePromptTemplates(42)).toEqual(DEFAULT_PROMPT_TEMPLATES)
  })

  it('a deliberately empty array stays empty — the defaults must not reappear underneath it', () => {
    expect(normalizePromptTemplates([])).toEqual([])
  })

  it('parses a valid list verbatim', () => {
    const raw = [{ id: 'a', label: 'A', text: 'Do A.' }]
    expect(normalizePromptTemplates(raw)).toEqual(raw)
  })

  it('skips malformed entries but keeps the valid ones', () => {
    const raw = [
      { id: 'a', label: 'A', text: 'Do A.' },
      { id: 'b', label: '', text: 'missing label' },
      { id: '', label: 'no id', text: 'missing id' },
      { label: 'no text field at all' },
      'not an object',
      42,
      null,
      { id: 'c', label: 'C', text: 'Do C.' },
    ]
    expect(normalizePromptTemplates(raw)).toEqual([
      { id: 'a', label: 'A', text: 'Do A.' },
      { id: 'c', label: 'C', text: 'Do C.' },
    ])
  })

  it('drops a duplicate id, keeping the first occurrence', () => {
    const raw = [
      { id: 'a', label: 'First', text: 'one' },
      { id: 'a', label: 'Second', text: 'two' },
    ]
    expect(normalizePromptTemplates(raw)).toEqual([{ id: 'a', label: 'First', text: 'one' }])
  })

  it('trims and caps label/text length', () => {
    const raw = [{ id: 'a', label: `  ${'x'.repeat(90)}  `, text: `  ${'y'.repeat(2010)}  ` }]
    const [template] = normalizePromptTemplates(raw)
    expect(template?.label).toHaveLength(80)
    expect(template?.text).toHaveLength(2000)
  })

  it('caps the list at 50 entries', () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, text: `do ${i}` }))
    expect(normalizePromptTemplates(raw)).toHaveLength(50)
  })

  it('does not mutate the shared DEFAULT_PROMPT_TEMPLATES export on repeated calls', () => {
    const first = normalizePromptTemplates(undefined)
    first[0]!.label = 'mutated'
    expect(normalizePromptTemplates(undefined)[0]?.label).not.toBe('mutated')
  })
})

describe('makeTemplateId', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeTemplateId()))
    expect(ids.size).toBe(20)
  })
})

describe('insertTemplate', () => {
  it('into empty text: a plain assignment, no leading blank line', () => {
    expect(insertTemplate('', 0, 'Add tests.')).toEqual({ text: 'Add tests.', caret: 'Add tests.'.length })
  })

  it('appended at the end of existing text: separated by a blank line', () => {
    const result = insertTemplate('Fix the bug.', 'Fix the bug.'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
    expect(result.caret).toBe(result.text.length)
  })

  it('already ending in one newline: only one more is added (still a blank line total)', () => {
    const result = insertTemplate('Fix the bug.\n', 'Fix the bug.\n'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
  })

  it('already ending in a blank line: no extra separator is added', () => {
    const result = insertTemplate('Fix the bug.\n\n', 'Fix the bug.\n\n'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
  })

  it('inserts mid-text, keeping the tail intact and reporting the caret right after the snippet', () => {
    const text = 'BeforeAfter'
    const caret = 'Before'.length
    const result = insertTemplate(text, caret, 'MID')
    expect(result.text).toBe('Before\n\nMIDAfter')
    expect(result.caret).toBe('Before\n\nMID'.length)
  })

  it('clamps an out-of-range caret instead of throwing', () => {
    expect(insertTemplate('hi', 999, 'x').text).toBe('hi\n\nx')
    // Clamped to 0: "before" is empty, so no separator is prepended (same rule as the
    // empty-text case above).
    expect(insertTemplate('hi', -5, 'x').text).toBe('xhi')
  })
})
