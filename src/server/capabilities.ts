/**
 * Deployment-mode capabilities (cockpit-ui redesign spec §"Deployment modes —
 * local vs hosted"). The default deployment is `npx cezar-cli` on localhost,
 * where handing a session off to a local terminal/editor makes sense. On a
 * VPS/remote box it doesn't: `CEZ_REMOTE=1` (or binding a non-loopback host)
 * switches to hosted mode — `/api/health` reports `localHandoff:false`, the UI
 * hides every local-machine affordance, and the open-in-* endpoints 409 as
 * defense in depth.
 */

export interface Capabilities {
  localHandoff: boolean;
}

/** True for hosts that only the local machine can reach. Undefined = the
 *  default bind (127.0.0.1). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** `CEZ_REMOTE=1` or a non-loopback bind host ⇒ hosted mode (no local handoff).
 *  Read per request — cheap, and tests/ops can flip the env live. */
export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env, bindHost?: string): Capabilities {
  return { localHandoff: env.CEZ_REMOTE !== '1' && isLoopbackHost(bindHost) };
}
