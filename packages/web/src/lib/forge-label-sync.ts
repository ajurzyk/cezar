import type { ForgeInfo } from '@open-mercato/cezar-api-client'

/**
 * The policy behind the forge tab's "Sync labels" button (#47) — one pure function of forge state
 * deciding whether the button exists at all, whether it is pressable, and what target a press will
 * name. The header renders whatever this returns and nothing else, the same split `git-actions.ts`
 * uses: the rules live here, where a table test can pin every row.
 *
 * WHY THE BUTTON PROVISIONS LABELS AT ALL. The `om-*` claim/lock protocol and the review signalling
 * run on labels, not comments. A label that does not exist makes every mutation of it a logged
 * skip, so the protocol silently stops working while every step still reports success — and a run
 * cannot bootstrap the labels it is already trying to use, which is what makes this a cockpit
 * action rather than something a run does for itself.
 *
 * WHY GITHUB IS HIDDEN AND NOT DISABLED. GitHub provisions its taxonomy with
 * `.ai/scripts/labels-sync.sh`, which #47 leaves byte for byte. A disabled button explaining a
 * shell script the cockpit cannot run is clutter on the upstream path; hiding it is what keeps this
 * change costing the GitHub path zero pixels, the same doctrine `forge-label.ts` states for every
 * other forge-kind default. Every OTHER unusable state is visible-and-disabled with a reason,
 * because there the button IS the right thing to press once the state is fixed.
 */

export interface LabelSyncState {
  /** `/api/v1/health` `forge` — null means no supported forge remote. */
  forge: ForgeInfo | null
  /** `owner/repo` from the forge list payload; undefined until it answers. */
  repo?: string
  /** A sync is already in flight. */
  pending: boolean
}

export type LabelSyncAction =
  | { visible: false }
  | { visible: true; enabled: false; label: string; reason: string }
  | { visible: true; enabled: true; label: string; target: string }

const LABEL = 'Sync labels'

export function labelSyncAction(state: LabelSyncState): LabelSyncAction {
  if (state.forge === null || state.forge.kind !== 'forgejo') return { visible: false }

  const disabled = (reason: string): LabelSyncAction => ({ visible: true, enabled: false, label: LABEL, reason })

  // `available` is OPTIONAL in the DTO — absent until the probe warms — so absent must read as
  // "not yet", never as "yes". Treating it as available would let the first click race the probe.
  if (state.forge.available !== true) {
    return disabled(`${LABEL} unavailable — ${state.forge.reason ?? 'the forge is unreachable'}`)
  }
  // No target, no click. The server requires an explicit `owner/repo` and refuses one that does
  // not match the project's own remote, so a button that fired without one could only be guessing —
  // and guessing at the target is precisely what PR #16 removed from the GitHub path.
  if (!state.repo) return disabled(`${LABEL} unavailable — the target repository is not known yet`)
  if (state.pending) return disabled(`${LABEL} unavailable — a sync is already running`)

  return { visible: true, enabled: true, label: LABEL, target: state.repo }
}
