import type { ForgeLabelSpec } from './types.ts';

/**
 * The pipeline label taxonomy, compiled in.
 *
 * The `om-*` skills' claim/lock protocol and their review signalling do not run on comments — they
 * run on LABELS. A label that does not exist makes every mutation of it a logged skip, so the
 * protocol silently stops working while every individual step still reports success. `in-progress`
 * is the sharpest case: it is one of the three claim signals, so without it a second run cannot
 * detect that a first one already owns the item.
 *
 * WHY THIS IS A COPY, AND WHY THAT IS DELIBERATE. The same 27 names live in
 * `.ai/agentic.config.json` (the set) and in `label_meta()` (`.ai/scripts/labels-sync.sh:60-91`,
 * the colours and descriptions). Neither is reachable from here at run time:
 *
 *   - The repository cezar PROVISIONS labels into is not where cezar's pipeline configuration
 *     belongs, so it cannot be asked to declare its own taxonomy.
 *   - Reading `ajurzyk/cezar`'s config back over the wire would need an authenticated `gh` inside
 *     a run's worktree, which is exactly the network dependency this table exists to remove.
 *
 * So the copy is the design, and `label-taxonomy.test.ts` is its price: that test reads both files
 * and fails the moment any of the three drifts. Extend the taxonomy in
 * `.ai/agentic.config.json` + `label_meta()` first; this table follows, and the guard says so.
 *
 * Order matters and mirrors `labels-sync.sh` exactly — the five config groups in declaration
 * order, then `do-not-close`. That last one lives OUTSIDE the config taxonomy on purpose (humans
 * apply it, skills only read it: `om-close-fixed-issues`, `om-auto-manage-issues`) but still has to
 * exist to be usable, which is why the GitHub script appends it too (`labels-sync.sh:136`).
 *
 * Colours are stored `#`-less, six lowercase hex digits. Forgejo accepts either form and always
 * answers WITHOUT the `#` (measured on http://q7010-dev:8929, 2026-08-26), so this spelling is what
 * lets a drift comparison against a read-back label be a plain string equality.
 */
export const PIPELINE_LABEL_TAXONOMY: readonly ForgeLabelSpec[] = [
  // pipeline — the state machine a PR walks through
  { name: 'review', color: '0366d6', description: 'Ready for code review' },
  { name: 'changes-requested', color: 'b60205', description: 'Reviewer requested changes' },
  { name: 'qa', color: 'fbca04', description: 'Manual QA in progress' },
  { name: 'qa-failed', color: 'b60205', description: 'Manual QA failed' },
  { name: 'merge-queue', color: '0e8a16', description: 'Approved, ready to merge' },
  { name: 'blocked', color: 'b60205', description: 'Blocked by a dependency' },
  { name: 'do-not-merge', color: 'b60205', description: 'Hard merge block' },
  // category — what kind of change it is
  { name: 'bug', color: 'd73a4a', description: 'Bug fix' },
  { name: 'feature', color: 'a2eeef', description: 'New capability' },
  { name: 'refactor', color: 'cfd3d7', description: 'No behavior change' },
  { name: 'security', color: 'b60205', description: 'Security-relevant change' },
  { name: 'dependencies', color: '0366d6', description: 'Dependency update' },
  { name: 'documentation', color: '0075ca', description: 'Docs only' },
  // meta — signals between skills, orthogonal to the pipeline state
  { name: 'needs-qa', color: 'fbca04', description: 'Requires manual QA before merge' },
  { name: 'skip-qa', color: '0e8a16', description: 'Low risk, QA not required' },
  { name: 'qa-approved', color: '0e8a16', description: 'Manual QA passed' },
  { name: 'qa-self-verified', color: 'c5def5', description: 'Self-QA exception used' },
  { name: 'in-progress', color: 'c5def5', description: 'An automated skill is working on this' },
  { name: 'ci-monitoring', color: 'd4c5f9', description: 'Work complete and reported; agent is watching CI results' },
  // priority — exactly one per item
  { name: 'priority-low', color: 'e4e669', description: 'Cosmetic or follow-up work' },
  { name: 'priority-medium', color: 'fbca04', description: 'Ordinary bug or feature' },
  { name: 'priority-high', color: 'd93f0b', description: 'Release-blocking' },
  { name: 'priority-extreme', color: 'b60205', description: 'Outage or security incident' },
  // risk — exactly one per item
  { name: 'risk-low', color: '0e8a16', description: 'Isolated, low blast radius' },
  { name: 'risk-medium', color: 'fbca04', description: 'Ordinary change with tests' },
  { name: 'risk-high', color: 'b60205', description: 'Wide blast radius, review deeply' },
  // outside the config taxonomy — humans apply it, skills only read it
  { name: 'do-not-close', color: 'c5def5', description: 'Humans only: never auto-close this issue' },
];
