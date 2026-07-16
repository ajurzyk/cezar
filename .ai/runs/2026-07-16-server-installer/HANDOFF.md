# Handoff — server-installer

**State:** in-progress
**Branch:** `feat/server-installer`
**PR:** not opened yet
**Checkpoint:** 2 (Phase 1 complete — steps 1.1–1.8 verified, all gates green)

## Next concrete action

Step 2.1 — add the optional **SSL step** to `platforms/ubuntu-vps.ts`: `certbot --nginx -d <domain>` via `sudoStep`; if DNS isn't pointed / LE rate-limited, show the reason and mark the step `skipped` (install still completes). Record the cert domain as a `shared` artifact (cert + renewal timer survive uninstall); only the vhost reference is `owned`. Insert it into `steps()` before `identityStep`. Add a dry-run unit test.

## Phase 1 in place (shipped install + uninstall)

- Engine: `runInstall`/`runUninstall`, resume, `--reconfigure`, single-writer lock.
- ubuntu-vps: deps (reuses `detectEnvironment`) → nginx+htpasswd → identity 401 check; full `undo` per step.
- CLI: `server-install`/`server-uninstall` on the `cezar` bin (lazy import keeps @clack out of the serve graph); `npm run server-install`.
- Tests: 8 server-install unit files + packaged e2e round-trip.

## Remaining steps

2.1 SSL · 2.2 autostart (systemd) · 3.1 macosx-ngrok + register in `strategies.ts`.

## Validation

Gate all green at checkpoint 2: typecheck, `npm test` (1948), `npm run test:unit`, `npm run build`, `npm run test:package`.
