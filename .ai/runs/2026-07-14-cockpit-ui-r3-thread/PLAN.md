# Run: Cockpit UI redesign — Phase R3 (Thread view)

- Date: 2026-07-14
- Branch: `feat/cockpit-ui-r1-platform-shell` (the single consolidated PR #396)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"Task thread (the chat view)", Implementation Plan steps 8–12
- Mode: Spec-implementation run

## Tasks

> Authoritative status table. Executors flip `Status` → `done` in their Step's commit and leave `Commit` as `pending`; the dispatcher backfills SHAs at checkpoints.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Thread skeleton: turns, message items, Streamdown+Shiki markdown | done | a19391d |
| 1 | 1.2 | Tool cards + context groups + reasoning + live output streaming | done | e1ea47b |
| 1 | 1.3 | Plan dock + step rail + check-step cards | done | d7d1d5a |
| 1 | 1.4 | Run header: meta, status, tabs, action bar (Finish/Continue/Terminal/Notes/Archive/Cancel/Delete) | done | 1b7a72e |
| 2 | 2.1 | Shared composer: reply, attachments, / skills autocomplete, @ files, dictation, quick replies | done | b5cb131 |
| 2 | 2.2 | Review gate on the new surface (diff panel, send back, Draft PR) | done | a6e255e |
| 2 | 2.3 | Variants compare view | done | 0ba7cc3 |
| 2 | 2.4 | Thread virtualization + scroll caches + iOS pass + v1 fallback for old runs | done | b0bcde1 |

## Goal
The chat view at `/tasks/:id` (Session tab) rendered from protocol v2 with v1 fallback: turns, tool cards with live output, context groups, reasoning, the plan dock (#382), tool results Codex-style (#381), the composer with skills autocomplete (#380) and Dictation, review gate, variants compare — matching the thread.html mockup, mobile-first.

## Scope
`web/app/src/routes/task-thread/**`, thread components, composer components, `web/app/e2e/` extensions. Server: message/finish/continue/pr endpoints already exist — wiring only. New devDeps allowed per spec tech picks: streamdown or equivalent, shiki (fine-grained), virtua.

## Non-goals
Changes/Files tabs (R5). Editable title UI (small — may land with header if trivial, else R4). No permission UI.

## Risks
Bundle size (shiki lazy, JS engine only); streaming perf (paced rendering); the mockup is the visual contract — `docs/mockups/thread.html`.
