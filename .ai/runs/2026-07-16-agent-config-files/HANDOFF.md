# Handoff — Agent config files

**State:** Phase 1 (backend) complete and verified at Checkpoint 1. Steps 1.1–1.5 done, full fast gate green (1959+4 tests).

**Next concrete action:** Step 2.1 — add `toml` to `LANG_LOADERS` in `web/app/src/lib/highlighter.ts` (one entry + the lazy `@shikijs/langs/toml` chunk) and extend the grammar-allowlist test.

**Then:** Step 2.2 — `web/app/src/components/code-editor.tsx`, an overlay-on-`<textarea>` reusing the highlighter singleton (mirror the `useFileTokens` hook in `web/app/src/routes/task-git/file-preview.tsx`). No soft wrap; `HIGHLIGHT_MAX_LINES` cap; language from the catalog `format`, not `langForPath`; Tab not trapped.

**Backend contract now live (for Phase 3 client):**
- `GET /api/agent-config` → `{ editable, files[], userMcp|null }`. `files[]` items: `id, runners, kind, scope, label, path, format, tracked, seeded, holdsMcp, precedence, hotReload?, docsUrl, exists, size, version, writable, readOnlyReason?`.
- `GET /api/agent-config/:id` → `{ id, path, exists, content, version }` (404 unknown id).
- `PUT /api/agent-config/:id` `{ content, version }` → 200 `{...read}` | 400 bad-format | 404 unknown | 409 stale-or-hosted.

**Invariant to preserve:** the hosted-mode write gate is by-mode and server-side (`src/server/server.ts`, the `capabilities().localHandoff` check in the PUT handler). Do not let the client's `editable` flag be the only gate.

**Worktree:** `.ai/tmp/om-auto-create-pr-loop/agent-config-files-20260716-095538` (branch `feat/agent-config-files`).
