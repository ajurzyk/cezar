# Checkpoint 2 — steps 1.6 .. 1.8 (Phase 1 complete)

Covers: `engine.ts` (runInstall/runUninstall), `strategies.ts` + `platforms/ubuntu-vps.ts`, `src/index.ts` CLI wiring + npm scripts + packaged e2e.
Commit range: 27da0e7 .. 693cda2.

## Checks

| Check | Result |
|---|---|
| `npm run typecheck:server` | ✅ pass |
| `npm run build` (tsc → dist, vite → web/dist, check:pack) | ✅ pass — check:pack ok, 228 files, shell + assets present |
| `npm test` (full vitest: server + cockpit) | ✅ 1948 passed (120 files) |
| `npm run test:unit` (node:test) | ✅ 4 passed |
| `npm run test:package` (pack tarball + drive built CLI) | ✅ 1 passed — includes server-install→server-uninstall dry-run round-trip + bad-platform exit 1 |

## What Phase 1 delivers

`cezar server-install --platform ubuntu-vps` stands up an authenticated, nginx-proxied cezar (deps → nginx+htpasswd → identity 401 check); `cezar server-uninstall` reverses every step. Fully dry-run testable (`CEZ_DRY_RUN=1`, `CEZ_HOME` isolates state). Install ships **with** uninstall — no phase leaves a modified box without a tool-driven undo.

## UI verification

Skipped — no cockpit UI touched (CLI + server module only). The packaged e2e exercises the real built CLI end-to-end instead.

## Notes

- `@clack/prompts` confirmed isolated: lazy `import()` in `src/index.ts`'s server handler; not in the `serve`/`run`/`init` graph.
- The packaged tarball ships `dist/server-install/*`; `@clack/prompts` is a declared prod dependency so consumers get it.
