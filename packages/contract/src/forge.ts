import { z } from 'zod';

/**
 * The forge-administration family of `/api/v1` — today just label provisioning (#47).
 *
 * Separate from `github.ts` on purpose: that family is the GitHub TAB's read surface, degrading in
 * the payload (`available: false` plus a hint) because a missing `gh` is a normal state for it.
 * This route is a MUTATION with real guards, so it degrades by status code instead — a refusal
 * carries `{error}` and no success shape at all, which is what stops a caller from reading
 * `complete` off a request that never touched the forge.
 */

/** A label the forge already carries under a taxonomy name, with a different colour or
 *  description. Reported, never repaired — provisioning is create-only. */
export const forgeLabelDriftSchema = z.object({
  name: z.string(),
  /** What the repository carries, six hex digits, no leading `#`. */
  color: z.string(),
  description: z.string(),
  /** What the taxonomy declares. Both sides are sent so the cockpit can show the difference
   *  without holding its own copy of the table. */
  wantColor: z.string(),
  wantDescription: z.string(),
});
export type ForgeLabelDrift = z.infer<typeof forgeLabelDriftSchema>;

/**
 * `POST /api/v1/forge/labels` — one provisioning pass over the pipeline label taxonomy.
 *
 * `created + present + drifted + missing` covers the taxonomy exactly once. `complete` is the
 * `labels-sync.sh --check` exit code in a field: that script exits 0 when the taxonomy is complete
 * and 1 when anything is missing, and an HTTP action has no exit code to carry it with. Drift does
 * not make a repository incomplete — the label exists, so the pipeline can address it.
 */
export const forgeLabelsSyncResponseSchema = z.object({
  /** The `owner/repo` actually acted on — echoed so a caller can prove the target. */
  target: z.string(),
  checkOnly: z.boolean(),
  /** `CEZ_DRY_RUN=1`: nothing was read and nothing was written. */
  dryRun: z.boolean(),
  complete: z.boolean(),
  created: z.array(z.string()),
  present: z.array(z.string()),
  missing: z.array(z.string()),
  drifted: z.array(forgeLabelDriftSchema),
});
export type ForgeLabelsSyncResponse = z.infer<typeof forgeLabelsSyncResponseSchema>;
