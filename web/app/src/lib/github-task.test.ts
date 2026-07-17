import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@/api/types'

import { MAX_CHAIN_STEPS, githubRunBody, githubTaskPrompt, skillChainSteps } from './github-task'

function item(overrides: Partial<GithubItem> = {}): GithubItem {
  return {
    kind: 'issue',
    number: 142,
    title: 'Login form drops session on refresh',
    author: 'ada',
    createdAt: '2026-07-09T08:00:00.000Z',
    labels: ['bug'],
    body: 'Repro: log in, hit reload.',
    url: 'https://github.com/acme/demo/issues/142',
    comments: 3,
    ...overrides,
  }
}

describe('githubTaskPrompt', () => {
  it('an issue reads "Fix GitHub issue", carries the URL, and quotes the body below a rule', () => {
    expect(githubTaskPrompt(item())).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142\n\n---\n\nRepro: log in, hit reload.',
    )
  })

  it('a PR reads "Address GitHub pull request"', () => {
    expect(githubTaskPrompt(item({ kind: 'pr', number: 7 }))).toContain(
      'Address GitHub pull request #7:',
    )
  })

  it('a blank body adds no rule section', () => {
    expect(githubTaskPrompt(item({ body: '  ' }))).not.toContain('---')
  })

  it('skill names append as a hint sentence', () => {
    expect(githubTaskPrompt(item(), ['om-fix', 'om-review'])).toContain(
      'Use these skills where relevant: om-fix, om-review.',
    )
  })
})

describe('skillChainSteps', () => {
  it('one {{task}} step per skill, in selection order', () => {
    expect(skillChainSteps(['om-fix', 'om-review'])).toEqual([
      { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
      { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
    ])
  })

  it('dedupes repeated ids the legacy way: om-fix, om-fix-2, om-fix-3', () => {
    expect(skillChainSteps(['om-fix', 'om-fix', 'om-fix']).map((step) => step.id)).toEqual([
      'om-fix',
      'om-fix-2',
      'om-fix-3',
    ])
  })

  it(`caps the chain at ${MAX_CHAIN_STEPS} steps`, () => {
    const names = Array.from({ length: 12 }, (_, i) => `skill-${i}`)
    expect(skillChainSteps(names)).toHaveLength(MAX_CHAIN_STEPS)
  })
})

describe('githubRunBody', () => {
  it('workflow selected → that workflow, skills as a prompt hint', () => {
    const body = githubRunBody(item(), 'ship-it', ['om-fix'])
    expect(body.workflow).toBe('ship-it')
    expect(body.steps).toBeUndefined()
    expect(body.task).toContain('Use these skills where relevant: om-fix.')
  })

  it('skills only → the skills ARE the chain, and the prompt carries no hint sentence', () => {
    const body = githubRunBody(item(), null, ['om-fix', 'om-review'])
    expect(body.workflow).toBeUndefined()
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix', 'om-review'])
    expect(body.task).not.toContain('Use these skills')
  })

  it('nothing selected → quick-task', () => {
    expect(githubRunBody(item(), null, []).workflow).toBe('quick-task')
  })

  it('a custom prompt replaces the auto task text but keeps the routing', () => {
    expect(githubRunBody(item(), null, [], 'Just triage this, do not fix.').task).toBe(
      'Just triage this, do not fix.',
    )
    // Routing is untouched: workflow run still names the workflow.
    const wf = githubRunBody(item(), 'ship-it', ['om-fix'], '  Investigate only.  ')
    expect(wf.workflow).toBe('ship-it')
    expect(wf.task).toBe('Investigate only.')
    // Empty/whitespace custom prompt → the default text.
    expect(githubRunBody(item(), null, [], '   ').task).toContain('Fix GitHub issue')
  })

  // #401 — the engine arg follows buildCreateRunBody's rules so the GitHub tab and the /new
  // composer send the same body for the same choice.
  describe('engine (#401)', () => {
    it('omitted → no runner/model at all (the pre-#401 body)', () => {
      const body = githubRunBody(item(), null, [])
      expect(body.runner).toBeUndefined()
      expect(body.model).toBeUndefined()
    })

    it('a multi-backend host sends both the runner and the model', () => {
      const body = githubRunBody(item(), 'ship-it', [], undefined, {
        runner: 'codex',
        model: 'gpt-5.1-codex',
        runnerCount: 2,
      })
      expect(body.runner).toBe('codex')
      expect(body.model).toBe('gpt-5.1-codex')
      expect(body.workflow).toBe('ship-it')
    })

    it('a single-backend host never sends a runner (composer rule)', () => {
      const body = githubRunBody(item(), null, [], undefined, {
        runner: 'claude',
        model: 'opus',
        runnerCount: 1,
      })
      expect(body.runner).toBeUndefined()
      expect(body.model).toBe('opus')
    })

    it("auto ('') stays implicit rather than shipping an empty model", () => {
      const body = githubRunBody(item(), null, [], undefined, {
        runner: 'codex',
        model: '',
        runnerCount: 2,
      })
      expect(body.model).toBeUndefined()
      expect(body.runner).toBe('codex')
    })

    it('rides along on the skills-as-chain route too, without disturbing it', () => {
      const body = githubRunBody(item(), null, ['om-fix', 'om-review'], undefined, {
        runner: 'opencode',
        model: 'anthropic/claude-sonnet-5',
        runnerCount: 3,
      })
      expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix', 'om-review'])
      expect(body.runner).toBe('opencode')
      expect(body.model).toBe('anthropic/claude-sonnet-5')
    })
  })
})
