# Final gate — server-installer (all steps complete)

Branch `feat/server-installer` @ b605fc9. All 11 spec steps + 2 review-fix steps done.

## Full validation gate (all green, in order)

| Command | Result |
|---|---|
| `npm run typecheck` (server + web) | ✅ pass |
| `npm test` (vitest) | ✅ 1960 passed (122 files) |
| `npm run test:unit` (node:test) | ✅ 4 passed |
| `npm run build` (tsc → dist, vite → web/dist, check:pack) | ✅ check:pack ok — 231 files |
| `npm run test:package` (pack tarball + drive built CLI) | ✅ 1 passed — server-install→uninstall dry-run round-trip + bad-platform exit 1 |

## Integration suite

N/A — this change adds a CLI/server module with no cockpit UI surface. The packaged-CLI e2e drives the real built binary end-to-end (install → uninstall → bad-platform) under `CEZ_DRY_RUN=1`. No web/app change → the browser e2e (`npm run test:e2e`) is out of scope.

## Design-system / style pass

N/A — no UI. No repo-local style-compliance skill applies to server-side TS.

## Adversarial review + fixes (verification phase)

A fresh-context staff-engineer review of the whole module found and I fixed, before finalizing:
- **H1 (auth bypass):** `--yes` could write an empty-password htpasswd → open cockpit. Now refused.
- **H2 (secret in argv):** htpasswd password fed to openssl via stdin, not argv (VPS `ps` exposure).
- **H3/M1:** `--yes` skips optional steps (was running certbot/autostart on placeholder input); Ctrl-C at the optional prompt cancels cleanly.
- **M2:** launchd plist XML-escaped. **M3/M6:** nginx undo uses constant paths + restores the default site. **M4:** systemd ExecStart absolute. **M5:** user-bus detection fixed. **L2/L3:** /etc/cezar cleanup, htpasswd 0640.
- Post-fix gate regression caught by test:package (uninstall left `skipped` entries) → fixed (uninstall clears state on completion).

Dry-run purity re-confirmed: no real sudo/network/package-install/fs-write under `CEZ_DRY_RUN=1`.
