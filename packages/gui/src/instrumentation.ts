// Next 15 server-startup hook (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation).
//
// `instrumentation.ts` is evaluated on every runtime (Node and Edge), so the
// actual scheduler boot — which transitively pulls in `@cezar/core` /
// `cosmiconfig` / Node built-ins — lives in `./instrumentation-node.ts` and is
// only ever imported on the Node.js runtime via the documented pattern below.
//
// The in-process scheduler is the only cron driver (the Vercel `vercel.json`
// schedules were removed). It defaults ON for any real deployment — detected by
// the presence of `CRON_SECRET`, which the cron routes require — so a deploy
// can't silently end up with no crons. `CEZAR_INPROCESS_CRON=true` forces it on
// even without a secret; `=false` is the explicit opt-out (e.g. local `next
// dev`, or replicas that should not schedule).

function schedulerEnabled(): boolean {
  const flag = process.env.CEZAR_INPROCESS_CRON;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return Boolean(process.env.CRON_SECRET);
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!schedulerEnabled()) return;
  await import('./instrumentation-node');
}
