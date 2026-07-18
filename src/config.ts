import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Optional advanced config at `.ai/cezar/config.json`. Zero-config rule:
 * a missing file behaves exactly like the default below, an unreadable or
 * invalid file degrades to the default too (never blocks startup). The key
 * can be overridden or emptied (`"skillsRepos": []` disables team skills).
 */
const skillsRepoSchema = z.object({
  /** `owner/name` (GitHub shorthand), a full git URL, or a local/file:// path. */
  repo: z.string().min(1),
  ref: z.string().min(1).default('main'),
});

export type SkillsRepoSource = z.infer<typeof skillsRepoSchema>;

export const DEFAULT_SKILLS_REPOS: SkillsRepoSource[] = [
  { repo: 'open-mercato/skills', ref: 'main' },
];

const configSchema = z.object({
  skillsRepos: z.array(skillsRepoSchema).default(DEFAULT_SKILLS_REPOS),
  /** How many tasks may run at once (spec 006). Non-git dirs always run 1. */
  maxParallel: z.number().int().min(1).max(16).default(2),
  /**
   * Count-based worktree retention (#483): keep the last N *finished*
   * worktrees materialized on disk; reclaim older ones (directory only — the
   * `cez/<id8>` branch is kept, so the work stays recoverable). 0 = unlimited
   * (never auto-reclaim). Default 10. `.catch(10)` keeps it additive-safe: a
   * bad value degrades to the default instead of discarding the rest.
   */
  worktreeRetention: z.number().int().min(0).max(1000).default(10).catch(10),
  /**
   * Per-task memory ceiling in MiB (whole process tree). When a running task's
   * RSS crosses this the engine pauses it with a warning and lets the queue
   * advance (#memory-guard). 0 / unset = no limit. `.catch(undefined)` keeps
   * the key additive-safe: a bad value degrades to "no limit".
   */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).optional().catch(undefined),
  /**
   * Which agent backend a task uses unless overridden per task (GUI) or per
   * step (workflow). The GUI only offers runners actually installed; this is
   * the preselected default. Also the runner the chain planner uses.
   */
  defaultRunner: z.enum(['claude', 'codex', 'opencode']).default('claude'),
  /** Model for the chain planner (spec 008) — cheap but reliable at JSON. */
  plannerModel: z.string().min(1).default('sonnet'),
  /** Model for the task namer (spec 2026-07-17-task-auto-naming) — the cheapest
   *  alias that answers strict JSON; naming is fire-and-forget and never blocks. */
  namerModel: z.string().min(1).default('haiku'),
  /** Live title updates: refresh the display title through the namer on each
   *  turn end. Absent = the `CEZ_TITLE_UPDATES` env decides (default ON — owner
   *  decision on PR #479). */
  liveTitleUpdates: z.boolean().optional(),
  /**
   * Branch task worktrees fork from and draft PRs target (e.g. `develop`).
   * Unset = the branch currently checked out. Settable from the Repo tab.
   */
  baseBranch: z.string().trim().min(1).optional(),
  /**
   * Default extra system prompt applied to every run's agent steps (claude:
   * `--append-system-prompt`; codex/opencode: prepended to the opening user
   * message — the AgentRunSpec seam handles the per-backend delivery).
   * Settings is the single edit place; `POST /api/runs` can override it per
   * run (`systemPrompt`). `.catch(undefined)` keeps the key additive-safe: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  systemPrompt: z.string().trim().min(1).max(20_000).optional().catch(undefined),
  /**
   * Per-runner default model preset (Settings → Agents, redesign R6 1.5): the
   * model id the composer preselects for that runner. Missing = auto (the
   * runner decides). A capability (`model`), never a vendor config format.
   * `.catch(undefined)` keeps the key additive-safe like `systemPrompt`: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  defaultModels: z
    .object({
      claude: z.string().trim().min(1).max(200).optional(),
      codex: z.string().trim().min(1).max(200).optional(),
      opencode: z.string().trim().min(1).max(200).optional(),
    })
    .optional()
    .catch(undefined),
});

export type CezConfig = z.infer<typeof configSchema>;

/** Read `.ai/cezar/config.json` on demand — never cached, never throws. */
export async function loadConfig(repoRoot: string): Promise<CezConfig> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    return configSchema.parse({});
  }
  try {
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through — malformed JSON degrades to the default
  }
  return configSchema.parse({});
}
