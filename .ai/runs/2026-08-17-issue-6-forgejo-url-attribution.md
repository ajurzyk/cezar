# Execution plan — a Forgejo item URL must not satisfy `mentionsItem`

Issue: ajurzyk/cezar#6 (`bug`)

## Goal

Stop a hand-off prompt that carries only the item's **Forgejo URL** from silently losing the run's
issue/PR attribution: `mentionsItem` currently accepts "the text contains `item.url`" as proof the
reference round-trips, but `extractTaskRefs` tier 1 matches `github.com` URLs alone, so a Forgejo
URL suppresses the ref block and then carries nothing itself.

## Scope

The issue's **Decision** section picks the fix and this plan implements it verbatim — no second
host table, no re-deriving the choice:

- **Drop the URL shortcut** from `mentionsItem` (`packages/web/src/lib/github-task.ts:94`). The
  kind-qualified wording (`Fix Forgejo issue #24`) is forge-agnostic and already covers both
  spellings, so `mentionsItem`'s bar and `extractTaskRefs`'s recovery stay on **one** rule.
- **Delete the stale sentence** in `mentionsItem`'s doc block (`:84`, "either the item URL (its
  tier-1 match)"), which contradicts `githubTaskRef`'s own block one screen above (`:25`, "tier 1
  matches github.com URLs alone"). Two sentences in one file cannot both be true.

### Intended behaviour change

A prompt carrying **only** a `github.com` item URL and no wording now gets the ref block prepended,
where today it does not. That is strictly more attribution, never less, and it is the same bar
finding **F2** (upstream #541) set for a bare `#N`. `github-task.test.ts:146` pins the old
behaviour and is **rewritten** to expect `false`, not worked around.

Downstream, `hand-to-agent.tsx:301` derives `composesFreshRef` from `mentionsItem`, so a URL-only
prompt now holds the Run button until the forge is known. That is the correct consequence: the run
will compose a ref block, so the block's forge name must be settled before it is written.

## Non-goals

- No change to `extractTaskRefs` — its tiers stay exactly as they are. This issue moves
  `mentionsItem`'s bar down to what tier 1/2 can actually recover, not the other way round.
- No Forgejo URL tier in `task-refs.ts`. A Forgejo host is deployment-specific and unknowable from
  the prompt text; the wording is the forge-agnostic carrier and it already works.
- No route or wire-shape changes. The fix lives in `packages/web/src/lib/` plus the two test files.
- The other two Forgejo gaps (#7 link, #8 status) are out of scope; #6 is stated to go first.

## Baseline

Full suite green before any edit: **332 files / 6560 tests**, matching the count the issue states.

Recorded because it took one correction to get there: the agent runner sets `TMPDIR` **inside** the
cezar repo (`/srv/dev/cezar/.ai/cezar/tmp/<task-id>`), so six tests that build a temp dir and assert
"not a git repo" instead find cezar by walking up. Running with `TMPDIR=/tmp TMP=/tmp` is green;
this is an environment artifact of the runner, not a repository defect, and it is a *different*
cause from the known `CLAUDE_CONFIG_DIR` / `GIT_CONFIG_*` env leak (issue #17) which the configured
gate command already unsets.

## Implementation Plan

### Phase 1 — Red tests

Written first and confirmed failing against the unchanged implementation.

- `packages/web/src/lib/github-task.test.ts`, `describe('mentionsItem')`: a Forgejo item URL in the
  text does not satisfy `mentionsItem`; the kind-qualified wording still does; the `github.com`
  URL case at `:146` rewritten to expect `false`.
- Same file, the `composeGithubTask` block: a prompt carrying only the Forgejo URL gets the ref
  block prepended, and the composed task is one `extractTaskRefs` can read
  (`{issueNumber: N}` — the value the `github.com` control already answers).
- `packages/cezar/src/runs/task-refs.test.ts`: pin that a Forgejo item URL alone yields `{}`, not
  even `ambiguousNumber`, so the two files agree on where the bar sits.

### Phase 2 — Implementation

Delete the `text.includes(item.url)` line and the stale doc sentence; re-word the doc block so it
states the single surviving rule.

### Phase 3 — Full validation gate

Every command in `validation.commands`, plus a re-read of the diff for scope creep.

## Risks

- **A caller silently depending on the URL shortcut.** `mentionsItem` has exactly two consumers —
  `composeGithubTask` (same file) and `hand-to-agent.tsx:301` — both grepped and reasoned about
  above; the full suite is the check.
- **The seeded pre-filled box regressing.** It cannot: `githubTaskRef` emits the worded
  `Fix <Forge> issue #N`, which tier 2 recovers and the surviving wording branch matches. The
  shortcut was never what carried the default.
- **Duplicate ref blocks.** A prompt that carries both the URL and the wording still matches on the
  wording, so nothing is prepended twice.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

Phase 1 and Phase 2 share commit `2d9d3b60`: the tests were written and watched fail first
(5 failing, all for the expected reason — the ref block not prepended), but landing them as their
own commit would put a knowingly red commit in this repository's history, which its "a red suite is
a full stop" rule does not distinguish from a broken one.

### Phase 1: Red tests

- [x] 1.1 Pin in `task-refs.test.ts` that a Forgejo item URL alone recovers nothing — 2d9d3b60
- [x] 1.2 Rewrite the `mentionsItem` URL expectations in `github-task.test.ts` — 2d9d3b60
- [x] 1.3 Pin that a URL-only prompt composes a readable ref block — 2d9d3b60

### Phase 2: Implementation

- [x] 2.1 Drop the URL shortcut from `mentionsItem` and correct its doc block — 2d9d3b60

### Phase 3: Validation

- [x] 3.1 Run the full validation gate and re-read the diff — 2d9d3b60

## Outcome

All five `validation.commands` green, run with `TMPDIR=/tmp TMP=/tmp` for the reason recorded
under **Baseline**:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 332 files / **6567** tests — baseline 6560 plus exactly the 7 cases added here |
| `npm run test:unit` | 36 passed |
| `npm run build` | built; `check:pack ok — 487 files` |
| `npm run test:package` | 15 passed |

Acceptance criterion from the issue, verified by test `a Forgejo item URL in the prompt still gets
the ref block, and it is readable`:
`extractTaskRefs(composeGithubTask(item, [], '<forgejo item url> to develop', 'forgejo'))` answers
`{issueNumber: 24}` — the same value the `github.com` control already answered.

Final diff: 3 files, one deleted line of production code
(`if (text.includes(item.url)) return true`), its doc block rewritten, and 7 new test cases. One
stale parenthetical in `github-task.test.ts` ("the URL is right there") was corrected to name the
wording, since that is now what makes `mentionsItem` match a seeded ref block.
