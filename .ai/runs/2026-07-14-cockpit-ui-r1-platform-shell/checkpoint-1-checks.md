# Checkpoint 1 — Steps 1.1..1.6 (Phase 1: Platform)

- UTC: see NOTIFY.md entry
- Commits covered: `4f3bf43`..`03b58d0` (plus run-folder/pipeline commits `8c336d5`, `0472ada`, `6a58f66`)
- Touched areas: `web/app/**` (new React app), `src/server/server.ts` + `src/server/static-ui.ts`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.ai/agentic.config.json`, `.ai/browsers/`, `.ai/scripts/test-env-up.sh`

## Validation

| Check | Result |
|---|---|
| `npm run typecheck` (server, tsconfig.test.json) | **PASS** |
| `npm test` (vitest: 6 files, server + web projects) | **PASS** — 72/72 |
| `npm run build` (tsc + vite build) | **PASS** |
| `npm run build:web` | **PASS** — emits `web/dist/index.html` + hashed assets |
| `npx tsc --noEmit -p web/app/tsconfig.json` | **PASS** |

## UI verification — agent-browser provider

Provider: `agent-browser` (`.ai/browsers/agent-browser.md`, `browser.provider` in the pipeline config).
`agent-browser doctor --json` → `{"success":true,"pass":9,"fail":0}` — agent-browser 0.31.2 + Chrome for Testing 150.0.7871.115, headless launch 0.61s. **Provisioned successfully; no skip.**

| Scenario | Result |
|---|---|
| `/` serves the React cockpit shell (React mounts, `#root` has children, background = computed `--background` token) | **PASS** |
| `/?legacy=1` serves the legacy cockpit (`#brand` present, React root absent) | **PASS** |
| `npm run test:e2e` end-to-end (boot → health → run → exit code) | **PASS** — `TEST_E2E_STATUS=passed`, 2/2, cold 6.3s / warm 2.2s (`TEST_ENV_REUSED=1`) |

Exit paths verified deliberately (not assumed): pass → exit 0; skip (provider unavailable) → loud banner + exit 0; fail → exit 1 with a legible diff.

Artifacts: `checkpoint-1-artifacts/screenshot-react-shell.png`, `checkpoint-1-artifacts/screenshot-legacy-shell.png` (both inspected — real renders, not blank frames).

## Real defects caught this window (all fixed in-window)

1. **npm tarball would have shipped a cockpit with no UI** — `files: ["web"]` + the root `.gitignore`'s `dist/` rule silently filtered `web/dist` out of the tarball. Confirmed with `npm pack --dry-run` (0 `web/dist` entries), fixed by explicit `files` entries; the tarball now carries exactly what the server serves (454 kB).
2. **`dark:` variants keyed off the wrong signal** — the shadcn registry's `dark:` utilities follow `prefers-color-scheme`, but our theme flips on `.light`. Stripped; tokens already track the active theme.
3. **`tailwind-merge` misread `shadow-modal` as a shadow colour** — let `shadow-md shadow-modal` coexist. `cn()` extended with the custom scale; pinned by a regression test.
4. **Tailwind v4 `@theme inline` self-reference** — `--radius-sm: var(--radius-sm)` emitted a circular reference (silently half-worked). Radius/shadow moved to `@theme static`.
5. **Test files would have shipped in `dist`** — split `tsconfig.json` (build, excludes tests) from `tsconfig.test.json` (typecheck).

## Residual / decisions for later steps

- `typecheck:web` is **not** in the validation gate, so `web/app/src` types are only checked manually (`vite build` does not typecheck). Dispatcher decision pending — likely fold into the gate at the next checkpoint.
- `/new` still serves the **legacy** index.html; Step 2.1 (routing) owns moving it to the React shell and preserving the bookmarklet `?skill=…&auto=…&key=…` contract.
- The mockup's `.seg` active segment uses a raw `#333` in dark that no token covers; Tabs currently uses `bg-card` (reads recessed, not raised). May need a token when the real segmented controls land.
- E2E assertions currently target the placeholder `app.tsx`; Step 2.3 must replace them when the real shell lands (they will legitimately break — that is the signal).
