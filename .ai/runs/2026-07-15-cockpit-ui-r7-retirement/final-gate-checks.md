# Final gate — R7 (Retirement + polish) — closes the R1–R7 program

- Steps covered: 1.1–1.5 (`6f848d2`..`c7da6b9`) plus the `origin/main` merge (`63a2d78`,
  reconciling the #398 CI validation system). The phase closed within a 5-step window, so this
  gate subsumes the checkpoint.
- Touched areas: legacy web app removal + serving fallback, npm packaging + pack gate,
  BACKWARD_COMPATIBILITY waiver expiry, e2e suite (iOS sweep + stabilizations), README +
  screenshots, merged CI workflow/test systems.

## Full validation gate (post-merge tree)

| Check | Result |
|---|---|
| `npm run typecheck` | ✓ (server + web, incl. `test/**` newly in scope) |
| `npm test` (vitest) | ✓ 1855/1855, 108 files |
| `npm run test:unit` (node:test) | ✓ (workflow types) |
| `npm run build` | ✓ tsc + vite + `check:pack ok — 188 files, 56 under web/dist` |
| `npm run test:package` | ✓ 1/1 — tarball packs `web/dist/index.html`, installs, dry-run CLI works |

## Full integration suite

- Runner: repo-native `npm run test:e2e` (agent-browser, real Chrome, shared dry-run env).
- First post-merge run: 5 failures — 2 nav-label assertions (inbox badge digit leaking into the
  label once the shared env had todos) and 2 workflows keyboard-reorder failures (arrow/drop
  pressed before dnd-kit's lift/move settled; the drop resolved against stale coordinates), one
  cascade. Fixed forward as Step 1.5 (`c7da6b9`, test-only, diagnosed live with throwaway
  driver specs that never landed in the repo).
- Final state: **154/154 (22 files) green ×3 consecutive full runs.** One unrelated single-test
  flake appeared in one intermediate run and did not reproduce.

## Style-compliance pass

- design-guardian static scan runs inside `npm test`: **clean, 7/7**. No auto-fixes needed;
  no residual findings.

## Style-compliance residual findings

None.

## Merge reconciliation (origin/main, PR #398)

- Kept both test systems: vitest stays `npm test` / browser suite stays `test:e2e`; main's
  node:test suites land as `test:unit` + `test:package` (renamed from main's `test:e2e`);
  `ci.yml` updated and gains the vitest step; `package-cli.test.ts` expectations moved to the
  R7 tarball layout; validation.commands is the union. PR flipped from CONFLICTING to
  MERGEABLE after the push.
