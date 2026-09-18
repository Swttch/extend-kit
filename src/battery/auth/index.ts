import { readKeychainCredentials } from './keychain.js';
import { readFileCredentials } from './file-store.js';
import type { ClaudeCredentials, ClientAuth, ApiKeyAuth } from './types.js';
import { CcbError } from '../errors.js';

export type { ClaudeCredentials, ClaudeOAuthCredentials, ApiKeyAuth, ClientAuth } from './types.js';

export function isApiKeyAuth(auth: ClientAuth): auth is ApiKeyAuth {
  return typeof auth === 'object' && 'apiKey' in auth;
}

/**
 * A token handed to us through the environment, wrapped as credentials.
 *
 * `claude setup-token` issues a long-lived token for people who cannot run an interactive
 * login — CI, containers, a workstation where the browser flow is blocked — and the way to
 * use it is `CLAUDE_CODE_OAUTH_TOKEN`. The `claude` CLI reads that variable BEFORE it looks
 * at the keychain: on a machine with a perfectly good login in the keychain, one bad value
 * in that variable makes `claude` fail with 401, which is only possible if the variable is
 * consulted first. So it is consulted first here too.
 *
 * The fields beside the token are filled with blanks because the variable carries a token and
 * nothing else. That is honest rather than lossy: `accessToken` is the only field any caller
 * in this package reads.
 *
 * `expiresAt` is the one that needs saying out loud. A token handed over this way comes with
 * no expiry, and there is no refresh token to renew it with, so treating it as expired would
 * make the feature unusable while treating it as fresh costs nothing: an expired one is
 * refused by the server, which is the same answer, arriving from the side that actually knows.
 */
function environmentCredentials(token: string): ClaudeCredentials {
  return {
    claudeAiOauth: {
      accessToken: token,
      refreshToken: '',
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: [],
      subscriptionType: '',
      rateLimitTier: '',
    },
    organizationUuid: '',
  };
}

export async function getCredentials(): Promise<ClaudeCredentials> {
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) return environmentCredentials(envToken);

  const platform = process.platform;

  if (platform === 'darwin') {
    return readKeychainCredentials();
  }

  if (platform === 'win32' || platform === 'linux') {
    return readFileCredentials();
  }

  throw new CcbError(`Unsupported platform: ${platform}.`, 'unsupported_platform');
}

export function getAccessToken(credentials: ClaudeCredentials): string {
  return credentials.claudeAiOauth.accessToken;
}

export function isTokenExpired(credentials: ClaudeCredentials): boolean {
  return Date.now() >= credentials.claudeAiOauth.expiresAt;
}
