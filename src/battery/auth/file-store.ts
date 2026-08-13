import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeCredentials } from './types.js';
import { CcbError } from '../errors.js';

function getCredentialsFilePath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, '.credentials.json');
}

export async function readFileCredentials(): Promise<ClaudeCredentials> {
  const filePath = getCredentialsFilePath();

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new CcbError(
      `Failed to read credentials file at ${filePath}: ${(err as Error).message}`,
      'credentials_not_found',
      "Run 'claude login' to authenticate",
    );
  }

  const parsed = JSON.parse(raw) as ClaudeCredentials;
  return parsed;
}
