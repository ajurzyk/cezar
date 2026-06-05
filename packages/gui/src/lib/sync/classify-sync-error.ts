import type { SyncErrorKind } from '@/lib/supabase/types';

// ─────────────────────────────────────────────────────────────────────
// §3: Stale & actionable states — classify a caught sync error into a
// `SyncErrorKind` so the indicator can show a recovery CTA instead of a raw
// message. We string-match the *normalized* error messages thrown by core's
// `GitHubService#handleError` (401/403/404) and `GitHubAppService
// #getInstallationToken` ("App is not installed …"), and also tolerate the raw
// Octokit `.status` shape in case an un-normalized error bubbles up.
// ─────────────────────────────────────────────────────────────────────
export function classifySyncError(err: unknown): SyncErrorKind {
  // Raw Octokit errors carry a numeric `.status`; map it directly when present
  // (a 403 here is GitHub's combined rate-limit/forbidden, matching handleError).
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (status === 401) return 'auth';
    if (status === 403) return 'rate_limit';
    if (status === 404) return 'not_found';
  }

  const message = err instanceof Error ? err.message : String(err ?? '');

  // 401 → invalid/revoked token; App-uninstalled is also an auth-recovery case.
  if (
    message.includes('Invalid GitHub token') ||
    message.includes('GitHub App is not installed')
  ) {
    return 'auth';
  }
  // 403 → GitHub's "rate limit exceeded or access forbidden" (treat as transient).
  if (message.includes('rate limit exceeded or access forbidden')) {
    return 'rate_limit';
  }
  // 404 → "Repo '…' not found or inaccessible."
  if (message.includes('not found or inaccessible')) {
    return 'not_found';
  }
  return 'unknown';
}
