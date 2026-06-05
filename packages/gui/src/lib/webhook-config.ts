/**
 * Whether the GitHub App webhook receiver is active server-side. The receiver
 * (`app/api/github/webhook/route.ts`) returns 503 — i.e. deliveries never land —
 * unless `GITHUB_APP_WEBHOOK_SECRET` is set. The layout reads this (with the
 * workspace's `installation_id` + `last_webhook_received_at`) to decide whether
 * the header indicator shows "⚡ Live" or "⏱ Polling" (spec §1). Server-only.
 */
export function isWebhookConfigured(): boolean {
  return !!process.env.GITHUB_APP_WEBHOOK_SECRET;
}
