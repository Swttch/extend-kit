import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { ClaudeCodeClient } from './client.js';
import { OAuthApi } from './oauth.js';

/**
 * These used to stub globalThis.fetch. The client no longer uses fetch — it
 * cannot be routed through a proxy (see src/proxy.ts) — so the requests are made
 * against a local server instead. That also makes the tests stricter: they now
 * observe what actually goes over the wire rather than what was handed to a stub.
 */
describe('ClaudeCodeClient', () => {
  let server: Server;
  let baseUrl: string;
  let requests: IncomingMessage[];
  let respond: (res: import('node:http').ServerResponse) => void;

  beforeEach(async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
    server = createServer((req, res) => {
      requests.push(req);
      respond(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('constructor', () => {
    it('accepts an explicit access token', () => {
      assert.ok(new ClaudeCodeClient('test-token') instanceof ClaudeCodeClient);
    });

    it('accepts no arguments', () => {
      assert.ok(new ClaudeCodeClient() instanceof ClaudeCodeClient);
    });
  });

  describe('.oauth', () => {
    it('returns an OAuthApi instance', () => {
      assert.ok(new ClaudeCodeClient('test-token').oauth instanceof OAuthApi);
    });

    it('returns the same instance on multiple accesses (lazy singleton)', () => {
      const client = new ClaudeCodeClient('test-token');
      assert.strictEqual(client.oauth, client.oauth);
    });
  });

  describe('._request', () => {
    describe('when constructed with explicit token', () => {
      it('sends a GET request with the Bearer token', async () => {
        const client = new ClaudeCodeClient('my-access-token', { baseUrl });
        await client._request('/test/path');

        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.method, 'GET');
        assert.strictEqual(requests[0]?.url, '/test/path');
        assert.strictEqual(requests[0]?.headers.authorization, 'Bearer my-access-token');
      });

      it('merges additional headers', async () => {
        const client = new ClaudeCodeClient('my-access-token', { baseUrl });
        await client._request('/test/path', {
          'x-custom-header': 'custom-value',
          'anthropic-beta': 'some-beta',
        });

        const headers = requests[0]?.headers ?? {};
        assert.strictEqual(headers.authorization, 'Bearer my-access-token');
        assert.strictEqual(headers['x-custom-header'], 'custom-value');
        assert.strictEqual(headers['anthropic-beta'], 'some-beta');
      });

      it('returns parsed JSON on success', async () => {
        const responseBody = { id: 'user_123', email: 'test@example.com' };
        respond = (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        };

        const client = new ClaudeCodeClient('my-access-token', { baseUrl });
        assert.deepEqual(await client._request('/api/profile'), responseBody);
      });

      it('throws on a non-ok response', async () => {
        respond = (res) => {
          res.writeHead(401, 'Unauthorized');
          res.end('');
        };

        const client = new ClaudeCodeClient('invalid-token', { baseUrl });
        await assert.rejects(
          () => client._request('/api/profile'),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /401/);
            assert.match(err.message, /Unauthorized/);
            return true;
          },
        );
      });
    });

    describe('when constructed with an API key', () => {
      it('sends x-api-key instead of a Bearer token', async () => {
        const client = new ClaudeCodeClient({ apiKey: 'sk-test' }, { baseUrl });
        await client._request('/api/profile');

        const headers = requests[0]?.headers ?? {};
        assert.strictEqual(headers['x-api-key'], 'sk-test');
        assert.strictEqual(headers['anthropic-version'], '2023-06-01');
        assert.strictEqual(headers.authorization, undefined);
      });
    });

    // There is deliberately no test here for the no-token path. It would come
    // down to whether the machine running the suite happens to be logged into
    // Claude Code, which is not a property of this code — and the previous
    // version of this file only passed because the request went to the real API
    // and came back 404. getCredentials() and its platform dispatch are covered
    // in ../auth/index.test.ts, where they can be tested without a network.

    describe('baseUrl', () => {
      it('defaults to the real API origin', () => {
        // Asserted through the request URL rather than a getter so the default
        // cannot drift from what is actually requested.
        assert.strictEqual(new ClaudeCodeClient('t')['baseUrl'], 'https://api.anthropic.com');
      });

      it('honors ANTHROPIC_BASE_URL, the variable the claude CLI reads', () => {
        const previous = process.env.ANTHROPIC_BASE_URL;
        process.env.ANTHROPIC_BASE_URL = 'https://gateway.internal/anthropic';
        try {
          assert.strictEqual(new ClaudeCodeClient('t')['baseUrl'], 'https://gateway.internal/anthropic');
        } finally {
          if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
          else process.env.ANTHROPIC_BASE_URL = previous;
        }
      });

      it('strips a trailing slash so paths do not double up', () => {
        assert.strictEqual(new ClaudeCodeClient('t', { baseUrl: 'https://gw.test/' })['baseUrl'], 'https://gw.test');
      });

      it('lets an explicit option win over the environment', () => {
        const previous = process.env.ANTHROPIC_BASE_URL;
        process.env.ANTHROPIC_BASE_URL = 'https://from-env.test';
        try {
          assert.strictEqual(new ClaudeCodeClient('t', { baseUrl: 'https://explicit.test' })['baseUrl'], 'https://explicit.test');
        } finally {
          if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
          else process.env.ANTHROPIC_BASE_URL = previous;
        }
      });
    });
  });
});
