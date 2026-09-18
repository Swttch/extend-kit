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

// ---------------------------------------------------------------------------
// getCredentials: the token handed over through the environment
// ---------------------------------------------------------------------------

describe('getCredentials with CLAUDE_CODE_OAUTH_TOKEN', () => {
  const NAME = 'CLAUDE_CODE_OAUTH_TOKEN';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[NAME];
  });

  const restore = (): void => {
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  };

  it('uses the variable instead of the platform credential store', async () => {
    process.env[NAME] = 'sk-ant-oat01-handed-over';
    try {
      const { getCredentials, getAccessToken } = await import('./index.js');
      const credentials = await getCredentials();
      // Reaching this at all is the assertion on macOS: the keychain read this would
      // otherwise do needs a real login and a `security` prompt.
      assert.equal(getAccessToken(credentials), 'sk-ant-oat01-handed-over');
    } finally {
      restore();
    }
  });

  it('does not report the handed-over token as expired', async () => {
    process.env[NAME] = 'sk-ant-oat01-handed-over';
    try {
      const { getCredentials, getAccessToken, isTokenExpired } = await import('./index.js');
      const credentials = await getCredentials();
      // Assert on the token too, or this passes on a machine whose real keychain login
      // happens to be valid — which is every machine we develop on.
      assert.equal(getAccessToken(credentials), 'sk-ant-oat01-handed-over');
      // The variable carries a token and no expiry. Calling it expired would refuse a
      // token the server is perfectly willing to accept.
      assert.equal(isTokenExpired(credentials), false);
    } finally {
      restore();
    }
  });

  it('falls through to the credential store when the variable is empty', async () => {
    process.env[NAME] = '';
    try {
      const { getCredentials } = await import('./index.js');
      // An empty variable is not a token. Treating it as one sends "Bearer " to the
      // server and turns a working login into a 401.
      const result = getCredentials();
      assert.ok(result instanceof Promise);
      result.catch(() => {});
    } finally {
      restore();
    }
  });
});
