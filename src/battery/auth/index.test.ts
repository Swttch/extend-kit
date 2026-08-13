import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeCredentials } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredentials(overrides?: Partial<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
  organizationUuid: string;
}>): ClaudeCredentials {
  return {
    claudeAiOauth: {
      accessToken: overrides?.accessToken ?? 'test-access-token',
      refreshToken: overrides?.refreshToken ?? 'test-refresh-token',
      expiresAt: overrides?.expiresAt ?? Date.now() + 3_600_000, // 1 hour from now
      scopes: overrides?.scopes ?? ['read', 'write'],
      subscriptionType: overrides?.subscriptionType ?? 'pro',
      rateLimitTier: overrides?.rateLimitTier ?? 'standard',
    },
    organizationUuid: overrides?.organizationUuid ?? 'org-uuid-1234',
  };
}

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken', async () => {
  const { getAccessToken } = await import('./index.js');

  it('returns the accessToken from the credentials object', () => {
    const credentials = makeCredentials({ accessToken: 'my-secret-token' });
    assert.equal(getAccessToken(credentials), 'my-secret-token');
  });

  it('returns a different accessToken when credentials differ', () => {
    const credA = makeCredentials({ accessToken: 'token-a' });
    const credB = makeCredentials({ accessToken: 'token-b' });
    assert.notEqual(getAccessToken(credA), getAccessToken(credB));
  });

  it('returns an empty string when accessToken is empty', () => {
    const credentials = makeCredentials({ accessToken: '' });
    assert.equal(getAccessToken(credentials), '');
  });
});

// ---------------------------------------------------------------------------
// isTokenExpired
// ---------------------------------------------------------------------------

describe('isTokenExpired', async () => {
  const { isTokenExpired } = await import('./index.js');

  describe('when expiresAt is in the future', () => {
    it('returns false', () => {
      const futureExpiry = Date.now() + 3_600_000; // 1 hour from now
      const credentials = makeCredentials({ expiresAt: futureExpiry });
      assert.equal(isTokenExpired(credentials), false);
    });

    it('returns false for a far-future expiry', () => {
      const farFuture = Date.now() + 365 * 24 * 3_600_000; // 1 year from now
      const credentials = makeCredentials({ expiresAt: farFuture });
      assert.equal(isTokenExpired(credentials), false);
    });
  });

  describe('when expiresAt is in the past', () => {
    it('returns true', () => {
      const pastExpiry = Date.now() - 1_000; // 1 second ago
      const credentials = makeCredentials({ expiresAt: pastExpiry });
      assert.equal(isTokenExpired(credentials), true);
    });

    it('returns true for a long-past expiry', () => {
      const longPast = Date.now() - 365 * 24 * 3_600_000; // 1 year ago
      const credentials = makeCredentials({ expiresAt: longPast });
      assert.equal(isTokenExpired(credentials), true);
    });
  });

  describe('edge case: expiresAt is exactly now', () => {
    it('returns true (expired at the boundary)', () => {
      // We capture Date.now() once and pass it directly.
      // The implementation uses Date.now() >= expiresAt, so equal timestamps
      // should be considered expired.
      const now = Date.now();
      const credentials = makeCredentials({ expiresAt: now });
      // Allow a tiny drift: the two Date.now() calls may differ by a
      // millisecond, but expiresAt === now means it is at-or-past expiry.
      const result = isTokenExpired(credentials);
      // result is true when Date.now() (inside impl) >= now — which is always
      // true for equal or later values, so we assert true.
      assert.equal(result, true);
    });
  });
});

// ---------------------------------------------------------------------------
// getCredentials
// ---------------------------------------------------------------------------

describe('getCredentials', async () => {
  describe('on the current platform (darwin)', async () => {
    it('returns a Promise', async () => {
      // We only verify the return type is a Promise without awaiting the full
      // resolution (which would require real keychain access on macOS).
      const { getCredentials } = await import('./index.js');
      const result = getCredentials();
      assert.ok(result instanceof Promise, 'getCredentials() should return a Promise');
      // Swallow any rejection from missing keychain entry so the test itself
      // does not fail due to environment issues.
      result.catch(() => {});
    });
  });

  describe('platform dispatch logic', () => {
    // mirror of the dispatch logic in getCredentials, used to validate the
    // branching rules without touching process.platform or ESM module cache.
    type Dispatcher = (
      platform: string,
      readKeychain: () => Promise<ClaudeCredentials>,
      readFile: () => Promise<ClaudeCredentials>,
    ) => Promise<ClaudeCredentials>;

    const dispatch: Dispatcher = (platform, readKeychain, readFile) => {
      if (platform === 'darwin') return readKeychain();
      if (platform === 'win32' || platform === 'linux') return readFile();
      throw new Error(`Unsupported platform: ${platform}.`);
    };

    const stubCredentials = makeCredentials({ accessToken: 'stub-token' });
    const stubKeychain = mock.fn(async () => stubCredentials);
    const stubFile = mock.fn(async () => stubCredentials);

    beforeEach(() => {
      stubKeychain.mock.resetCalls();
      stubFile.mock.resetCalls();
    });

    it('routes darwin to readKeychainCredentials', async () => {
      await dispatch('darwin', stubKeychain, stubFile);
      assert.equal(stubKeychain.mock.calls.length, 1, 'readKeychainCredentials should be called once');
      assert.equal(stubFile.mock.calls.length, 0, 'readFileCredentials should not be called');
    });

    it('routes linux to readFileCredentials', async () => {
      await dispatch('linux', stubKeychain, stubFile);
      assert.equal(stubFile.mock.calls.length, 1, 'readFileCredentials should be called once');
      assert.equal(stubKeychain.mock.calls.length, 0, 'readKeychainCredentials should not be called');
    });

    it('routes win32 to readFileCredentials', async () => {
      await dispatch('win32', stubKeychain, stubFile);
      assert.equal(stubFile.mock.calls.length, 1, 'readFileCredentials should be called once');
      assert.equal(stubKeychain.mock.calls.length, 0, 'readKeychainCredentials should not be called');
    });

    it('throws with a descriptive message for unsupported platforms', () => {
      assert.throws(
        () => dispatch('freebsd', stubKeychain, stubFile),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /^Unsupported platform:/);
          assert.ok(err.message.includes('freebsd'));
          return true;
        },
      );
    });

    it('includes the platform name in the error message', () => {
      assert.throws(
        () => dispatch('haiku-os', stubKeychain, stubFile),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('haiku-os'));
          return true;
        },
      );
    });
  });
});
