import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { AddressInfo } from 'node:net';
import { getJson } from './http.js';
import { CcbError } from '../errors.js';

/**
 * These tests answer the question the whole proxy change rests on: does a
 * request actually travel through the configured proxy?
 *
 * Asserting that an agent was constructed would not answer it — that is the
 * mistake that let Swttch/swttch#432 pass its tests while changing nothing for
 * users. So a real CONNECT proxy is stood up here and the assertion is that the
 * proxy saw the connection.
 */

/** A destination server that reports whether it was reached, and how. */
async function startOrigin(): Promise<{
  server: Server; url: string; seen: string[]; releaseHeld: () => void;
}> {
  const seen: string[] = [];
  // Requests to /never are answered by never answering, so their sockets outlive
  // the test that made them and server.close() would wait on each one forever.
  const held = new Set<{ destroy: () => void }>();
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    held.add(req.socket);
    req.socket.on('close', () => held.delete(req.socket));
    if (req.url === '/not-json') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>blocked by corporate proxy</html>');
      return;
    }
    if (req.url === '/boom') {
      res.writeHead(503, 'Service Unavailable');
      res.end('');
      return;
    }
    // The destination's own refusal, for telling apart from a proxy's. Same
    // status, same words, different source.
    if (req.url === '/forbidden') {
      res.writeHead(403, 'Forbidden');
      res.end('');
      return;
    }
    if (req.url === '/rate-limited') {
      res.writeHead(429, 'Too Many Requests', { 'retry-after': '42' });
      res.end('');
      return;
    }
    if (req.url === '/never') {
      // Accept the request and say nothing, so only a deadline ends it.
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: 42 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    seen,
    releaseHeld: () => { for (const socket of held) socket.destroy(); held.clear(); },
  };
}

/**
 * A CONNECT-tunnelling proxy that counts the tunnels it is asked to open.
 *
 * `refuseWith` makes it answer CONNECT with a status instead of tunnelling, and
 * `delayMs` makes it think before answering. Both model things a corporate proxy
 * does and neither can be observed without a proxy that really does them.
 */
async function startProxy(): Promise<{
  server: Server;
  url: string;
  tunnels: string[];
  refuseWith: (status: number, text: string) => void;
  delayMs: (ms: number) => void;
  releaseHeld: () => void;
}> {
  const tunnels: string[] = [];
  // Sockets the proxy is holding open. A CONNECT it was asked to answer slowly is
  // still parked here after the client gives up, and server.close() waits for
  // every one of them, so the teardown has to end them itself.
  const held = new Set<{ destroy: () => void }>();
  let refusal: { status: number; text: string } | undefined;
  let delay = 0;
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.push(req.url ?? '');
    held.add(clientSocket);
    clientSocket.on('close', () => held.delete(clientSocket));
    const proceed = () => {
      if (refusal) {
        clientSocket.write(`HTTP/1.1 ${refusal.status} ${refusal.text}\r\nConnection: close\r\n\r\n`);
        clientSocket.end();
        return;
      }
      const [host, port] = (req.url ?? '').split(':');
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    };
    if (delay > 0) setTimeout(proceed, delay).unref();
    else proceed();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    tunnels,
    refuseWith: (status, text) => { refusal = { status, text }; },
    delayMs: (ms) => { delay = ms; },
    releaseHeld: () => { for (const socket of held) socket.destroy(); held.clear(); },
  };
}

describe('getJson()', () => {
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    origin = await startOrigin();
    proxy = await startProxy();
    savedEnv = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    process.env = savedEnv;
    proxy.releaseHeld();
    origin.releaseHeld();
    await new Promise<void>((r) => origin.server.close(() => r()));
    await new Promise<void>((r) => proxy.server.close(() => r()));
  });

  describe('without a proxy configured', () => {
    it('reaches the origin directly and parses the body', async () => {
      const res = await getJson<{ five_hour: { utilization: number } }>(
        `${origin.url}/api/oauth/usage`,
        { Authorization: 'Bearer t' },
      );
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 200);
      assert.deepEqual(res.body, { five_hour: { utilization: 42 } });
      assert.deepEqual(proxy.tunnels, [], 'no proxy configured, so none should be used');
    });

    it('sends the headers it was given', async () => {
      await getJson(`${origin.url}/x`, { Authorization: 'Bearer my-token' });
      assert.deepEqual(origin.seen, ['Bearer my-token']);
    });

    it('reports a non-2xx response as not ok rather than throwing', async () => {
      const res = await getJson(`${origin.url}/boom`, {});
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.statusText, 'Service Unavailable');
    });
  });

  describe('with a proxy configured', () => {
    // The claim under test: the request goes THROUGH the proxy. The origin is
    // reachable directly, so a request that skipped the proxy would still
    // succeed — only the tunnel count can tell the two apart.
    it('routes the request through the proxy', async () => {
      process.env.HTTP_PROXY = proxy.url;

      const res = await getJson<{ five_hour: unknown }>(`${origin.url}/api/oauth/usage`, {
        Authorization: 'Bearer t',
      });

      assert.strictEqual(res.ok, true);
      assert.deepEqual(res.body, { five_hour: { utilization: 42 } });
      assert.strictEqual(proxy.tunnels.length, 1, 'the proxy should have been asked for exactly one tunnel');
      assert.ok(proxy.tunnels[0]?.startsWith('127.0.0.1:'), `tunnel target was ${proxy.tunnels[0]}`);
    });

    it('honors the lowercase spelling as well', async () => {
      process.env.http_proxy = proxy.url;
      await getJson(`${origin.url}/x`, {});
      assert.strictEqual(proxy.tunnels.length, 1);
    });

    it('falls back to ALL_PROXY', async () => {
      process.env.ALL_PROXY = proxy.url;
      await getJson(`${origin.url}/x`, {});
      assert.strictEqual(proxy.tunnels.length, 1);
    });

    // The negative control. Same proxy, same origin — only NO_PROXY differs, so
    // if this still tunnelled, the assertion above would prove nothing.
    it('goes direct when NO_PROXY exempts the host', async () => {
      process.env.HTTP_PROXY = proxy.url;
      process.env.NO_PROXY = '127.0.0.1';

      const res = await getJson(`${origin.url}/x`, {});

      assert.strictEqual(res.ok, true);
      assert.deepEqual(proxy.tunnels, [], 'NO_PROXY should have kept this off the proxy');
    });

    it('reports a dead proxy as a proxy problem, not a bare errno', async () => {
      // Close the proxy so connecting to it refuses, and point at it anyway.
      await new Promise<void>((r) => proxy.server.close(() => r()));
      process.env.HTTP_PROXY = proxy.url;

      await assert.rejects(
        () => getJson(`${origin.url}/x`, {}),
        (err: unknown) => {
          assert.ok(err instanceof CcbError, `expected CcbError, got ${String(err)}`);
          assert.strictEqual(err.code, 'network_error');
          assert.match(err.hint ?? '', /proxy/i);
          return true;
        },
      );
    });
  });

  it('rejects a non-JSON body with a message that points at the proxy', async () => {
    process.env.HTTP_PROXY = proxy.url;
    await assert.rejects(
      () => getJson(`${origin.url}/not-json`, {}),
      (err: unknown) => err instanceof CcbError && err.code === 'api_error',
    );
  });

  /**
   * A proxy that refuses a CONNECT does not make the request fail.
   * https-proxy-agent replays the refusal onto a stand-in socket, so node's HTTP
   * parser reads the proxy's own status as though the destination had sent it.
   * The reporter on Swttch/swttch#432 was shown "API error 403: Forbidden" and
   * had no way to tell which machine had said it.
   */
  describe('when the proxy refuses the tunnel', () => {
    it('names the proxy rather than reporting the refusal as an API answer', async () => {
      proxy.refuseWith(403, 'Forbidden');
      process.env.HTTP_PROXY = proxy.url;

      await assert.rejects(
        () => getJson(`${origin.url}/api/oauth/usage`, {}),
        (err: unknown) => {
          assert.ok(err instanceof CcbError, `expected CcbError, got ${String(err)}`);
          assert.strictEqual(err.code, 'proxy_rejected');
          assert.strictEqual(err.details?.proxyConnectStatus, 403);
          assert.strictEqual(err.details?.reachedDestination, false);
          assert.match(err.message, /proxy refused/i);
          return true;
        },
      );
      assert.deepEqual(origin.seen, [], 'the request must never have reached the origin');
    });

    it('tells a 407 apart, since that one the user can fix in the proxy URL', async () => {
      proxy.refuseWith(407, 'Proxy Authentication Required');
      process.env.HTTP_PROXY = proxy.url;

      await assert.rejects(
        () => getJson(`${origin.url}/x`, {}),
        (err: unknown) => {
          assert.ok(err instanceof CcbError);
          assert.strictEqual(err.code, 'proxy_rejected');
          assert.strictEqual(err.details?.proxyConnectStatus, 407);
          assert.match(err.hint ?? '', /authentication/i);
          return true;
        },
      );
    });

    // The control that gives the two tests above their meaning. Identical status,
    // identical wording, and it must NOT be blamed on the proxy — the tunnel
    // opened and the destination is the one that said no.
    it('does not blame the proxy for a 403 the destination itself sent', async () => {
      process.env.HTTP_PROXY = proxy.url;

      const res = await getJson(`${origin.url}/forbidden`, {});

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.statusText, 'Forbidden');
      assert.strictEqual(proxy.tunnels.length, 1, 'the tunnel did open');
      assert.strictEqual(origin.seen.length, 1, 'and the origin is what answered');
    });
  });

  describe('Retry-After', () => {
    it('surfaces the wait as a number so no caller has to read it out of prose', async () => {
      const res = await getJson(`${origin.url}/rate-limited`, {});
      assert.strictEqual(res.status, 429);
      assert.strictEqual(res.retryAfterSec, 42);
    });

    it('is absent when the destination did not ask for one', async () => {
      const res = await getJson(`${origin.url}/boom`, {});
      assert.strictEqual(res.retryAfterSec, undefined);
    });
  });

  /**
   * The deadline has to start before the socket does.
   *
   * A socket timeout cannot fire while a proxy is still deciding whether to open
   * the tunnel, because there is no socket yet. Measured against the previous
   * implementation, a proxy that sat on a CONNECT for 70 seconds ran to
   * completion against a guard documented as covering exactly that.
   */
  describe('the deadline', () => {
    it('fires while the proxy is still sitting on the CONNECT', async () => {
      proxy.delayMs(5_000);
      process.env.HTTP_PROXY = proxy.url;

      const startedAt = Date.now();
      await assert.rejects(
        () => getJson(`${origin.url}/x`, {}, { deadlineMs: 300 }),
        (err: unknown) => {
          assert.ok(err instanceof CcbError, `expected CcbError, got ${String(err)}`);
          assert.strictEqual(err.code, 'timeout');
          assert.strictEqual(err.details?.reachedDestination, false);
          assert.match(err.hint ?? '', /never finished opening the tunnel/i);
          return true;
        },
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1_500, `deadline was 300ms and the proxy's was 5000ms, but this took ${elapsed}ms`);
      assert.strictEqual(proxy.tunnels.length, 1, 'the proxy was asked, and simply never answered');
    });

    it('fires after the tunnel is open when the destination goes quiet, and says so', async () => {
      process.env.HTTP_PROXY = proxy.url;

      await assert.rejects(
        () => getJson(`${origin.url}/never`, {}, { deadlineMs: 300 }),
        (err: unknown) => {
          assert.ok(err instanceof CcbError);
          assert.strictEqual(err.code, 'timeout');
          assert.strictEqual(err.details?.reachedDestination, true);
          assert.match(err.hint ?? '', /tunnel was open/i);
          return true;
        },
      );
    });

    it('covers a direct request too', async () => {
      await assert.rejects(
        () => getJson(`${origin.url}/never`, {}, { deadlineMs: 300 }),
        (err: unknown) => err instanceof CcbError && err.code === 'timeout',
      );
    });

    it('takes the budget its spawner set, so a caller with less time gets our error first', async () => {
      const previous = process.env.CCB_REQUEST_TIMEOUT_MS;
      process.env.CCB_REQUEST_TIMEOUT_MS = '250';
      try {
        const startedAt = Date.now();
        await assert.rejects(
          () => getJson(`${origin.url}/never`, {}),
          (err: unknown) => err instanceof CcbError && err.code === 'timeout',
        );
        assert.ok(Date.now() - startedAt < 3_000, 'the environment budget should have applied');
      } finally {
        if (previous === undefined) delete process.env.CCB_REQUEST_TIMEOUT_MS;
        else process.env.CCB_REQUEST_TIMEOUT_MS = previous;
      }
    });
  });
});
