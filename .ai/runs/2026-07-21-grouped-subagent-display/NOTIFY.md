# Notify — 2026-07-21-grouped-subagent-display

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-07-21T10:09:58Z — run started
- Brief: implement `.ai/specs/2026-07-20-grouped-subagent-display.md` end to end (all 3 phases /
  7 steps) — grouped sub-agent display for issue #474, ask 3. Spec + mockups already merged (#522).
- External skill URLs: none
- Mode: Spec-implementation run (linked spec under `.ai/specs/`, explicit phases/steps).
- Reused the current linked worktree; branch `feat/grouped-subagent-display` off `origin/main`.

## 2026-07-21T10:22:30Z — checkpoint 1 (Phase 1 complete)
- Steps covered: 1.1 … 1.4 (`bd205e4` … `e021935`).
- Validation: typecheck, `npm test` (2975), `npm run test:unit` (30), design-guardian — all green.
- UI verified in a real browser via agent-browser against the dry-run cockpit: the dock renders
  `Agents · 2/2` with both agents, type badges, activity lines and tool counts; Task cards remain
  in the transcript (spec Q4). Screenshots in `checkpoint-1-artifacts/`.
- Decision: the codex folded review item keeps the entered frame's `name` and a stable `Review`
  title across its lifecycle, so the dock row does not rename itself on completion.
- Decision: Tasks-table SHAs are stamped by the FOLLOWING step's commit — a commit cannot contain
  its own post-amend SHA. `Status` is always correct in its own commit; only `Commit` trails by one.
