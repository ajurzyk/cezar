# Execution plan: server installer & uninstaller spec

## Goal

Ship the finalized feature spec `.ai/specs/2026-07-16-server-installer.md` as a docs-only PR against `main`, mirroring how PR #406 shipped the multi-project-switcher spec, and open an `Implement:` tracking issue so the phased build can be scheduled.

Source doc: `.ai/specs/2026-07-16-server-installer.md`

## Scope

- Add one markdown file under `.ai/specs/` (the design-record area AGENTS.md documents).
- Open a tracking issue that references the spec and lists its phased Implementation Plan.

## Non-goals

- **No runtime code.** No `src/`, `package.json`, or CLI changes in this PR — the spec's own Implementation Plan is the future work, tracked by the issue.
- Not adding `@clack/prompts` or any dependency here (that lands with Phase 1 of the build).

## Design summary (for reviewers)

A dependency-free interactive wizard — `npx @pat-lewczuk/cezar server-install --platform <id>` — modularized by platform strategy (`ubuntu-vps`, `macosx-ngrok`). A shared engine drives ordered, resumable, idempotent `InstallStep`s; a reusable `sudoStep` (print → run-or-delegate → verify → redo) keeps every privileged action operator-approved and verified. State lives in `~/.cezar/server.json` (host-level, install-once — coexists with the multi-project `~/.cezar/instances/`). Identity is the nginx Basic-auth/htpasswd layer; cezar stays loopback-bound behind the proxy. `server-uninstall` reverses `owned` config and lists `shared` tools for manual removal. Resolved drafting-gate decisions: one cohesive spec, `@clack/prompts` TUI, htpasswd identity, subcommands on the existing bin.

## Risks

- The spec introduces the first prod dependency beyond hono/yaml/zod (`@clack/prompts`) — flagged in the spec's Risks section for reviewer blessing; not added in this docs PR.
- `src/paths.ts` is shared with two other in-flight 2026-07-16 specs — the spec documents first-writer-owns coordination; no hard ordering dependency.
- Docs-only: runtime blast radius is nil. Rollback is deleting the file.

## Progress

PR: #420

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Land the spec + tracking issue

- [x] 1.1 Add the finalized spec `.ai/specs/2026-07-16-server-installer.md` — 0898339
- [x] 1.2 Open the `Implement: server installer & uninstaller` tracking issue — #419
- [x] 1.3 Open the docs PR, normalize labels, post the summary comment — #420
