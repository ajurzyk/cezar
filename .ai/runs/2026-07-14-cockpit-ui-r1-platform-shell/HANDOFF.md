# Handoff — Cockpit UI redesign, Phase R1 (Platform + shell)

_A fresh agent should be able to resume in under 30 seconds from this file._

## State (final — R1 COMPLETE)

- **All 18 Steps done** (17 planned + 4.4-review-fix), `4f3bf43`..`367e550`. Final gate green: typecheck (server+web) · `npm test` **647/647** · build · `npm run test:e2e` **41/41** (agent-browser, real Chrome).
- Fresh-context review: verdict REQUEST CHANGES → one major fixed (`/new` now serves the LEGACY page until R4 lands the composer — the bookmarklet contract is a hard-protected surface) + `/assets` traversal hardening. Re-verified live.
- **PR #396 is ready for the user's review/merge** (draft, `Status: complete`).

## Next concrete action

**Phase R2 (protocol v2)** as a NEW run — branch `feat/cockpit-ui-r2-protocol` stacked on this branch (base PR #396's branch; GitHub retargets to main when #396 merges). Spec steps 5–7: UiEvent/UiItem types + claude emitter w/ golden fixtures; codex + opencode emitters w/ fixtures; RunManager v2 persistence + titleSummary + diffStat + PATCH title + systemPrompt. R2 unlocks the honest slots R1 left: `titleSummary`, `± diffStat`, `permission`/`unseen` attention sources.
**R2 note**: the three backend mappers are disjoint files — a Workflow fan-out is appropriate there (unlike R1's serial one-branch steps).

## What exists now

- **`web/app/`** — Vite + React 19 + TS (root `web/app`, builds to `web/dist`). Tailwind v4 CSS-first; Mercato tokens in `web/app/src/styles/index.css` (**the only place raw hex is allowed**); self-hosted Inter + JetBrains Mono; 19 shadcn/ui primitives (new-york) in `components/ui/`; `status-dot.tsx`, `pill.tsx`, `theme-provider.tsx`, `theme-toggle.tsx`, `app-shell.tsx`, `nav-items.ts`, `icons.tsx`; `cn()` in `lib/utils.ts`; `lib/theme.ts` (pure theme rules); `routes.tsx` (all 17 spec routes, placeholders).
- **`src/server/`** — `static-ui.ts` holds the pure resolvers (`resolveIndexHtml`, `resolveGetRequest`); `server.ts` serves `web/dist` (`/assets/*` immutable), falls back to the legacy UI when unbuilt (+ one-line hint), honors `?legacy=1`, and has the SPA catch-all registered **last** so deep links cold-load.
- **Testing** — vitest workspace: `server` project (node, `src/**/*.test.ts`, NodeNext `.js` imports) + `web` project (jsdom, `web/app/src/**/*.test.{ts,tsx}`, `@` alias). `npm test` is in the validation gate.
- **E2E / UI verification** — `npm run test:e2e` boots via `.ai/scripts/test-env-up.sh` (idempotent, reuses a healthy instance, `CEZ_DRY_RUN=1`, writes `.ai/qa/test-env.json`) and drives **agent-browser** through the seam at `web/app/e2e/agent-browser.ts` (wrappers: `open`, `snapshot`, `get`, `is`, `eval`, `screenshot`, `close`, `waitForFunction`, `count`, `tapAt`, `click`). Screenshots land in `.ai/qa/artifacts_e2e/` (gitignored) and are copied into `checkpoint-N-artifacts/` at checkpoints.

## Rules a resuming agent MUST keep

- **One Step = one commit.** Flip that Step's `Status` → `done` in the same commit; leave `Commit` as `pending` — the dispatcher backfills real SHAs at checkpoints (a commit cannot contain its own SHA).
- **Tests are mandatory per Step.** UI-touching Steps must extend `web/app/e2e/` **through the agent-browser seam** (never a browser library directly) and the suite must pass at the checkpoint. Checkpoint every ~5 Steps: targeted validation + e2e + screenshots → `checkpoint-N-checks.md`, rewrite this file, append `NOTIFY.md`, one commit, push.
- **No raw hex outside `styles/index.css`** (Step 4.4 adds the design-guardian test that enforces it).
- `npx cezar-cli` must stay **zero-config and no-build** for users — all new deps are `devDependencies`; the tarball ships built assets.
- **The legacy vanilla UI must keep working** (`?legacy=1`) until phase R7.
- Never `--no-verify`, never force-push, never fake a passing check.

## Gotchas learned the hard way (do not re-discover)

- jsdom here has **no `window.matchMedia`** → use `vi.stubGlobal`, not `vi.spyOn`.
- Radix dialogs never set `aria-modal`; they `aria-hidden` everything outside. Assert real modality.
- `tailwind-merge` doesn't know our custom scales — `cn()` is extended for `shadow-modal`.
- Tailwind v4: `@theme inline` self-references break for radius/shadow (their names are Tailwind namespace keys) → those live in `@theme static`. `rounded-3xl`/`shadow-2xl`/`rounded-xs` **do not exist**; default control radius 10px = `rounded-md`.
- Never use the `dark:` variant — it keys off `prefers-color-scheme`, but our theme flips on `.light`.
- The e2e drawer slides for 500ms and is "visible" while still off-screen → always `waitForFunction`.
- `npm run typecheck` uses `tsconfig.test.json`; `tsconfig.json` (build) excludes tests so they never ship in `dist`.

## Known follow-ups (not blockers, carried into later steps)

- `typecheck:web` is **not** in the validation gate — recommend folding it in (Step 4.4 is a natural home).
- `/new` parses the bookmarklet params but **`auto=1` does not auto-start until R4** (R4 owns the composer + auto-start). Not publishable to npm before the real views land — do not cut a release from R1 alone.
- The drawer is not mockup-verified (mockups have no drawer). Light-theme active nav row is low-contrast *as the mockup specifies*. The dark `.seg` active segment (`#333`) still has no token.
- `DESKTOP_MEDIA_QUERY` duplicates Tailwind's `md`.

## After R1

Phases R2–R7 of `.ai/specs/2026-07-14-cockpit-ui-redesign.md` remain, each its own run/PR: R2 protocol v2 (+ all-backend golden fixtures), R3 thread, R4 new task + list, R5 git view + forge drivers, R6 remaining views + Settings, R7 legacy retirement + packaging flip. The spec's Implementation Plan lists the steps.
