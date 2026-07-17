/**
 * Server capabilities reported by `/api/health` — the UI hides what the server
 * says isn't there, and the matching endpoints refuse as defense in depth.
 *
 * `localHandoff` (cockpit-ui redesign spec §"Deployment modes — local vs
 * hosted"): the default deployment is `npx cezar-cli` on localhost, where
 * handing a session off to a local terminal/editor makes sense. On a VPS/remote
 * box it doesn't: `CEZ_REMOTE=1` (or binding a non-loopback host) switches to
 * hosted mode — the UI hides every local-machine affordance and the open-in-*
 * endpoints 409.
 *
 * `followups` (spec 007, #444, #471): the global follow-up inbox is **opt-in**
 * via `CEZ_FOLLOWUPS=1` and off by default. Off, agents are never told to write
 * `todos.json` (they get `HANDOFF_ONLY_INSTRUCTIONS` and an empty
 * `CEZ_TODOS_FILE`), the Inbox nav item is gone and the inbox endpoints refuse.
 * The per-task handoff journal is independent and runs either way.
 */

import { followupsEnabled } from '../handoff.js';

export interface Capabilities {
  localHandoff: boolean;
  followups: boolean;
}

/** True for hosts that only the local machine can reach. Undefined = the
 *  default bind (127.0.0.1). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** `CEZ_REMOTE=1` or a non-loopback bind host ⇒ hosted mode (no local handoff).
 *  `CEZ_FOLLOWUPS=1` ⇒ the follow-up inbox exists (#471).
 *  Read per request — cheap, and tests/ops can flip the env live. */
export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env, bindHost?: string): Capabilities {
  return {
    localHandoff: env.CEZ_REMOTE !== '1' && isLoopbackHost(bindHost),
    // Deliberately not re-derived here: RunManager enforces the same predicate,
    // and two spellings of "is the inbox on" would eventually disagree.
    followups: followupsEnabled(env),
  };
}
