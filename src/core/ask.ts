/**
 * AskUser payload — the structured multiple-choice question an agent asks the
 * user, so the cockpit can render clickable option chips instead of the prose
 * fallback ("AskUserQuestion isn't available…"). See the spec
 * `.ai/specs/2026-07-18-askuser-across-runners.md`.
 *
 * The agent emits this as a `CEZ:ASK <compact-json>` control marker (a sibling
 * of `CEZ:DONE` / `CEZ:MONITORING`), parsed on the assembled turn text in
 * `src/workflows/run.ts` — uniform across claude, codex and opencode with no
 * per-backend mapper work. The shape is modeled 1:1 on Claude Code's built-in
 * `AskUserQuestion` (1–4 questions, 2–4 options each, `header` ≤12 chars,
 * unique question texts and unique option labels) so a native bridge can map
 * onto it later. A free-text "Other" is always available via the composer, so
 * it is never an explicit option.
 */
import { z } from 'zod';

export const askOptionSchema = z
  .object({
    label: z.string().min(1).max(60),
    description: z.string().max(280).optional(),
  })
  .strict();

export const askQuestionSchema = z
  .object({
    /** Stable key for the answer; defaults to the array index when omitted. */
    id: z.string().min(1).max(64).optional(),
    /** ≤12-char chip label (matches AskUserQuestion's `header`). */
    header: z.string().min(1).max(12),
    question: z.string().min(1).max(400),
    options: z
      .array(askOptionSchema)
      .min(2)
      .max(4)
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
        message: 'option labels must be unique within a question',
      }),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const askRequestSchema = z
  .object({
    questions: z
      .array(askQuestionSchema)
      .min(1)
      .max(4)
      .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length, {
        message: 'question texts must be unique',
      }),
  })
  .strict();

export type AskOption = z.infer<typeof askOptionSchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;
export type AskRequest = z.infer<typeof askRequestSchema>;

/**
 * Parse a value into a validated `AskRequest`, or `null` when it does not match
 * (bad counts, over-length header, non-unique labels/questions, extra keys).
 * Callers degrade to plain text on `null` — the feature never makes the prose
 * fallback worse.
 */
export function parseAskRequest(value: unknown): AskRequest | null {
  const parsed = askRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
