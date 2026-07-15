import { describe, expect, it } from 'vitest'

import { parseNewTaskParams, type NewTaskParams } from './new-task-params'

/** The saved-bookmarklet contract (spec 011) — protected by BACKWARD_COMPATIBILITY.md,
 *  and these links live in users' browsers, not in this repo. The cases below mirror
 *  `initFromQuery()` in web/app.js so the React `/new` accepts exactly what the legacy
 *  page did. */
describe('parseNewTaskParams', () => {
  const empty: NewTaskParams = { skill: '', ref: '', auto: false, key: '' }
  const cases: Array<[name: string, search: string, expected: NewTaskParams]> = [
    ['no query at all', '', empty],
    [
      'the full bookmarklet link',
      '?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret',
      { skill: 'om-code-review', ref: 'https://github.com/o/r/pull/1', auto: true, key: 's3cret' },
    ],
    ['skill only (the "open the composer with this skill" bookmarklet)', '?skill=om-fix', { ...empty, skill: 'om-fix' }],
    // `task` is the older spelling of `ref`; app.js still accepts it, so must we.
    ['legacy `task` alias for `ref`', '?task=issue-12', { ...empty, ref: 'issue-12' }],
    ['`ref` wins over `task` when both are present', '?ref=a&task=b', { ...empty, ref: 'a' }],
    // Only the exact string `1` arms auto-start — anything else is a plain visit.
    ['auto=0 is not auto-start', '?auto=0', empty],
    ['auto=true is not auto-start', '?auto=true', empty],
    ['auto present but empty is not auto-start', '?auto=', empty],
    ['whitespace around skill/ref is trimmed', '?skill=%20om-fix%20&ref=%20x%20', { ...empty, skill: 'om-fix', ref: 'x' }],
    ['unknown params are ignored', '?skill=om-fix&nope=1', { ...empty, skill: 'om-fix' }],
  ]

  for (const [name, search, expected] of cases) {
    it(name, () => {
      expect(parseNewTaskParams(search)).toEqual(expected)
    })
  }

  it('takes a URLSearchParams too (what useSearchParams hands the route)', () => {
    expect(parseNewTaskParams(new URLSearchParams('skill=om-fix&auto=1'))).toEqual({
      ...empty,
      skill: 'om-fix',
      auto: true,
    })
  })
})
