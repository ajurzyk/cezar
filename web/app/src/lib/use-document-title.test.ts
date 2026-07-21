import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { documentTitleOf, useDocumentTitle } from './use-document-title'

afterEach(() => {
  cleanup()
  document.title = 'cezar'
})

describe('documentTitleOf', () => {
  it.each([
    {
      name: 'project and page',
      projectName: 'storefront',
      pageLabel: 'Tasks',
      expected: 'storefront — Tasks · cezar',
    },
    {
      name: 'project only',
      projectName: 'storefront',
      pageLabel: null,
      expected: 'storefront · cezar',
    },
    {
      name: 'page only',
      projectName: null,
      pageLabel: 'Settings',
      expected: 'Settings · cezar',
    },
    { name: 'neither', projectName: null, pageLabel: null, expected: 'cezar' },
    { name: 'empty strings', projectName: '', pageLabel: '', expected: 'cezar' },
    { name: 'whitespace', projectName: '   ', pageLabel: '\n', expected: 'cezar' },
  ])('$name', ({ projectName, pageLabel, expected }) => {
    expect(documentTitleOf({ projectName, pageLabel })).toBe(expected)
  })

  it('trims the known parts before formatting', () => {
    expect(documentTitleOf({ projectName: ' storefront ', pageLabel: ' Tasks ' })).toBe(
      'storefront — Tasks · cezar',
    )
  })
})

describe('useDocumentTitle', () => {
  it('updates the same document title when its inputs change', () => {
    const { rerender } = renderHook(
      ({ projectName, pageLabel }) => useDocumentTitle({ projectName, pageLabel }),
      { initialProps: { projectName: 'cezar', pageLabel: 'Tasks' as string | null } },
    )

    expect(document.title).toBe('cezar — Tasks · cezar')

    rerender({ projectName: 'storefront', pageLabel: 'Git' })
    expect(document.title).toBe('storefront — Git · cezar')

    rerender({ projectName: '', pageLabel: null })
    expect(document.title).toBe('cezar')
  })
})
