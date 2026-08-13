import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeClient } from './client.js';
import { OAuthApi } from './oauth.js';

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

function makeMockResponse(overrides: Partial<MockResponse> = {}): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({}),
    ...overrides,
  };
}

describe('ClaudeCodeClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('accepts an explicit access token', () => {
      const client = new ClaudeCodeClient('test-token');
      assert.ok(client instanceof ClaudeCodeClient);
    });

    it('accepts no arguments', () => {
      const client = new ClaudeCodeClient();
      assert.ok(client instanceof ClaudeCodeClient);
    });
  });

  describe('.oauth', () => {
    it('returns an OAuthApi instance', () => {
      const client = new ClaudeCodeClient('test-token');
      assert.ok(client.oauth instanceof OAuthApi);
    });

    it('returns the same instance on multiple accesses (lazy singleton)', () => {
      const client = new ClaudeCodeClient('test-token');
      const first = client.oauth;
      const second = client.oauth;
      assert.strictEqual(first, second);
    });
  });

  describe('._request', () => {
    describe('when constructed with explicit token', () => {
      it('sends GET request with Bearer token', async () => {
        let capturedInput: RequestInfo | URL | undefined;
        let capturedInit: RequestInit | undefined;

        globalThis.fetch = async (input, init) => {
          capturedInput = input;
          capturedInit = init;
          return makeMockResponse({ json: async () => ({}) }) as unknown as Response;
        };

        const client = new ClaudeCodeClient('my-access-token');
        await client._request('/test/path');

        assert.strictEqual(capturedInput, 'https://api.anthropic.com/test/path');
        assert.strictEqual((capturedInit?.headers as Record<string, string>)['Authorization'], 'Bearer my-access-token');
        assert.strictEqual(capturedInit?.method, 'GET');
      });

      it('merges additional headers', async () => {
        let capturedHeaders: Record<string, string> | undefined;

        globalThis.fetch = async (_input, init) => {
          capturedHeaders = init?.headers as Record<string, string>;
          return makeMockResponse() as unknown as Response;
        };

        const client = new ClaudeCodeClient('my-access-token');
        await client._request('/test/path', {
          'x-custom-header': 'custom-value',
          'anthropic-beta': 'some-beta',
        });

        assert.strictEqual(capturedHeaders?.['Authorization'], 'Bearer my-access-token');
        assert.strictEqual(capturedHeaders?.['x-custom-header'], 'custom-value');
        assert.strictEqual(capturedHeaders?.['anthropic-beta'], 'some-beta');
      });

      it('returns parsed JSON on success', async () => {
        const responseBody = { id: 'user_123', email: 'test@example.com' };

        globalThis.fetch = async () => {
          return makeMockResponse({
            ok: true,
            status: 200,
            json: async () => responseBody,
          }) as unknown as Response;
        };

        const client = new ClaudeCodeClient('my-access-token');
        const result = await client._request<typeof responseBody>('/api/profile');

        assert.deepEqual(result, responseBody);
      });

      it('throws on non-ok response', async () => {
        globalThis.fetch = async () => {
          return makeMockResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
          }) as unknown as Response;
        };

        const client = new ClaudeCodeClient('invalid-token');

        await assert.rejects(
          () => client._request('/api/profile'),
          (err: Error) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('401'));
            assert.ok(err.message.includes('Unauthorized'));
            return true;
          },
        );
      });
    });

    describe('when constructed without token', () => {
      // getCredentials()는 파일 시스템에서 실제 자격증명을 읽으려 시도하므로
      // ESM 환경에서 모듈 레벨 의존성을 mock하기 어렵습니다.
      // 자격증명이 없는 환경에서는 rejects하는 것을 확인합니다.
      it('rejects if credentials are not available', async () => {
        const client = new ClaudeCodeClient();

        await assert.rejects(
          () => client._request('/api/profile'),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            return true;
          },
        );
      });
    });
  });
});
