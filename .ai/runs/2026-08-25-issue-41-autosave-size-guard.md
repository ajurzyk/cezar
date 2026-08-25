# Run plan — autosave size guard (issue #41)

**Issue:** ajurzyk/cezar#41 — `runner: autosaveCommit stages with git add -A, so any large unignored
artefact lands permanently in the run branch`
**Branch:** `fix/issue-41-autosave-size-guard`
**Base:** `origin/main` @ `d9138585`
**Engine:** om-auto-create-pr (steps: 8, `--loop`: no)

## Goal

Stop `autosaveCommit` from sweeping a large *new* file into the run branch, without ever losing the
recovery point: hold the oversized paths back out of the index and commit everything else.

## Scope

- `packages/cezar/src/git-worktree.ts` — a size guard placed **after** `git add -A` (`:332`) and
  **before** `git commit` (`:341`).
- `packages/cezar/src/autosave-size-guard.test.ts` — new sibling of
  `autosave-conflict-guard.test.ts`, five named cases.
- This plan under `.ai/runs/`.

### Non-goals (explicitly not touched)

- The conflict guard (`git-worktree.ts:323-331`) and its `'refused'` outcome.
- The identity fallback (`:333-340`).
- `AutosaveReason` (`:258`) — this is not about *when* an autosave fires.
- `commitAll` (`server/git-changes.ts:666`) — the cockpit's explicit staging path.
- `ensureDataGitignore` (`index.ts:664-694`); the repository's own `.gitignore` (adding `core*` would
  close one occurrence and leave the mechanism open).

## Measurements taken before writing code (2026-08-25)

| What | Command | Result |
|---|---|---|
| Baseline before any edit | `bash .../gates/baseline.sh` | `Test Files 335 passed (335)`, `Tests 6597 passed (6597)`, 71.2 s |
| New-vs-HEAD listing survives dirs, spaces, `-N` | `git add -A && git diff --cached --name-only --diff-filter=A -z` | lists `core.big`, `junkdir/core.2`, `junkdir/sub/core.1`, `we ird.txt` individually, unquoted |
| A plain pathspec **globs** | `git reset -q -- 'a*.txt'` in a repo holding `a*.txt`, `ab.txt`, `ac.txt` | unstaged **all three** |
| `:(literal)` does not | `git reset -q -- ':(literal)a*.txt'` | unstaged only `a*.txt`; `ab.txt`/`ac.txt` stayed `A ` |
| Largest tracked file in this repo | `git ls-files -z \| xargs -0 stat -c %s \| sort -rn \| head -1` | `565014` B (`docs/screenshots/task-view.png`) |

## Design decisions

- **Injection: an optional third parameter** on `autosaveCommit`, defaulting to an exported constant.
  A `CEZ_*` variable was rejected because it is read from ambient process state (order-dependent in a
  parallel vitest run) and would let a stray env var silently disable the guard in production; an
  exported constant alone would force tests to write tens of megabytes. Widening the signature breaks
  no caller — all five pass two arguments.
- **`AutosaveResult` (`:267`) stays as-is.** The held-back paths are reported through the existing
  `console.warn` channel, so the `=== 'refused'` / `=== 'failed'` comparisons in
  `server/forge/github.ts:2061`,`:2067` and `server/forge/forgejo.ts:1305`,`:1308` keep compiling
  untouched.
- **`lstat`, not `stat`** — git stores a symlink's *target path*, a few bytes; following the link
  would hold back a symlink that costs the branch nothing.
- **`:(literal)` pathspec on the `reset`** — measured above.
- Empty index after the hold-back returns `'nothing-to-do'`, never `'failed'`.

## Risks

- Holding a path back leaves it in the worktree, so the `periodic` flush warns about it every tick.
  Accepted by the issue as "repeated warnings are acceptable".
- The guard fails **open**: an unreadable path or a failed `git diff --cached` leaves the old
  `add -A` behaviour, matching the conflict guard's own posture.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Red-first test and the guard

- [ ] 1.1 Add `autosave-size-guard.test.ts` with case 1 and watch it fail
- [ ] 1.2 Implement the size guard in `autosaveCommit`

### Phase 2: The remaining four cases

- [ ] 2.1 Cases 2–5 (tracked-file growth, named paths, unchanged happy path, `nothing-to-do`)

### Phase 3: Evidence

- [ ] 3.1 Red-first reproduction by base revision (`git checkout origin/main -- …`)
- [ ] 3.2 Sealed vitest run of the new test file
- [ ] 3.3 `npm run typecheck`
- [ ] 3.4 Full baseline gate, before/after side by side
- [ ] 3.5 Scope check: `git diff --name-only origin/main...HEAD`
