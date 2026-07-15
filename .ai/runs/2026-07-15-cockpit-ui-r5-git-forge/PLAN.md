# Run: Cockpit UI redesign — Phase R5 (Git view + forge)

- Date: 2026-07-15
- Branch: `feat/cockpit-ui-r1-platform-shell` (single consolidated PR #396)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"Session git view — Changes & Files tabs (#390)", §"Forge-driver seam", §"Git/session API additions", §"Deployment modes", Implementation Plan steps 16–18
- Mode: Spec-implementation run

## Tasks

> Executors flip `Status` → `done` in their Step's commit, leave `Commit` = `pending`; dispatcher backfills SHAs.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Forge driver seam: src/server/forge/, health `forge` + `capabilities.localHandoff`, hosted-mode 409s | done | e1fc7bd |
| 1 | 1.2 | Session git API: /api/runs/:id/changes + /files + git/commit + git/push (zod, 409-with-reason) | done | d9096ad |
| 1 | 1.3 | Repo API: /api/repo/changes + /api/repo/branch | done | 1289484 |
| 1 | 1.4 | `<Diff>` facade on @pierre/diffs (fallback impl, same props) + shared Shiki highlighting | done | 8e2c2ab |
| 1 | 1.5 | Changes tab: tree + viewer + git action policy bar (Commit/Push/branch/Create PR→View PR/editor) | done | 57d9fdc |
| 1 | 1.6 | Files tab: read-only worktree browser (tree + preview, images inline, size caps) | done | 4e963dc |
| 1 | 1.7 | Repo view rebuild on the same components + commits/branches + mobile diff mode | done | 84e6837 |

## Goal

The session git view (#390) and the repo view on shared components, with the forge seam (GitHub now, GitLab later) formalized server-side, hosted-mode (`CEZ_REMOTE`) capability gating, and the structured-diff APIs the new UI needs.

## Non-goals

GitHub tab restyle + Inbox (R6), Settings (R6), legacy retirement (R7). `/api/github` response shape and the legacy `/diff` endpoints are protected surfaces (BACKWARD_COMPATIBILITY.md) — additive only.

## Implementation Plan

### Step 1.1 — Forge driver seam (server)
- `src/server/forge/types.ts`: `ForgeDriver` interface — `detect()`, `listIssues()`, `listPRs()`, `createPR(draft)`, `prStatus(branch)`, `viewUrl(kind, ref)`.
- `src/server/forge/github.ts`: move the current gh-CLI logic from `src/server/github.ts` + `src/server/pr.ts` behind the interface (existing files become thin re-exports or callers; `/api/github` response shape unchanged).
- `src/server/forge/index.ts`: `resolveForge(repoInfo)`: remote host → driver | null.
- `GET /api/health` gains `forge: {kind:'github', available:boolean, reason?} | null` and `capabilities: {localHandoff: boolean}`. `CEZ_REMOTE=1` or a non-loopback bind host ⇒ `localHandoff:false`.
- `open-in-cli` (and any open-in-editor/terminal endpoint) returns 409 + reason in hosted mode.
- Unit tests: resolveForge host mapping, health shape both modes, 409 defense.

### Step 1.2 — Session git API
- `GET /api/runs/:id/changes` → `{files:[{path,status,adds,dels,patch}], stat:{adds,dels,files}}` for the session worktree vs base (existing text-blob `/diff` stays untouched).
- `GET /api/runs/:id/files?path=` → worktree dir listing / file content (size-capped, binary flagged).
- `POST /api/runs/:id/git/commit` `{message}` → commit -A in the worktree; `POST /api/runs/:id/git/push` → push + set upstream.
- All zod-validated; every failure degrades 409 + human reason (never HTML).
- Unit tests against fixture git repos (tmp dirs), incl. rename/binary/empty cases.

### Step 1.3 — Repo API
- `GET /api/repo/changes` → same structured shape for the main working tree.
- `POST /api/repo/branch` `{name, from?}` → create/switch; 409 on dirty-tree conflicts with reason.
- Keep `/api/repo`, `/api/repo/diff`, `/api/repo/commit/:sha` as-is (legacy still uses them).
- Unit tests.

### Step 1.4 — `<Diff>` facade (web)
- `web/app/src/components/diff/` — a `<Diff>` component whose props are OURS (files, mode unified|split, wrap, word-level intra-line, expandable context, per-file sticky headers, aggregate ± stat); implemented on `@pierre/diffs` (devDependency; bundled) with a same-props fallback renderer for environments where the lib breaks.
- Syntax highlighting through the existing `lib/highlighter.ts` singleton (shared with chat).
- Unit tests on the facade props contract (mode flip, word-diff, empty file list).

### Step 1.5 — Changes tab
- Run detail gains tabs **Session | Changes | Files** (mobile: swipeable segments; deep-linkable, e.g. `/tasks/:id/changes`).
- Changes: collapsible file tree (per-file ±) + `<Diff>` viewer; empty state "No changes yet"; animated aggregate stat.
- **Git action policy object**: a pure function of git/forge/capability state → `{primary, secondary, menu}` where disabled entries carry their reason ("Push unavailable — no remote configured"). Unit-test the policy exhaustively.
- Toolbar: Commit (message prefilled with auto-summary; commit -A), Push, branch chip, Create PR (forge-gated; flips to View PR once open — also surfaces in header/task rows), Open in editor (localHandoff-gated).
- e2e through the agent-browser seam + screenshots.

### Step 1.6 — Files tab
- Read-only worktree browser: tree + file preview (Shiki), images inline, size-capped with an honest "too large" state.
- e2e: browse a dry-run worktree, open a file, view an image.

### Step 1.7 — Repo view rebuild + mobile diff
- Nav "Git" (`/git`) = the same Changes/Files components pointed at the main working tree + recent commits (click → structured commit diff view) + branch list with switch/create + base-branch picker.
- Forge rows (PR links, checks) only when driver available.
- Mobile: unified+wrap forced below `md`, swipeable segments.
- e2e + screenshots (desktop + iPhone viewport).

## External References

None beyond the source spec. `@pierre/diffs` is a devDependency (bundled into web/dist; the npx tarball ships built assets only).
