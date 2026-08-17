import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@open-mercato/cezar-api-client'

import { extractTaskRefs } from '../../../cezar/src/runs/task-refs'

import {
  MAX_CHAIN_STEPS,
  applyItemTokens,
  composeGithubTask,
  githubRunBody,
  githubTaskPrompt,
  githubTaskRef,
  mentionsItem,
  skillChainSteps,
} from './github-task'

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

  it('a custom prompt EXTENDS the task context rather than replacing it (#524)', () => {
    const body = githubRunBody(item(), null, [], 'Just triage this, do not fix.')
    // The user's words survive…
    expect(body.task).toContain('Just triage this, do not fix.')
    // …and so does the reference that makes them actionable.
    expect(body.task).toContain('#142')
    expect(body.task).toContain('https://github.com/acme/demo/issues/142')
  })

  it('routing is untouched, and the skills hint still rides along on the workflow branch', () => {
    const wf = githubRunBody(item(), 'ship-it', ['om-fix'], '  Investigate only.  ')
    expect(wf.workflow).toBe('ship-it')
    expect(wf.steps).toBeUndefined()
    expect(wf.task).toContain('Investigate only.')
    expect(wf.task).toContain('#142')
    expect(wf.task).toContain('Use these skills where relevant: om-fix.')

    // The skills-ARE-the-chain branch keeps carrying no hint sentence.
    const chain = githubRunBody(item(), null, ['om-fix'], 'Investigate only.')
    expect(chain.steps?.map((step) => step.skill)).toEqual(['om-fix'])
    expect(chain.task).not.toContain('Use these skills')
  })

  it('a whitespace-only custom prompt is byte-for-byte the default text', () => {
    expect(githubRunBody(item(), null, [], '   ').task).toBe(githubRunBody(item(), null, []).task)
    expect(githubRunBody(item(), null, [], undefined).task).toBe(githubTaskPrompt(item()))
  })
})

describe('githubTaskRef', () => {
  it('is the identity only — no quoted body, no skills hint (#524)', () => {
    expect(githubTaskRef(item())).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142',
    )
    expect(githubTaskRef(item())).not.toContain('Repro:')
  })

  it('a PR reads "Address GitHub pull request"', () => {
    expect(githubTaskRef(item({ kind: 'pr', number: 7 }))).toContain(
      'Address GitHub pull request #7:',
    )
  })
})

describe('mentionsItem', () => {
  it('matches the KIND-qualified wording task-refs keys on', () => {
    expect(mentionsItem('port issue #142 to develop', item())).toBe(true)
    expect(mentionsItem('port ISSUE 142 to develop', item())).toBe(true)
    const pr = item({ kind: 'pr', number: 77, url: 'https://github.com/acme/demo/pull/77' })
    expect(mentionsItem('rebase PR #77', pr)).toBe(true)
    expect(mentionsItem('rebase pull request 77', pr)).toBe(true)
  })

  it('a BARE #N is not enough — extractTaskRefs could only call it ambiguous', () => {
    expect(mentionsItem('port #142 to develop', item())).toBe(false)
  })

  // The Forgejo half of #6, and the reason the item URL is no longer a match at all. Tier 1 of
  // `task-refs.ts` is spelled `github.com`, so a Forgejo URL is recovered by NOTHING there — not
  // even as `ambiguousNumber`, since a URL carries no `#`. Accepting it here would suppress the
  // ref block and leave the URL carrying no attribution in its place: no chip, no `#N` title
  // prefix, nothing to recover from the task text.
  it('an item URL on a non-GitHub forge is not a durable reference', () => {
    const forgejo = item({ url: 'http://forge.internal:3000/ajr/orakton/issues/24', number: 24 })
    expect(mentionsItem('port http://forge.internal:3000/ajr/orakton/issues/24 to develop', forgejo))
      .toBe(false)
    // The kind-qualified wording still carries it — that is the forge-agnostic route, and it is
    // what `githubTaskRef` emits, so the pre-filled box is unaffected.
    expect(mentionsItem('port Forgejo issue #24 to develop', forgejo)).toBe(true)
  })

  // Deliberately NOT special-cased back to `true` for github.com. One rule beats a host table:
  // `mentionsItem`'s bar is the kind-qualified wording, on every forge. This changes GitHub
  // behaviour in one observable direction — a prompt carrying only the item URL now gets the ref
  // block prepended, where it previously did not. That is strictly more attribution, never less,
  // and it is the same bar F2 (open-mercato/cezar#541) set for a bare `#N`.
  it('a github.com item URL is not enough either — the bar is one rule, not a host table', () => {
    expect(mentionsItem('see https://github.com/acme/demo/issues/142 first', item())).toBe(false)
  })

  it('the wrong kind does not count either', () => {
    // "PR 142" on an ISSUE hand-off would make task-refs record a prNumber, not an issueNumber.
    expect(mentionsItem('port PR 142 to develop', item())).toBe(false)
  })

  it('a longer number that merely starts with N does not count', () => {
    expect(mentionsItem('port issue #1420 to develop', item())).toBe(false)
    expect(mentionsItem('port issue #14 to develop', item())).toBe(false)
  })

  it('the exact prompt from the bug report mentions nothing', () => {
    expect(mentionsItem('Port this one to develop and close original PR', item())).toBe(false)
  })
})

describe('applyItemTokens', () => {
  it('substitutes {{number}}, {{title}} and {{url}}, case- and space-insensitively', () => {
    expect(applyItemTokens('rebase {{number}} onto develop', item())).toBe(
      'rebase #142 onto develop',
    )
    expect(applyItemTokens('{{ TITLE }} / {{url}}', item())).toBe(
      'Login form drops session on refresh / https://github.com/acme/demo/issues/142',
    )
  })

  it('leaves text with no tokens alone', () => {
    expect(applyItemTokens('nothing to see', item())).toBe('nothing to see')
  })

  it('a `$` in the title is literal, not a replacement pattern', () => {
    // `$&`, `$$`, `` $` ``, `$'` and `$1` are special in a replacement STRING. An issue title is
    // arbitrary user text, so substitution must go through a replacer function.
    const dollars = item({ title: "Cost $$ doubled, $& broke, $1 off, $` and $'" })
    expect(applyItemTokens('{{title}}', dollars)).toBe(dollars.title)
  })
})

describe('composeGithubTask', () => {
  it('prepends the ref block when the prompt does not carry the reference', () => {
    expect(composeGithubTask(item(), [], 'Port this one to develop and close original PR')).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142\n\n' +
        'Port this one to develop and close original PR',
    )
  })

  it('does NOT duplicate the ref when the prompt already carries it — e.g. the pre-filled box', () => {
    const base = githubTaskRef(item())
    expect(composeGithubTask(item(), [], base)).toBe(base)
    expect(composeGithubTask(item(), [], `${base}\n\nAlso add tests.`)).toBe(
      `${base}\n\nAlso add tests.`,
    )
  })

  it('a token-substituted BARE #N still gets the ref block — it is not a durable reference', () => {
    expect(composeGithubTask(item(), [], 'rebase {{number}} onto develop')).toBe(
      `${githubTaskRef(item())}\n\nrebase #142 onto develop`,
    )
  })

  // #6 end to end: the two ways a prompt comes to carry the item URL *instead of* the wording —
  // the supported `{{url}}` token in a saved prompt template, and a user pasting the link. On a
  // Forgejo item the URL is recoverable by nothing (`task-refs.ts` tier 1 is `github.com`), so
  // suppressing the ref block for it left the run with no attribution at all.
  it('a Forgejo item URL in the prompt still gets the ref block, and it is readable', () => {
    const forgejo = item({ url: 'http://forge.internal:3000/ajr/orakton/issues/24', number: 24 })
    const ref = githubTaskRef(forgejo, 'forgejo')

    for (const prompt of ['port {{url}} to develop', `port ${forgejo.url} to develop`]) {
      const task = composeGithubTask(forgejo, [], prompt, 'forgejo')
      expect(task).toBe(`${ref}\n\nport ${forgejo.url} to develop`)
      // The value the github.com control has always answered — the point of the whole fix.
      expect(extractTaskRefs(task)).toEqual({ issueNumber: 24 })
    }
  })

  // Same shape for a PR, where the wording tier the ref block relies on is the other one.
  it('a Forgejo PR URL composes a ref block task-refs reads as a prNumber', () => {
    const forgejo = item({
      kind: 'pr',
      number: 12,
      url: 'http://forge.internal:3000/ajr/orakton/pulls/12',
    })
    const task = composeGithubTask(forgejo, [], `rebase ${forgejo.url}`, 'forgejo')
    expect(task).toBe(`${githubTaskRef(forgejo, 'forgejo')}\n\nrebase ${forgejo.url}`)
    expect(extractTaskRefs(task).prNumber).toBe(12)
  })

  // The GitHub side of the same rule. Previously this prompt was handed over verbatim; the ref
  // block it now carries is redundant with the URL for `extractTaskRefs`, but it is what keeps
  // one rule instead of two — and it adds the title and the kind wording besides.
  it('a github.com item URL alone now gets the ref block too', () => {
    const task = composeGithubTask(item(), [], `see ${item().url} first`)
    expect(task).toBe(`${githubTaskRef(item())}\n\nsee ${item().url} first`)
    expect(extractTaskRefs(task).issueNumber).toBe(142)
  })

  // The guard against the obvious over-correction: a prompt carrying BOTH still matches on the
  // wording, so nothing is prepended and the block is not duplicated.
  it('does not duplicate the ref when the prompt carries both the URL and the wording', () => {
    const task = composeGithubTask(item(), [], `see ${item().url}, i.e. issue #142`)
    expect(task).toBe(`see ${item().url}, i.e. issue #142`)
  })

  it('a token inside the ITEM TITLE is never rewritten inside our own ref block', () => {
    const tokenTitle = item({ title: 'Support {{url}} in prompt templates' })
    const base = githubTaskRef(tokenTitle)
    expect(composeGithubTask(tokenTitle, [], `${base}\n\nUse {{url}} please.`)).toBe(
      `${base}\n\nUse ${tokenTitle.url} please.`,
    )
  })

  // The guard above compares the text against the ref for the kind known AT SUBMIT TIME. A box
  // seeded with the OTHER spelling — a draft stored before the registry answered, which
  // `hand-to-agent.tsx` persists per item — then falls through to the plain branch, and the
  // title's token is rewritten inside our own quoted ref after all.
  it('recognizes its own ref block even when the box was seeded with another forge’s name', () => {
    const tokenTitle = item({ title: 'Support {{url}} in prompt templates' })
    const seeded = githubTaskRef(tokenTitle, 'github')
    expect(composeGithubTask(tokenTitle, [], `${seeded}\n\nUse {{url}} please.`, 'forgejo')).toBe(
      `${githubTaskRef(tokenTitle, 'forgejo')}\n\nUse ${tokenTitle.url} please.`,
    )
  })

  // Recognizing the stale block is only half the job: it must also be REPLACED. The box is
  // pre-filled, so extending it is the normal edit — a cold deep link to a Forgejo issue seeds
  // "Fix GitHub issue #142" before the registry answers, the user appends a sentence, and
  // `hand-to-agent.tsx` then leaves their touched text alone by design. `mentionsItem` matches
  // (the block's own "issue #142" wording), so nothing prepends the corrected ref. Re-emitting the seeded
  // block verbatim would hand the agent "Fix GitHub issue #142" about a Forgejo issue — the
  // false instruction this stage exists to remove.
  it('rewrites a stale forge name in the seeded ref block the user extended', () => {
    const it142 = item()
    const seeded = githubTaskRef(it142, 'github')
    const task = composeGithubTask(it142, [], `${seeded}\n\nand add tests`, 'forgejo')
    expect(task).toBe(`${githubTaskRef(it142, 'forgejo')}\n\nand add tests`)
    expect(task).not.toContain('GitHub')
  })

  // The other direction of the same rewrite: silence is not an answer of "GitHub". The box's draft
  // is stored per item URL (`hand-to-agent.tsx`), so it outlives a page refresh — reopen a Forgejo
  // item and hit ⌘Enter while `/api/v1/projects` is still in flight and `forge` arrives
  // `undefined` (the run body passes `kind`, not `settled`). Rewriting the block to
  // `forgeLabel(undefined)` would turn a correct "Fix Forgejo issue #142" into the false
  // "Fix GitHub issue #142" — the very instruction this rewrite exists to remove.
  it('keeps the seeded block verbatim while no forge has been named', () => {
    const it142 = item()
    const seeded = githubTaskRef(it142, 'forgejo')
    const task = composeGithubTask(it142, [], `${seeded}\n\nand add tests`, undefined)
    expect(task).toBe(`${seeded}\n\nand add tests`)
    expect(task).not.toContain('GitHub issue')
  })

  // The token shield covers this path too: a matched block is OURS whether or not we rewrite it,
  // so a `{{url}}` embedded in the item's own title must not be substituted inside it.
  it('still shields the seeded block from token substitution when no forge has been named', () => {
    const tokenTitle = item({ title: 'Support {{url}} in prompt templates' })
    const seeded = githubTaskRef(tokenTitle, 'forgejo')
    expect(composeGithubTask(tokenTitle, [], `${seeded}\n\nUse {{url}} please.`, undefined)).toBe(
      `${seeded}\n\nUse ${tokenTitle.url} please.`,
    )
  })

  it('puts the user instruction LAST, after the context', () => {
    const task = composeGithubTask(item(), [], 'Only triage.')
    expect(task.indexOf('#142')).toBeLessThan(task.indexOf('Only triage.'))
  })
})

// The regex contract from the issue's follow-up comment: `src/runs/task-refs.ts` recovers a run's
// PR/issue attribution by scanning the task TEXT — there is no structured field to fall back on.
// Pinning it here means a future change to the composition order or separator cannot silently
// cost every custom-prompt run its chip and its `#N` title prefix.
describe('extractTaskRefs over composed hand-off text', () => {
  it('a custom prompt still yields the issue number', () => {
    const task = composeGithubTask(item(), [], 'Port this one to develop and close original PR')
    expect(extractTaskRefs(task).issueNumber).toBe(142)
  })

  it('a custom prompt still yields the PR number', () => {
    const pr = item({ kind: 'pr', number: 77, url: 'https://github.com/acme/demo/pull/77' })
    const task = composeGithubTask(pr, [], 'Port this one to develop and close original PR')
    expect(extractTaskRefs(task).prNumber).toBe(77)
  })

  it('the pre-filled box text alone is enough', () => {
    expect(extractTaskRefs(githubTaskRef(item())).issueNumber).toBe(142)
  })

  it('a prompt keeping only a bare #N still recovers the KIND, not just an ambiguous number', () => {
    // The regression F2 guards: `mentionsItem` must not accept a bare `#142` as a durable
    // reference, because `extractTaskRefs` can only call it `ambiguousNumber` — no chip, no
    // `#N` title prefix. Trimming the pre-filled box to this is an ordinary edit.
    const task = composeGithubTask(item(), [], 'port #142 to develop')
    expect(extractTaskRefs(task).issueNumber).toBe(142)
    expect(extractTaskRefs(task).ambiguousNumber).toBeUndefined()
  })
})

// #401 — the backend pair arrives pre-shaped from engineBody (components/engine-pills),
// which owns the omit rules; this builder's only job is to spread it onto every route.
describe('githubRunBody backend (#401)', () => {
  it('omitted → no runner/model at all (the pre-#401 body)', () => {
    const body = githubRunBody(item(), null, [])
    expect(body.runner).toBeUndefined()
    expect(body.model).toBeUndefined()
  })

  it('rides the workflow route', () => {
    const body = githubRunBody(item(), 'ship-it', [], undefined, {
      runner: 'codex',
      model: 'gpt-5.1-codex',
    })
    expect(body).toMatchObject({ workflow: 'ship-it', runner: 'codex', model: 'gpt-5.1-codex' })
  })

  it('rides the skills-as-chain route without disturbing the steps', () => {
    const body = githubRunBody(item(), null, ['om-fix', 'om-review'], undefined, {
      runner: 'opencode',
      model: 'anthropic/claude-sonnet-5',
    })
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix', 'om-review'])
    expect(body).toMatchObject({ runner: 'opencode', model: 'anthropic/claude-sonnet-5' })
  })

  it('rides the quick-task route, and an all-undefined pair leaves the body clean', () => {
    expect(githubRunBody(item(), null, [], undefined, { runner: 'codex' })).toMatchObject({
      workflow: 'quick-task',
      runner: 'codex',
    })
    // engineBody returns explicit undefineds for "send nothing" — they must not become keys
    // with values, and JSON.stringify drops them on the wire.
    const clean = githubRunBody(item(), null, [], undefined, {
      runner: undefined,
      model: undefined,
    })
    expect(JSON.parse(JSON.stringify(clean))).not.toHaveProperty('runner')
    expect(JSON.parse(JSON.stringify(clean))).not.toHaveProperty('model')
  })
})

/**
 * Stage 4 (spec 2026-08-14-forgejo-forge-support): the ref block is an INSTRUCTION sent to an
 * agent, not a label on a screen — telling
 * an agent to "fix GitHub issue #24" when the issue lives on Forgejo is simply false.
 *
 * What is load-bearing here is the SHAPE, not the forge's name: `extractTaskRefs`
 * (packages/cezar/src/runs/task-refs.ts) recovers a run's PR/issue attribution from the words
 * "issue"/"pull request" and the `#N`, both of which survive the rename. Its tier-1 URL patterns
 * are github.com-only, so on Forgejo the worded tier is the ONLY thing carrying attribution.
 */
describe('the forge name in the ref block', () => {
  it('names Forgejo for a Forgejo issue', () => {
    expect(githubTaskRef(item(), 'forgejo')).toContain('Fix Forgejo issue #142:')
  })

  it('names Forgejo for a Forgejo pull request', () => {
    expect(githubTaskRef(item({ kind: 'pr', number: 7 }), 'forgejo'))
      .toContain('Address Forgejo pull request #7:')
  })

  it('still says GitHub with no kind — every existing caller is unchanged', () => {
    expect(githubTaskRef(item())).toContain('Fix GitHub issue #142:')
    expect(githubTaskRef(item(), 'github')).toBe(githubTaskRef(item()))
  })

  it('carries the forge name through every prompt the tab can send', () => {
    expect(githubTaskPrompt(item(), [], 'forgejo')).toContain('Fix Forgejo issue #142:')
    expect(composeGithubTask(item(), [], 'rebase this onto develop', 'forgejo'))
      .toContain('Fix Forgejo issue #142:')
    const body = githubRunBody(item(), null, [], undefined, {}, 'forgejo')
    expect(body.task).toContain('Fix Forgejo issue #142:')
  })

  // The reason the rename is safe at all — asserted against the real extractor, not a comment.
  // A Forgejo URL matches none of its tier-1 patterns, so the worded tier is all there is.
  it('still gives extractTaskRefs the attribution it keys on', () => {
    const issue = item({ url: 'http://forge.internal:3000/acme/demo/issues/142' })
    expect(extractTaskRefs(githubTaskRef(issue, 'forgejo')).issueNumber).toBe(142)
    const pr = item({ kind: 'pr', number: 7, url: 'http://forge.internal:3000/acme/demo/pulls/7' })
    expect(extractTaskRefs(githubTaskRef(pr, 'forgejo')).prNumber).toBe(7)
  })
})
