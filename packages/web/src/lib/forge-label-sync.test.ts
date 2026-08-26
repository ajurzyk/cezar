import { describe, expect, it } from 'vitest'
import type { ForgeInfo } from '@open-mercato/cezar-api-client'
import { labelSyncAction } from './forge-label-sync'

/**
 * The policy behind the forge tab's "Sync labels" button (#47) — one pure function of forge state,
 * table-tested here so the header stays a dumb projector (the same split `git-actions.ts` uses).
 *
 * The GitHub path is HIDDEN rather than disabled, and that is the load-bearing row. GitHub
 * provisions its taxonomy with `.ai/scripts/labels-sync.sh`, which this change leaves byte for
 * byte; a disabled button explaining a shell script the cockpit cannot run is clutter on the
 * upstream path, and the point of `visible` is that the upstream path costs zero pixels. Every
 * OTHER unusable state is visible-and-disabled with a reason, because there the button is the
 * right thing to press once the state is fixed.
 */

const forgejo = (over: Partial<ForgeInfo> = {}): ForgeInfo => ({ kind: 'forgejo', available: true, ...over })

describe('labelSyncAction', () => {
  it('is enabled, naming the target, for a reachable Forgejo project', () => {
    expect(labelSyncAction({ forge: forgejo(), repo: 'ajr/orakton', pending: false })).toEqual({
      visible: true,
      enabled: true,
      label: 'Sync labels',
      target: 'ajr/orakton',
    })
  })

  it('is hidden for a GitHub project', () => {
    expect(labelSyncAction({ forge: { kind: 'github', available: true }, repo: 'acme/demo', pending: false })).toEqual({
      visible: false,
    })
  })

  it('is hidden when the repo has no supported forge at all', () => {
    expect(labelSyncAction({ forge: null, repo: undefined, pending: false })).toEqual({ visible: false })
  })

  it('is disabled while the forge is unreachable, quoting its own reason', () => {
    const action = labelSyncAction({
      forge: forgejo({ available: false, reason: 'CEZ_FORGEJO_TOKEN was rejected by Forgejo' }),
      repo: 'ajr/orakton',
      pending: false,
    })
    expect(action).toMatchObject({ visible: true, enabled: false })
    expect(action).toHaveProperty('reason', expect.stringContaining('CEZ_FORGEJO_TOKEN was rejected by Forgejo'))
  })

  it('is disabled while availability is still unknown', () => {
    // `available` is optional in the DTO — absent until the probe warms. Treating absent as
    // available would let the first click race the probe.
    expect(labelSyncAction({ forge: { kind: 'forgejo' }, repo: 'ajr/orakton', pending: false })).toMatchObject({
      visible: true,
      enabled: false,
    })
  })

  it('is disabled until the target repository is known', () => {
    // No target, no click: the server requires an explicit `owner/repo` and refuses a mismatch, so
    // a button that fired without one could only ever be guessing.
    const action = labelSyncAction({ forge: forgejo(), repo: undefined, pending: false })
    expect(action).toMatchObject({ visible: true, enabled: false })
    expect(action).toHaveProperty('reason', expect.stringContaining('repository'))
  })

  it('is disabled while a sync is already in flight', () => {
    expect(labelSyncAction({ forge: forgejo(), repo: 'ajr/orakton', pending: true })).toMatchObject({
      visible: true,
      enabled: false,
    })
  })
})
