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

/** Every IPv4 address in 127.0.0.0/8, anchored. Anchoring is load-bearing: a
 *  `startsWith('127.')` test also matches attacker-controlled *hostnames* like
 *  `127.0.0.1.evil.com`, which is exactly the DNS-rebinding bypass #426 is
 *  about — see `isLoopbackHostHeader`. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Strip the port, IPv6 brackets, the FQDN trailing dot and the IPv6 zone id,
 *  then lowercase. `[::1]:4321` → `::1`, `localhost.:4321` → `localhost`. */
export function normalizeHostname(host: string): string {
  const bracketed = host.match(/^\[([^\]]+)\]/);
  // A bare IPv6 literal has >1 colon and cannot carry a port without brackets,
  // so only a single-colon host is `name:port`.
  const bare = bracketed?.[1] ?? (host.split(':').length > 2 ? host : (host.split(':')[0] ?? ''));
  return bare.toLowerCase().replace(/%.*$/, '').replace(/\.$/, '');
}

/** True for every textual form of the IPv6 loopback `::1` — `::1`, `0:0:0:0:0:0:0:1`,
 *  `0000:...:0001`. Anything unparseable is false (fail closed). */
function isIpv6Loopback(h: string): boolean {
  if (!h.includes(':')) return false;
  const halves = h.split('::');
  if (halves.length > 2) return false;
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    if (head.length + tail.length > 7) return false;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    groups = h.split(':');
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return false;
  return groups.slice(0, 7).every((g) => parseInt(g, 16) === 0) && parseInt(groups[7]!, 16) === 1;
}

/** True when the hostname names this machine and nothing else. */
function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || LOOPBACK_V4.test(hostname) || isIpv6Loopback(hostname);
}

/** True for bind hosts that only the local machine can reach. Undefined = the
 *  default bind (127.0.0.1), hence trusted — this is a *configuration* value we
 *  chose, not a request header. Do NOT use this on attacker-controlled input;
 *  use `isLoopbackHostHeader`, which fails closed on a missing host. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  return isLoopbackName(normalizeHostname(host));
}

/** True for a request's `Host`/`Origin` hostname when it names this machine.
 *  The untrusted-input twin of `isLoopbackHost`: a missing or unparseable host
 *  is **untrusted** (false), because absent is not the same as "we defaulted to
 *  loopback" once the value arrives over the wire (#426). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(normalizeHostname(host));
}

/** `CEZ_REMOTE=1` or a non-loopback bind host ⇒ hosted mode (no local handoff).
 *  Read per request — cheap, and tests/ops can flip the env live. */
export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env, bindHost?: string): Capabilities {
  return { localHandoff: env.CEZ_REMOTE !== '1' && isLoopbackHost(bindHost) };
}
