import { readKeychainCredentials } from './keychain.js';
import { readFileCredentials } from './file-store.js';
import type { ClaudeCredentials, ClientAuth, ApiKeyAuth } from './types.js';
import { CcbError } from '../errors.js';

export type { ClaudeCredentials, ClaudeOAuthCredentials, ApiKeyAuth, ClientAuth } from './types.js';

export function isApiKeyAuth(auth: ClientAuth): auth is ApiKeyAuth {
  return typeof auth === 'object' && 'apiKey' in auth;
}

export async function getCredentials(): Promise<ClaudeCredentials> {
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
