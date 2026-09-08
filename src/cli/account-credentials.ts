import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCredentials } from '../battery/auth/index.js';
import { readKeychainCredentials } from '../battery/auth/keychain.js';
import type { ClaudeCredentials } from '../battery/auth/types.js';
import { CcbError } from '../battery/errors.js';

/** Read a CCG saved-account snapshot without replacing the active credential slot. */
export async function getAccountCredentials(file: string): Promise<ClaudeCredentials> {
  let snapshot: { credentials?: string; oauthAccount?: { emailAddress?: string } };
  let credentials: ClaudeCredentials;
  try {
    snapshot = JSON.parse(await readFile(file, 'utf8'));
    credentials = JSON.parse(snapshot.credentials ?? '');
    if (!credentials.claudeAiOauth?.accessToken) throw new Error('Missing access token');
  } catch {
    // Parsing errors must never echo a credential blob in stderr.
    throw new CcbError('Saved account credentials are unavailable or invalid.', 'credentials_not_found');
  }
  const email = snapshot.oauthAccount?.emailAddress;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const liveEmail = async (): Promise<string | undefined> => {
    const metadata = JSON.parse(await readFile(join(configDir ?? homedir(), '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    return metadata.oauthAccount?.emailAddress;
  };
  // A currently active account can have a newer token than its saved snapshot.
  // Never use the live slot for a different account. No writes or token refresh.
  try {
    if (email && await liveEmail() === email) {
      const live = process.platform === 'darwin'
        ? await readKeychainCredentials(configDir) : await getCredentials();
      if (await liveEmail() === email && live.claudeAiOauth?.accessToken) credentials = live;
    }
  } catch { /* The saved snapshot remains the fallback. */ }
  if (Number.isFinite(credentials.claudeAiOauth.expiresAt) && Date.now() >= credentials.claudeAiOauth.expiresAt) {
    throw new CcbError('Saved account token has expired. Log in to this account again.', 'token_expired');
  }
  return credentials;
}
