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
async function startOrigin(): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: 42 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

/** A CONNECT-tunnelling proxy that counts the tunnels it is asked to open. */
async function startProxy(): Promise<{ server: Server; url: string; tunnels: string[] }> {
  const tunnels: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, tunnels };
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
});
