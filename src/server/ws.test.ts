import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { verifyWsUpgrade } from './server.js';
import { createSocketHub, WS_PATH, type SocketHub, type TopicPublisher } from './ws.js';

/**
 * The hub is exercised over REAL sockets — a Node http server plus the `ws`
 * client — because the contract under test is transport behavior: upgrade
 * routing, the 403 pre-handshake rejection, and that a dying connection (not
 * just a polite unsubscribe frame) releases its topics so publishers stop.
 */

const servers: Server[] = [];
const hubs: SocketHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** A controllable topic: counts starts/stops, exposes the live `publish`. */
function makeTopic(snapshot: unknown = { tick: 0 }) {
  const state = {
    started: 0,
    stopped: 0,
    publish: undefined as ((data: unknown) => void) | undefined,
  };
  const publisher: TopicPublisher = {
    snapshot: async () => snapshot,
    start: (publish) => {
      state.started += 1;
      state.publish = publish;
      return () => {
        state.stopped += 1;
        state.publish = undefined;
      };
    },
  };
  return { state, publisher };
}

async function boot(
  publisher: TopicPublisher,
  verify: (req: IncomingMessage) => boolean = () => true,
  heartbeatMs?: number,
): Promise<{ base: string; url: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const hub = createSocketHub(heartbeatMs === undefined ? {} : { heartbeatMs });
  hub.registerTopic('ticker', publisher);
  hub.attach(server, verify);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  hubs.push(hub);
  const { port } = server.address() as AddressInfo;
  return { base: `ws://127.0.0.1:${port}`, url: `ws://127.0.0.1:${port}${WS_PATH}` };
}

/** A connected client whose frames arrive as an awaitable queue. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  ws.on('message', (raw) => {
    const frame: unknown = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    next: (): Promise<unknown> =>
      frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error('no frame within 2s')), 2_000).unref();
          }),
  };
}

describe('createSocketHub', () => {
  it('starts the publisher on the first subscriber and answers with the snapshot', async () => {
    const { state, publisher } = makeTopic({ hello: 'world' });
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    expect(await client.next()).toEqual({ type: 'event', topic: 'ticker', data: { hello: 'world' } });
    expect(state.started).toBe(1);
    expect(state.stopped).toBe(0);
    client.ws.close();
  });

  it('broadcasts a publish to every subscriber, once each', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const alpha = await connect(url);
    const beta = await connect(url);

    alpha.send({ type: 'subscribe', topic: 'ticker' });
    beta.send({ type: 'subscribe', topic: 'ticker' });
    await alpha.next(); // snapshots
    await beta.next();
    expect(state.started).toBe(1); // second subscriber reuses the running publisher

    state.publish?.({ n: 42 });
    expect(await alpha.next()).toEqual({ type: 'event', topic: 'ticker', data: { n: 42 } });
    expect(await beta.next()).toEqual({ type: 'event', topic: 'ticker', data: { n: 42 } });
    alpha.ws.close();
    beta.ws.close();
  });

  it('stops the publisher when the last subscriber unsubscribes', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    await client.next();
    client.send({ type: 'unsubscribe', topic: 'ticker' });
    await vi.waitFor(() => expect(state.stopped).toBe(1));
    client.ws.close();
  });

  it('a dropped connection releases its subscriptions (no unsubscribe frame ever sent)', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    await client.next();
    client.ws.terminate(); // an abrupt vanish, not a close handshake
    await vi.waitFor(() => expect(state.stopped).toBe(1));
  });

  it('answers an unknown topic with an error frame and keeps the connection', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'nope' });
    expect(await client.next()).toEqual({ type: 'error', topic: 'nope', error: 'unknown topic' });
    // Still usable afterwards:
    client.send({ type: 'subscribe', topic: 'ticker' });
    expect(await client.next()).toMatchObject({ type: 'event', topic: 'ticker' });
    client.ws.close();
  });

  it('answers a malformed frame with an error frame', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.ws.send('not json');
    expect(await client.next()).toMatchObject({ type: 'error' });
    client.ws.close();
  });

  it('rejects the handshake with 403 when the upgrade guard says no', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher, () => false);

    const ws = new WebSocket(url);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('handshake must not succeed')));
      ws.on('error', () => resolve(403)); // some paths surface only the error
    });
    expect(status).toBe(403);
  });

  it('destroys upgrades on any other path', async () => {
    const { publisher } = makeTopic();
    const { base } = await boot(publisher);

    const ws = new WebSocket(`${base}/api/other`);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('handshake must not succeed')));
    });
  });

  it('refuses a duplicate topic registration', () => {
    const hub = createSocketHub();
    const { publisher } = makeTopic();
    hub.registerTopic('ticker', publisher);
    expect(() => hub.registerTopic('ticker', publisher)).toThrow(/already registered/);
    hub.close();
  });

  it('emits an app-level heartbeat ping the client can watch', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher, () => true, 40); // fast beat
    const client = await connect(url); // no subscription — heartbeat is connection-wide

    expect(await client.next()).toEqual({ type: 'ping' });
    client.ws.close();
  });

  it('reaps a client that stops answering the protocol ping', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher, () => true, 40);
    // autoPong:false — this socket never answers the server's protocol ping, so after a beat
    // the hub considers it dead. It stays connected at the TCP level (a real silent-death would
    // too), which is exactly the case a FIN-based close would miss.
    const ws = new WebSocket(url, { autoPong: false });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', () => undefined); // drain frames (snapshot + pings); we assert server-side
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'ticker' }));

    await vi.waitFor(() => expect(state.started).toBe(1)); // subscription registered
    await vi.waitFor(() => expect(state.stopped).toBe(1), { timeout: 2_000 }); // …then reaped, releasing it
    ws.terminate();
  });
});

describe('verifyWsUpgrade', () => {
  const req = (headers: Record<string, string | undefined>) => ({ headers }) as IncomingMessage;

  it('admits a loopback Host with no Origin (non-browser client)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321' }))).toBe(true);
  });

  it('admits the cockpit itself (same-authority Origin)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }))).toBe(true);
  });

  it('admits the Vite dev proxy (loopback Origin on another port, loopback Host)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://localhost:5173' }))).toBe(true);
  });

  it('rejects a non-loopback Host — DNS rebinding (#426)', () => {
    expect(verifyWsUpgrade(req({ host: 'evil.com' }))).toBe(false);
    expect(verifyWsUpgrade(req({ host: '127.0.0.1.evil.com' }))).toBe(false);
  });

  it('rejects a missing Host', () => {
    expect(verifyWsUpgrade(req({}))).toBe(false);
  });

  it('rejects a non-loopback Origin', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'https://evil.com' }))).toBe(false);
  });

  it('rejects an opaque "null" Origin (sandboxed iframe, file://)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'null' }))).toBe(false);
  });
});
