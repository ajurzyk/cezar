# Run: permission-modes spec for #475

Source doc: .ai/specs/2026-07-17-permission-modes.md

## Goal

Deliver the approved-by-PR specification (plus HTML mockups) for issue #475 —
non-skip-all and non-auto agent permission modes. Spec only; implementation
happens in a follow-up run once this PR is approved (the issue mandates spec
approval first).

## Scope

- `.ai/specs/2026-07-17-permission-modes.md` — the spec.
- `.ai/specs/assets/permission-modes/*.html` — three UI mockups (settings
  block, composer autonomous guard, in-run prompt card).
- Non-goals: any code change; per-workflow-step permission modes (gate
  decision Q2); persistent "always allow" rule learning.

## Risks

- Vendor CLI drift between spec approval and implementation (mitigated: the
  spec pins the verified CLI surfaces and mandates degrade-stricter).
- Docs-only run: full validation gate replaced by the docs-only minimum gate
  (diff re-read; repo has no markdown lint command).

## Progress

PR: #477

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Author the spec

- [x] 1.1 Skeleton + Open Questions gate (answered by user 2026-07-17: one phased spec; global + per-task; presets + rules; park at waiting)
- [x] 1.2 Research (claude/codex/opencode permission surfaces, verified against installed CLIs) + full spec
- [x] 1.3 HTML mockups: settings-permissions, composer-autonomous-guard, run-permission-prompt

### Phase 2: Review and ship

- [x] 2.1 Fresh-context adversarial spec review; applied 1 Critical (phasing), 1 High (nonexistent claude mode), 2 Medium (resolved-event shape, notice carrier), 2 Low findings
- [x] 2.2 Docs-only validation + PR with pipeline labels — 8420577 (PR #477; om-auto-review-pr verdict APPROVED, submitted as comment review — GitHub blocks self-approval)
