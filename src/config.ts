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
  /** Model for the chain planner (spec 008) — cheap but reliable at JSON. */
  plannerModel: z.string().min(1).default('sonnet'),
  /**
   * Branch task worktrees fork from and draft PRs target (e.g. `develop`).
   * Unset = the branch currently checked out. Settable from the Repo tab.
   */
  baseBranch: z.string().trim().min(1).optional(),
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
