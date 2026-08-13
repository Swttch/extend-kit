import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeCredentials } from './types.js';

const execFileAsync = promisify(execFile);

const SERVICE_NAME = 'Claude Code-credentials';

async function getOsUsername(): Promise<string> {
  const { stdout } = await execFileAsync('whoami');
  return stdout.trim();
}

export async function readKeychainCredentials(): Promise<ClaudeCredentials> {
  const account = await getOsUsername();
  const { stdout } = await execFileAsync('security', [
    'find-generic-password',
    '-s', SERVICE_NAME,
    '-a', account,
    '-w',
  ]);

  const raw = stdout.trim();
  const parsed = JSON.parse(raw) as ClaudeCredentials;
  return parsed;
}
