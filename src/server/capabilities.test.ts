import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.js';

/**
 * The two loopback predicates sit at different trust seams and must not be
 * collapsed into one (#426 / #467 review):
 *   - `isLoopbackHost(bindHost)`   — our own config. Undefined = "we defaulted
 *                                     to the loopback bind" ⇒ trusted.
 *   - `isLoopbackHostHeader(host)` — an attacker-controlled request header.
 *                                     Absent or unparseable ⇒ untrusted.
 * Both share an *anchored* address match: a `127.` string prefix also matches
 * registrable hostnames like `127.0.0.1.evil.com`, which was the DNS-rebinding
 * bypass this pair replaced.
 */

const REAL_LOOPBACK = ['localhost', '127.0.0.1', '127.0.0.2', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1'];

// Every one of these is registrable by an attacker and resolvable to 127.0.0.1.
const NOT_LOOPBACK = [
  '127.0.0.1.evil.com',
  '127.evil.com',
  '127.0.0.1.nip.io',
  '1270.0.0.1',
  '127.0.0.1x',
  '127.0.0.256',
  '127.0.0',
  'evil.com',
  '10.0.0.1',
  'localhost.evil.com',
  '::2',
  '::1:1',
];

describe('normalizeHostname', () => {
  it.each([
    ['127.0.0.1:4321', '127.0.0.1'],
    ['[::1]:4321', '::1'],
    ['[0:0:0:0:0:0:0:1]:4321', '0:0:0:0:0:0:0:1'],
    ['::1', '::1'], // bare IPv6 literal: >1 colon, so never `name:port`
    ['LocalHost.:4321', 'localhost'], // lowercased, trailing FQDN dot dropped
    ['fe80::1%eth0', 'fe80::1'], // IPv6 zone id stripped
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });
});

describe('isLoopbackHostHeader (untrusted request header)', () => {
  it.each(REAL_LOOPBACK)('accepts the real loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects the non-loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('rejects a missing Host header — absent is untrusted, not "defaulted"', () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });

  it('accepts loopback hosts that carry a port or brackets', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4321')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4321')).toBe(true);
    expect(isLoopbackHostHeader('localhost.:4321')).toBe(true);
  });
});

describe('isLoopbackHost (our own bind host)', () => {
  it.each(REAL_LOOPBACK)('accepts the real loopback bind %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects the non-loopback bind %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it('keeps its contract: an undefined bind host means the default loopback bind', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });
});

describe('resolveCapabilities', () => {
  it('keeps local handoff for the defaulted (undefined) bind host', () => {
    expect(resolveCapabilities({} as NodeJS.ProcessEnv, undefined).localHandoff).toBe(true);
  });

  it('keeps local handoff for an explicit loopback bind', () => {
    expect(resolveCapabilities({} as NodeJS.ProcessEnv, '127.0.0.1').localHandoff).toBe(true);
  });

  it('drops local handoff for a non-loopback bind', () => {
    expect(resolveCapabilities({} as NodeJS.ProcessEnv, '0.0.0.0').localHandoff).toBe(false);
  });

  it('drops local handoff when CEZ_REMOTE=1 even on a loopback bind', () => {
    expect(resolveCapabilities({ CEZ_REMOTE: '1' } as NodeJS.ProcessEnv, '127.0.0.1').localHandoff).toBe(false);
  });
});
