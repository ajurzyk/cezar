'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { revalidatePath } from 'next/cache';

export interface SaveConfigState {
  ok?: boolean;
  error?: string;
}

export async function saveWorkspaceConfig(
  _prev: SaveConfigState,
  formData: FormData,
): Promise<SaveConfigState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can update settings' };

  const config = {
    sync: {
      digestBatchSize: num(formData, 'sync.digestBatchSize', 20),
      duplicateBatchSize: num(formData, 'sync.duplicateBatchSize', 30),
      minDuplicateConfidence: float(formData, 'sync.minDuplicateConfidence', 0.8),
      includeClosed: bool(formData, 'sync.includeClosed'),
      staleDaysThreshold: num(formData, 'sync.staleDaysThreshold', 90),
      staleCloseDays: num(formData, 'sync.staleCloseDays', 14),
    },
    autofix: {
      enabled: bool(formData, 'autofix.enabled'),
      baseBranch: str(formData, 'autofix.baseBranch', 'main'),
      branchPrefix: str(formData, 'autofix.branchPrefix', 'autofix/cezar-issue-'),
      maxAttemptsPerIssue: num(formData, 'autofix.maxAttemptsPerIssue', 2),
      tokenBudgetPerAttempt: num(formData, 'autofix.tokenBudgetPerAttempt', 250000),
      minBugConfidence: float(formData, 'autofix.minBugConfidence', 0.7),
      minAnalyzerConfidence: float(formData, 'autofix.minAnalyzerConfidence', 0.5),
      autoProceedConfidence: float(formData, 'autofix.autoProceedConfidence', 0),
      requireReviewPass: bool(formData, 'autofix.requireReviewPass'),
      retryOnReviewFailure: bool(formData, 'autofix.retryOnReviewFailure'),
      draftPr: bool(formData, 'autofix.draftPr'),
      prLabels: str(formData, 'autofix.prLabels', 'cezar-autofix').split(',').map((s) => s.trim()).filter(Boolean),
      setupCommands: ((formData.get('autofix.setupCommands') as string) ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      models: {
        analyzer: str(formData, 'autofix.models.analyzer', 'claude-sonnet-4-20250514'),
        fixer: str(formData, 'autofix.models.fixer', 'claude-sonnet-4-20250514'),
        reviewer: str(formData, 'autofix.models.reviewer', 'claude-haiku-4-5-20251001'),
      },
      maxTurns: {
        analyzer: num(formData, 'autofix.maxTurns.analyzer', 15),
        fixer: num(formData, 'autofix.maxTurns.fixer', 30),
        reviewer: num(formData, 'autofix.maxTurns.reviewer', 10),
      },
      projectEnv: {
        kind: enumStr(formData, 'autofix.projectEnv.kind', ['auto', 'native', 'compose'], 'auto'),
        install: rawStr(formData, 'autofix.projectEnv.install'),
        build: rawStr(formData, 'autofix.projectEnv.build'),
        test: rawStr(formData, 'autofix.projectEnv.test'),
        compose: {
          file: rawStr(formData, 'autofix.projectEnv.compose.file'),
          service: rawStr(formData, 'autofix.projectEnv.compose.service'),
          workdir: str(formData, 'autofix.projectEnv.compose.workdir', '/app'),
        },
        envVars: parseEnvVars(formData.get('autofix.projectEnv.envVars') as string | null),
        gateOnInstall: bool(formData, 'autofix.projectEnv.gateOnInstall'),
        gateOnBuild: bool(formData, 'autofix.projectEnv.gateOnBuild'),
        gateOnTest: bool(formData, 'autofix.projectEnv.gateOnTest'),
      },
    },
  };

  const rawMode = (formData.get('issueAutofixMode') as string | null) ?? 'off';
  const issueAutofixMode =
    rawMode === 'notify' || rawMode === 'autonomous' ? rawMode : 'off';

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('workspaces')
    .update({ config, issue_autofix_mode: issueAutofixMode })
    .eq('id', workspace.id);

  if (error) return { error: error.message };
  revalidatePath('/settings');
  return { ok: true };
}

function str(fd: FormData, key: string, fallback: string): string {
  return (fd.get(key) as string)?.trim() || fallback;
}
/** Trimmed string, defaulting to '' (no fallback) — for optional command fields. */
function rawStr(fd: FormData, key: string): string {
  return (fd.get(key) as string)?.trim() || '';
}
function enumStr<T extends string>(fd: FormData, key: string, allowed: readonly T[], fallback: T): T {
  const v = (fd.get(key) as string)?.trim();
  return allowed.includes(v as T) ? (v as T) : fallback;
}
/** Parse `KEY=VALUE` lines into a record; blank lines and lines without `=` are ignored. */
function parseEnvVars(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
function num(fd: FormData, key: string, fallback: number): number {
  const v = Number(fd.get(key));
  return Number.isFinite(v) ? v : fallback;
}
function float(fd: FormData, key: string, fallback: number): number {
  const v = parseFloat(fd.get(key) as string);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}
function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === 'on' || fd.get(key) === 'true';
}
