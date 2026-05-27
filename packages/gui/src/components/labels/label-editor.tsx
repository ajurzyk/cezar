'use client';

import { useState } from 'react';
import type { LabelAnalysisDraft } from '@/lib/supabase/types';

export interface LabelListEditorProps {
  title: string;
  drafts: LabelAnalysisDraft[];
  onChange: (drafts: LabelAnalysisDraft[]) => void;
  /** Shows under the title; useful for "for issues" / "for PRs" subtext. */
  subtitle?: string;
}

/**
 * Editable list of label drafts. Each row is collapsible; expanded rows
 * expose every field of the draft for editing. The list supports add / remove
 * but does not enforce uniqueness — accept-time validation (in the server
 * action) handles the workspace_labels unique(workspace_id, name, scope)
 * constraint by returning a postgres error to the user.
 *
 * Shared between the /workspaces/new wizard and (Phase 2) /settings/labels.
 */
export function LabelListEditor({ title, subtitle, drafts, onChange }: LabelListEditorProps) {
  const update = (idx: number, patch: Partial<LabelAnalysisDraft>): void => {
    onChange(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };
  const remove = (idx: number): void => {
    onChange(drafts.filter((_, i) => i !== idx));
  };
  const add = (): void => {
    onChange([
      ...drafts,
      {
        name: '',
        color: null,
        description: '',
        when_to_add: '',
        when_to_remove: '',
        add_meaning: '',
        remove_meaning: '',
        exists_on_github: false,
      },
    ]);
  };

  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      <header className="flex items-center justify-between border-b border-outline-variant/60 px-5 py-3">
        <div>
          <h3 className="font-display text-[14px] font-semibold text-on-surface">{title}</h3>
          {subtitle && <p className="text-xs text-on-surface-variant">{subtitle}</p>}
        </div>
        <span className="text-xs text-on-surface-variant">{drafts.length} label{drafts.length === 1 ? '' : 's'}</span>
      </header>

      <div className="divide-y divide-outline-variant/60">
        {drafts.length === 0 ? (
          <p className="px-5 py-6 text-sm text-on-surface-variant">No labels in this list yet.</p>
        ) : (
          drafts.map((d, idx) => (
            <LabelRow
              key={`${d.name}-${idx}`}
              draft={d}
              onChange={(patch) => update(idx, patch)}
              onRemove={() => remove(idx)}
            />
          ))
        )}
      </div>

      <footer className="border-t border-outline-variant/60 px-5 py-3">
        <button
          type="button"
          onClick={add}
          className="text-xs font-medium text-primary hover:underline"
        >
          + Add label
        </button>
      </footer>
    </section>
  );
}

function LabelRow({
  draft,
  onChange,
  onRemove,
}: {
  draft: LabelAnalysisDraft;
  onChange: (patch: Partial<LabelAnalysisDraft>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(!draft.name);

  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <ColorSwatch hex={draft.color ?? null} />
        <input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="label-name"
          className="flex-1 rounded-md border border-outline-variant bg-bg px-2 py-1 font-mono text-sm text-on-surface focus:border-primary focus:outline-none"
        />
        {!draft.exists_on_github && (
          <span className="rounded-md border border-tertiary/40 bg-tertiary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
            new
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-on-surface-variant hover:text-on-surface"
        >
          {expanded ? 'Collapse' : 'Edit'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-error hover:underline"
        >
          Remove
        </button>
      </div>

      {!expanded && draft.description && (
        <p className="ml-7 mt-1 line-clamp-1 text-xs text-on-surface-variant">{draft.description}</p>
      )}

      {expanded && (
        <div className="ml-7 mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Color (hex without #)" value={draft.color ?? ''} onChange={(v) => onChange({ color: v || null })} />
          <Field
            label="Description"
            value={draft.description}
            onChange={(v) => onChange({ description: v })}
            placeholder="One-sentence purpose"
          />
          <Field
            label="When to add"
            value={draft.when_to_add}
            onChange={(v) => onChange({ when_to_add: v })}
            placeholder="The concrete trigger conditions"
            multiline
          />
          <Field
            label="When to remove"
            value={draft.when_to_remove}
            onChange={(v) => onChange({ when_to_remove: v })}
            placeholder='e.g. "when the issue is closed" or "never"'
            multiline
          />
          <Field
            label="Add means…"
            value={draft.add_meaning}
            onChange={(v) => onChange({ add_meaning: v })}
            placeholder="Semantic meaning of adding the label"
            multiline
          />
          <Field
            label="Remove means…"
            value={draft.remove_meaning}
            onChange={(v) => onChange({ remove_meaning: v })}
            placeholder="Semantic meaning of removing the label"
            multiline
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full resize-y rounded-md border border-outline-variant bg-bg px-2 py-1 text-sm text-on-surface focus:border-primary focus:outline-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-outline-variant bg-bg px-2 py-1 text-sm text-on-surface focus:border-primary focus:outline-none"
        />
      )}
    </label>
  );
}

function ColorSwatch({ hex }: { hex: string | null }) {
  const valid = hex && /^[0-9a-fA-F]{6}$/.test(hex);
  return (
    <span
      className="h-4 w-4 shrink-0 rounded-sm border border-outline-variant"
      style={valid ? { backgroundColor: `#${hex}` } : { backgroundColor: 'transparent' }}
      title={valid ? `#${hex}` : 'no color'}
    />
  );
}
