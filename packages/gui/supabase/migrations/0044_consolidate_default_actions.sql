-- 0044_consolidate_default_actions.sql
-- Actions cleanup, Phase 3: consolidate the built-in catalog to 2 actions
-- (`auto-triage`, `security`) and kill the dual seed source of truth.
--
--   * The TS catalog (`DEFAULT_ACTIONS` in packages/core/src/actions-v2/
--     default-actions.ts) is now the ONLY seed definition. Seeding lives in
--     the app — packages/gui/src/lib/seed-default-actions.ts upserts the
--     catalog on workspace creation and on "restore defaults"; the
--     `seed_default_actions(uuid)` SQL function (0014/0028) is dropped below.
--   * The 13 retired built-ins are hard-deleted (restorable from git
--     history). User-kind rows with the same names survive as standalone
--     user actions.
--   * The 2 kept built-in rows are synced in place to the TS catalog — this
--     is the LAST hand-sync of prompt text into SQL; from now on the seed
--     helper owns it.
--   * New columns: `context_refs` (consumed by the runner since Phase 2),
--     plus `effect_routing` and `suggested_flow_id` (schema for Phase 5 —
--     workflow suggestions; not consumed yet).

-- ─── 1. New columns ──────────────────────────────────────────────────────

alter table actions
  add column if not exists context_refs jsonb not null default '[]'::jsonb;

alter table actions
  add column if not exists effect_routing jsonb not null default '{}'::jsonb;

alter table actions
  add column if not exists suggested_flow_id uuid references flows(id) on delete set null;

comment on column actions.context_refs is
  'Named context sections the runner injects into the user message (e.g.
   "open-issues" → the open-issue knowledge base). Each ref resolves against
   the caller-supplied context providers; unresolvable refs are skipped.';

comment on column actions.effect_routing is
  'Per-effect routing override: { "<effect>": "auto" | "always-defer" }.
   Checked before the confidence thresholds (Phase 5; not consumed yet).';

comment on column actions.suggested_flow_id is
  'Workflow (flows row) this action may suggest running on its target via the
   suggest-workflow effect. NULL = the tool is not exposed to the model.
   Per-workspace user choice — never written by seeding (Phase 5).';

-- ─── 2. Delete the retired built-ins ─────────────────────────────────────
-- kind='built-in' only — user-kind rows with these names survive as
-- standalone user actions. pending_decisions.action_id references actions
-- ON DELETE CASCADE (0019), so pending inbox rows produced by the retired
-- actions are cascaded away with them — acceptable: their effects would no
-- longer have an owning action to attribute to.

delete from actions
where kind = 'built-in'
  and name in (
    'bug-detector',
    'duplicates',
    'priority',
    'categorize',
    'quality',
    'auto-label',
    'missing-info',
    'good-first-issue',
    'contributor-welcome',
    'claim-detector',
    'recurring-questions',
    'done-detector',
    'stale'
  );

-- ─── 3. Ensure the 2 kept built-ins exist in every workspace ─────────────
-- Some workspaces have zero built-in rows: between 0015 and 0028 the seed
-- function raised on its stale ON CONFLICT target and the caller swallowed
-- the error. Insert placeholder rows where missing; the targeted UPDATEs
-- below fill in the real catalog values for both fresh and existing rows.

insert into actions (workspace_id, name, kind, target)
select w.id, n.name, 'built-in', 'issue'
from workspaces w
cross join (values ('auto-triage'), ('security')) as n(name)
on conflict (workspace_id, name, kind) do nothing;

-- ─── 4. Sync the kept built-ins to the TS catalog ────────────────────────
-- One-time hand-copy from packages/core/src/actions-v2/default-actions.ts;
-- afterwards packages/gui/src/lib/seed-default-actions.ts owns this.
-- effect_routing / suggested_flow_id are deliberately not touched (column
-- defaults apply; per-workspace user choices once Phase 5 ships).

update actions set
  description       = 'First triage pass per issue: adds a bug or feature label and links confident duplicates against the open-issue knowledge base. Never comments, closes, or assigns.',
  system_prompt     = 'You are running the first triage pass on an issue. Follow the auto-triage playbook in your reference skills. Do two things: (a) classify the issue and add ONLY a `bug` or `feature` label via label.add — questions, docs, and anything else get no label; (b) when the user message contains an "Open-issue knowledge base" section, compare the issue against it and call link-duplicate on a confident match — never close. If the section is absent, skip the duplicate check. Never comment, close, or assign. Include `_confidence` (integer 0-100) on every effect tool call. Calibrate: >=90 only when the evidence is unambiguous; 60-89 for plausible but contestable calls; below 60 do not call the tool at all.',
  skill_refs        = '["auto-triage-playbook", "bug-classification", "dedupe-heuristics"]'::jsonb,
  context_refs      = '["open-issues"]'::jsonb,
  target            = 'issue',
  triggers          = '["on-issue-opened", "on-issue-reopened", "manual"]'::jsonb,
  effects           = null,
  output_schema     = null,
  enabled           = true,
  acceptance_mode   = 'human-in-the-loop',
  confidence_config = '{"autoAcceptAbove": 90, "autoDenyBelow": 60}'::jsonb
where kind = 'built-in' and name = 'auto-triage';

update actions set
  description       = 'Flag issues with security implications, even when not explicitly labelled.',
  system_prompt     = 'Apply the security-signals playbook in your reference skills. Flag only at confidence ≥ 0.70 — a false positive beats a missed vulnerability. Add a security label via label.add. Any comment you post must be short and to the point — finding, severity, evidence; no filler.',
  skill_refs        = '["security-signals"]'::jsonb,
  context_refs      = '[]'::jsonb,
  target            = 'issue',
  triggers          = '["on-issue-opened", "on-issue-edited", "manual"]'::jsonb,
  effects           = '["label.add", "comment"]'::jsonb,
  output_schema     = '{"type":"object","required":["isSecurityRelated","confidence"],"properties":{"isSecurityRelated":{"type":"boolean"},"confidence":{"type":"number","minimum":0,"maximum":1},"category":{"type":"string"},"severity":{"type":"string","enum":["critical","high","medium","low"]},"explanation":{"type":"string"}}}'::jsonb,
  enabled           = true,
  acceptance_mode   = 'auto',
  confidence_config = '{"autoAcceptAbove": 0}'::jsonb
where kind = 'built-in' and name = 'security';

-- ─── 5. Repair the workspace auto-triage pointer where unset ─────────────
-- Existing pointers are preserved (they already reference the kept
-- `auto-triage` row, or a deliberate user override).

update workspaces w
set auto_triage_action_id = a.id
from actions a
where a.workspace_id = w.id
  and a.name = 'auto-triage'
  and a.kind = 'built-in'
  and w.auto_triage_action_id is null;

-- ─── 6. Retire the SQL seed function ─────────────────────────────────────

drop function if exists seed_default_actions(uuid);
