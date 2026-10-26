import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { runOperation, checkParams, readableReason } from './run.js';
import { findOperation, OPERATIONS, operationCapabilities } from './operations.js';

describe('swttch-ext api', () => {
  let server: Server;
  let baseUrl: string;
  let seen: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }>;
  let respond: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    seen = [];
    respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        respond(req, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const run = (name: string, values: Record<string, string>, yes = false) =>
    runOperation('frame', name, values, { baseUrl, token: 'tok', yes });

  describe('the table', () => {
    it('names every call, with a capability a caller can look for', () => {
      assert.deepEqual(operationCapabilities().sort(), ['api.frame.delete', 'api.frame.duplicate', 'api.frame.list', 'api.frame.pin', 'api.frame.retitle', 'api.frame.unpin']);
      assert.equal(new Set(OPERATIONS.map((o) => `${o.service}.${o.name}`)).size, OPERATIONS.length);
    });

    it('marks only the call that cannot be undone as destructive', () => {
      assert.deepEqual(OPERATIONS.filter((o) => o.destructive).map((o) => o.name), ['delete']);
    });
  });

  describe('list', () => {
    it('gets the artifacts, with the limit as a query', async () => {
      respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"frames":[{"slug":"a","title":"T"}]}'); };
      const result = await run('list', { limit: '5' });
      assert.deepEqual(result, { ok: true, data: { frames: [{ slug: 'a', title: 'T' }] } });
      assert.deepEqual([seen[0].method, seen[0].url, seen[0].body], ['GET', '/api/frame/frames?limit=5', '']);
    });

    it('sends the artifact service\'s client headers, naming this tool and its version', async () => {
      await runOperation('frame', 'list', {}, { baseUrl, token: 'tok', version: '9.9.9' });
      assert.equal(seen[0].url, '/api/frame/frames');
      assert.equal(seen[0].headers['x-frame-surface'], 'code');
      assert.equal(seen[0].headers['x-frame-cp'], 'go');
      assert.equal(seen[0].headers['x-frame-client-version'], 'swttch-ext/9.9.9');
    });

    it('refuses a limit that is not a whole number in range', async () => {
      for (const limit of ['0', '-1', '1.5', 'abc', '201']) {
        const result = await run('list', { limit });
        assert.equal(result.ok, false, `"${limit}" got through`);
      }
      assert.equal(seen.length, 0);
    });
  });

  describe('retitle', () => {
    it('posts the new name to the artifact\'s retitle path with the login and the beta flag', async () => {
      const result = await run('retitle', { slug: 'abc_123', title: '새 이름' });
      assert.deepEqual(result, { ok: true, data: { ok: true } });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/api/frame/retitle/abc_123');
      assert.equal(seen[0].headers.authorization, 'Bearer tok');
      assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
      assert.equal(seen[0].headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(seen[0].body), { title: '새 이름' });
    });

    it('says an artifact that is gone or not the caller\'s is not found', async () => {
      respond = (_req, res) => { res.writeHead(404); res.end('nope'); };
      const result = await run('retitle', { slug: 'x', title: 'y' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'not_found');
        assert.equal(result.error.status, 404);
      }
    });

    it('says a page without a title cannot be renamed', async () => {
      respond = (_req, res) => { res.writeHead(422); res.end('{"reason":"content_refused"}'); };
      const result = await run('retitle', { slug: 'x', title: 'y' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'rejected');
        assert.match(result.error.message, /<title>/);
      }
    });

    it('carries the server\'s reason when a name is refused', async () => {
      respond = (_req, res) => { res.writeHead(400); res.end('title too long'); };
      const result = await run('retitle', { slug: 'x', title: 'y' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'rejected');
        assert.match(result.error.message, /title too long/);
      }
    });
  });

  describe('pin and unpin', () => {
    it('use POST and DELETE on the same path, with no body', async () => {
      await run('pin', { slug: 'abc' });
      await run('unpin', { slug: 'abc' });
      assert.deepEqual(seen.map((r) => [r.method, r.url, r.body]), [
        ['POST', '/api/frame/favorite/abc', ''],
        ['DELETE', '/api/frame/favorite/abc', ''],
      ]);
    });
  });

  describe('duplicate', () => {
    it('posts to the copy path with no body and hands back the answer', async () => {
      respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"slug":"new1","copied":{"db":true}}'); };
      const result = await run('duplicate', { slug: 'abc' });
      assert.deepEqual(seen.map((r) => [r.method, r.url, r.body]), [['POST', '/api/frame/duplicate/abc', '']]);
      assert.equal(result.ok, true);
      assert.equal((result as { ok: true; data: { slug: string } }).data.slug, 'new1');
    });
  });

  describe('delete', () => {
    it('does nothing without --yes, and says why', async () => {
      const result = await run('delete', { slug: 'abc' });
      assert.equal(seen.length, 0);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'confirmation_required');
    });

    it('deletes with --yes, and takes an empty answer as done', async () => {
      respond = (_req, res) => { res.writeHead(204); res.end(); };
      const result = await run('delete', { slug: 'abc' }, true);
      assert.deepEqual(result, { ok: true, data: null });
      assert.deepEqual([seen[0].method, seen[0].url], ['DELETE', '/api/frame/abc']);
    });

    it('asks once more after a "not now" answer, and no more than once', async () => {
      let count = 0;
      respond = (_req, res) => {
        count++;
        if (count === 1) { res.writeHead(503, { 'retry-after': '0' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      };
      assert.equal((await run('delete', { slug: 'abc' }, true)).ok, true);
      assert.equal(count, 2);

      count = 0;
      respond = (_req, res) => { count++; res.writeHead(503, { 'retry-after': '0' }); res.end(); };
      const failed = await run('delete', { slug: 'abc' }, true);
      assert.equal(count, 2);
      assert.equal(failed.ok, false);
    });
  });

  describe('what the server says about the login', () => {
    it('tells an expired login from a refusal and from a rate limit', async () => {
      const codeFor = async (status: number) => {
        respond = (_req, res) => { res.writeHead(status); res.end(); };
        const r = await run('pin', { slug: 'a' });
        return r.ok ? 'ok' : r.error.code;
      };
      assert.equal(await codeFor(401), 'token_expired');
      assert.equal(await codeFor(403), 'forbidden');
      assert.equal(await codeFor(429), 'rate_limited');
      assert.equal(await codeFor(500), 'api_error');
    });
  });

  describe('readableReason', () => {
    it('takes the sentence out of a JSON error body, and leaves any other text as it is', () => {
      assert.equal(readableReason('{"error":"no title","reason":"x"}'), 'no title');
      assert.equal(readableReason('{"type":"error","error":{"type":"x","message":"Not found"}}'), 'Not found');
      assert.equal(readableReason('plain text'), 'plain text');
      assert.equal(readableReason('{"nothing":1}'), '{"nothing":1}');
    });
  });

  describe('what it refuses before sending anything', () => {
    it('refuses a call that is not in the table', async () => {
      const result = await runOperation('frame', 'purge', {}, { baseUrl, token: 'tok' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'unknown_operation');
      assert.equal(seen.length, 0);
    });

    it('refuses a missing, empty, unknown or oversized parameter', () => {
      const op = findOperation('frame', 'retitle')!;
      const code = (values: Record<string, string>) => {
        const r = checkParams(op, values);
        return r && !r.ok ? r.error.code : 'ok';
      };
      assert.equal(code({ slug: 'a' }), 'invalid_argument');
      assert.equal(code({ slug: 'a', title: '  ' }), 'invalid_argument');
      assert.equal(code({ slug: 'a', title: 'b', extra: 'c' }), 'invalid_argument');
      assert.equal(code({ slug: 'a', title: 'x'.repeat(301) }), 'invalid_argument');
      assert.equal(code({ slug: 'a', title: 'b' }), 'ok');
    });

    it('does not let an artifact id name another path', async () => {
      for (const slug of ['../x', 'a/b', 'a?b=1', 'a b', '%2e%2e']) {
        const result = await run('pin', { slug });
        assert.equal(result.ok, false, `"${slug}" got through`);
      }
      assert.equal(seen.length, 0);
    });
  });
});
