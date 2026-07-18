import { describe, expect, it } from 'vitest'

import type { Skill, WorkflowDef } from '@/api/types'

import {
  filterSkills,
  fuzzyMatch,
  isProjectSkill,
  matchScore,
  multiWordFilter,
  orderSkills,
  orderSkillsByRecency,
  skillKeywords,
  skillUsedBy,
} from './skills'

const skill = (over: Partial<Skill> & Pick<Skill, 'name' | 'source'>): Skill => ({
  body: '',
  path: `/skills/${over.name}.md`,
  ...over,
})

describe('isProjectSkill / orderSkills (#377)', () => {
  it('classifies every server source value', () => {
    expect(isProjectSkill(skill({ name: 'a', source: 'ai' }))).toBe(true)
    expect(isProjectSkill(skill({ name: 'b', source: 'cezar' }))).toBe(true)
    expect(isProjectSkill(skill({ name: 'c', source: 'agents' }))).toBe(true)
    expect(isProjectSkill(skill({ name: 'd', source: 'global' }))).toBe(false)
    expect(isProjectSkill(skill({ name: 'e', source: 'team' }))).toBe(false)
  })

  it('orders project before global/team, stably within each half', () => {
    const ordered = orderSkills([
      skill({ name: 'g1', source: 'global' }),
      skill({ name: 'p1', source: 'agents' }),
      skill({ name: 'g2', source: 'team' }),
      skill({ name: 'p2', source: 'ai' }),
    ])
    expect(ordered.map((s) => s.name)).toEqual(['p1', 'p2', 'g1', 'g2'])
  })
})

describe('orderSkillsByRecency', () => {
  const skills = [
    skill({ name: 'g1', source: 'global' }),
    skill({ name: 'p1', source: 'agents' }),
    skill({ name: 'g2', source: 'global' }),
    skill({ name: 'p2', source: 'ai' }),
  ]

  it('keeps locality first, then sorts most-recent within each half', () => {
    // Recent = [g2, p2] newest first → g2 leads globals, p2 leads projects.
    const ordered = orderSkillsByRecency(skills, ['g2', 'p2'])
    expect(ordered.map((s) => s.name)).toEqual(['p2', 'p1', 'g2', 'g1'])
  })

  it('never-run skills keep server order after the recent ones', () => {
    const ordered = orderSkillsByRecency(skills, ['g2'])
    expect(ordered.map((s) => s.name)).toEqual(['p1', 'p2', 'g2', 'g1'])
  })

  it('falls back to plain locality order with no recency', () => {
    expect(orderSkillsByRecency(skills, []).map((s) => s.name)).toEqual(['p1', 'p2', 'g1', 'g2'])
  })
})

describe('fuzzyMatch', () => {
  const table: Array<{ candidate: string; query: string; hit: boolean }> = [
    { candidate: 'om-fix-issue', query: '', hit: true },
    { candidate: 'om-fix-issue', query: 'fix', hit: true },
    { candidate: 'om-fix-issue', query: 'omfx', hit: true }, // subsequence
    { candidate: 'om-fix-issue', query: 'OMFX', hit: true }, // case-insensitive
    { candidate: 'om-fix-issue', query: 'xz', hit: false },
    { candidate: 'om-fix-issue', query: 'issuefix', hit: false }, // order matters
    { candidate: 'src/server/server.ts', query: 'srvts', hit: true },
  ]
  for (const { candidate, query, hit } of table) {
    it(`"${query}" ${hit ? 'finds' : 'does not find'} "${candidate}"`, () => {
      expect(fuzzyMatch(candidate, query)).toBe(hit)
    })
  }
})

describe('filterSkills (#380: filter without re-sorting — project-first survives any query)', () => {
  const skills = [
    skill({ name: 'global-deploy', source: 'global', description: 'Deploy from anywhere' }),
    skill({ name: 'project-deploy', source: 'ai' }),
    skill({ name: 'project-review', source: 'cezar', description: 'Review the diff' }),
  ]

  it('empty query keeps everything, project skills first', () => {
    expect(filterSkills(skills, '').map((s) => s.name)).toEqual([
      'project-deploy',
      'project-review',
      'global-deploy',
    ])
  })

  it('a query narrows but never reorders across the project/global split', () => {
    expect(filterSkills(skills, 'deploy').map((s) => s.name)).toEqual([
      'project-deploy',
      'global-deploy',
    ])
  })

  it('matches on the description as a fallback', () => {
    expect(filterSkills(skills, 'anywhere').map((s) => s.name)).toEqual(['global-deploy'])
  })

  it('no match → empty, never a throw', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([])
  })
})

describe('multiWordFilter (#411: multi-keyword search for cmdk)', () => {
  it('empty search matches everything (score 1)', () => {
    expect(multiWordFilter('skill om-auto-review-pr', '')).toBe(1)
    expect(multiWordFilter('skill om-auto-review-pr', '   ')).toBe(1)
  })

  it('"auto review" matches "om-auto-review-pr" in the value', () => {
    expect(multiWordFilter('skill om-auto-review-pr /path', 'auto review')).toBeGreaterThan(0)
  })

  it('"verify ui" matches via keywords (name parts)', () => {
    expect(
      multiWordFilter('skill om-auto-verify-pr-ui', 'verify ui', ['om', 'auto', 'verify', 'pr', 'ui']),
    ).toBeGreaterThan(0)
  })

  it('every word must match — partial hits return 0', () => {
    expect(multiWordFilter('skill om-fix /path', 'fix deploy')).toBe(0)
  })

  it('matching is case-insensitive', () => {
    expect(multiWordFilter('skill Deploy /path', 'DEPLOY')).toBeGreaterThan(0)
  })
})

describe('matchScore (#484: exact > prefix > word-boundary > substring > subsequence)', () => {
  it('ranks a stronger match higher', () => {
    expect(matchScore('review', 'review')).toBeGreaterThan(matchScore('review-prs', 'review')) // exact > prefix
    expect(matchScore('review-prs', 'review')).toBeGreaterThan(matchScore('om-code-review', 'review')) // prefix > boundary
    expect(matchScore('om-code-review', 'review')).toBeGreaterThan(matchScore('previewer', 'review')) // boundary > buried
    expect(matchScore('previewer', 'review')).toBeGreaterThan(matchScore('om-fix-issue', 'omfx')) // buried > subsequence
  })

  it('0 when the query cannot even be found as a subsequence', () => {
    expect(matchScore('om-fix-issue', 'zzz')).toBe(0)
  })

  it('empty query is a neutral match', () => {
    expect(matchScore('anything', '')).toBe(1)
  })
})

describe('#484: an (almost-)exact match sorts to the top', () => {
  it('multiWordFilter scores a whole-word hit above a buried substring, undiluted by value length', () => {
    // The bug: the old coverage ratio divided by the whole "skill <name> <path>" length, so a
    // near-exact match on a skill with a long path scored ~0.5 — same as a weak partial.
    const wholeWord = multiWordFilter('skill om-fix /very/long/path/to/skills/om-fix.md', 'fix', ['om', 'fix'])
    const buried = multiWordFilter('skill affix-tool /p', 'fix', ['affix', 'tool'])
    expect(wholeWord).toBeGreaterThan(buried)
    expect(buried).toBeGreaterThan(0) // still a match, just ranked lower
  })

  it('filterSkills ranks an exact name match above a merely-partial one, reordering input', () => {
    const skills = [
      skill({ name: 'om-code-review', source: 'ai' }), // 'review' is a whole word, mid-name
      skill({ name: 'review', source: 'ai' }), // exact match, but later in input order
    ]
    expect(filterSkills(skills, 'review').map((s) => s.name)).toEqual(['review', 'om-code-review'])
  })

  it('filterSkills ranks a prefix match above a word-boundary match', () => {
    const skills = [
      skill({ name: 'om-auto-deploy', source: 'ai' }), // boundary hit
      skill({ name: 'deploy-app', source: 'ai' }), // prefix hit
    ]
    expect(filterSkills(skills, 'deploy').map((s) => s.name)).toEqual(['deploy-app', 'om-auto-deploy'])
  })

  it('filterSkills keeps project-first order when matches are equally good', () => {
    const skills = [
      skill({ name: 'global-review', source: 'global' }),
      skill({ name: 'project-review', source: 'ai' }),
    ]
    // Both match 'review' as a word-boundary hit → tie → project (ai) stays first.
    expect(filterSkills(skills, 'review').map((s) => s.name)).toEqual(['project-review', 'global-review'])
  })
})

describe('skillKeywords', () => {
  it('splits hyphenated names into parts', () => {
    expect(skillKeywords('om-auto-review-pr')).toEqual(['om', 'auto', 'review', 'pr'])
  })

  it('includes the description when provided', () => {
    expect(skillKeywords('om-fix', 'Fix an issue')).toEqual(['om', 'fix', 'Fix an issue'])
  })

  it('works with a single-word name', () => {
    expect(skillKeywords('deploy', null)).toEqual(['deploy'])
  })
})

describe('skillUsedBy (the detail pane’s "Used by" breadcrumbs)', () => {
  const workflows: WorkflowDef[] = [
    {
      name: 'fix-and-verify',
      source: 'file',
      steps: [
        { id: 'fix', name: 'Fix', skill: 'om-fix' },
        { id: 'verify', skill: 'om-fix' }, // unnamed step → the id stands in
        { id: 'check', command: 'npm test' },
      ],
    },
    { name: 'ship-it', source: 'file', steps: [{ id: 'review', name: 'Review', skill: 'om-review' }] },
    { name: 'quick-task', source: 'built-in', steps: [] },
  ]

  it('lists every referencing step as "workflow › step", ids standing in for names', () => {
    expect(skillUsedBy(workflows, 'om-fix')).toEqual(['fix-and-verify › Fix', 'fix-and-verify › verify'])
    expect(skillUsedBy(workflows, 'om-review')).toEqual(['ship-it › Review'])
  })

  it('an unreferenced skill answers an empty list', () => {
    expect(skillUsedBy(workflows, 'om-unused')).toEqual([])
  })
})
