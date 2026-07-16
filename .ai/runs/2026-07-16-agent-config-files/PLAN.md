# Execution plan — Agent config files in Settings

Source spec: `.ai/specs/2026-07-16-agent-config-files.md`
Tracker issue: #404
Branch: `feat/agent-config-files`
Base: `main`
Status: in-progress

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Config catalog (`src/agent-config/catalog.ts`) | done | PENDING |
| 1 | 1.2 | Home-path helpers (`src/paths.ts`) | done | PENDING |
| 1 | 1.3 | Validators + JSONC stripper (`src/agent-config/validate.ts`, add `smol-toml`) | done | PENDING |
| 1 | 1.4 | Reader/writer (`src/agent-config/files.ts`) | todo | — |
| 1 | 1.5 | API routes + hosted-mode gate (`src/server/server.ts`) | todo | — |
| 2 | 2.1 | Add `toml` to highlighter `LANG_LOADERS` | todo | — |
| 2 | 2.2 | Code editor overlay (`web/app/src/components/code-editor.tsx`) | todo | — |
| 3 | 3.1 | Registry: add `agent-config`, unhide `mcp`; fix section/route tests | todo | — |
| 3 | 3.2 | API client types + queries | todo | — |
| 3 | 3.3 | `agent-config-section.tsx` | todo | — |
| 3 | 3.4 | `mcp-section.tsx` | todo | — |
| 4 | 4.1 | Worktree seeding of the personal layer (`src/workflows/run.ts`) | todo | — |
| 5 | 5.1 | Docs: AGENTS.md, README, BACKWARD_COMPATIBILITY.md §2, CHANGELOG | todo | — |

## Goal

Add a Settings surface that reads and writes the coding agents' own config files (Claude / Codex / OpenCode: `settings.json`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `config.toml`, `opencode.json`) raw, per scope, with syntax highlighting, showing each scope's file and the vendor's documented precedence. MCP is first-class. Global scope vs local shown together.

## Scope

Backend catalog + reader/writer + additive API routes; a highlighted overlay editor; two Settings sections (`agent-config`, `mcp`); worktree seeding of Claude's gitignored personal layer; docs.

## Non-goals

- No source-file → agent routing (not this feature).
- No project registry / multi-repo switching (separate spec).
- No editing of `~/.claude.json` (Claude's state file) — read-only listing only.
- No `.claude/rules/`, `.opencode/agents/`, managed/enterprise scopes (follow-ups).
- No teaching `AgentRunSpec` about MCP (follow-up).

## Risks

- **First write outside `.ai/cezar/`**, some of it code-executing (hooks, MCP `command`). Mitigated by the by-mode hosted gate (writes local-only). This is the #1 review-blocker property — Step 1.5.
- Vendor drift on paths/precedence strings — mitigated by the single-file catalog + `docsUrl` + dated research.
- One new runtime dep (`smol-toml`) — sanctioned by the spec.
- Editing repo-tracked files dirties the user's working tree.

## External References

None (`--skill-url` not passed). The spec's §Research cites primary vendor docs, verified 2026-07-16.

## Implementation Plan

Follows the spec's `## Implementation Plan` verbatim; see the spec for full per-step detail and the authoritative architecture, API contracts, and edge-case table.

**Phase 1 — Backend foundation** (1.1–1.5): pure catalog → paths → validators → reader/writer → API routes with the by-mode hosted gate.

**Phase 2 — Editor** (2.1–2.2): `toml` grammar + the overlay-on-textarea component.

**Phase 3 — Settings UI** (3.1–3.4): registry + tests, API client, the two sections.

**Phase 4 — Worktree seeding** (4.1): Claude personal layer into the run's worktree, `git check-ignore`-guarded, idempotent `info/exclude`.

**Phase 5 — Documentation** (5.1).
