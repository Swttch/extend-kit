import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAccountCredentials } from './account-credentials.js';
const exec = promisify(execFile);

test('saved account CLI reads the requested snapshot, without live auth or token output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccb account '));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const file = join(dir, 'saved account.json');
    const credentials = { claudeAiOauth: { accessToken: 'synthetic-selected', expiresAt: Date.now() + 3600000 } };
    await writeFile(file, JSON.stringify({ credentials: JSON.stringify(credentials), oauthAccount: { emailAddress: 'selected@mock.invalid' } }));
    assert.equal((await getAccountCredentials(file)).claudeAiOauth.accessToken, 'synthetic-selected');
    const loader = join(dir, 'fetch.mjs');
    await writeFile(loader, `globalThis.fetch = async (url, init) => {
      if (!url.endsWith('/api/oauth/usage') || init.headers.Authorization !== 'Bearer synthetic-selected') throw Error('Wrong account');
      return Response.json({five_hour:{utilization:100,resets_at:'2030-01-01T00:00:00Z'}, extra_provider_field:42});
    };`);
    const cli = new URL('./index.js', import.meta.url).pathname;
    const { stdout, stderr } = await exec(process.execPath, ['--import', loader, cli, 'oauth', 'usage', '--json', `--account-file=${file}`], { env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(JSON.parse(stdout).extra_provider_field, 42);
    assert.equal(stderr, '');
    assert.ok(!stdout.includes('synthetic-selected'));
    const capabilities = await exec(process.execPath, [cli, '--capabilities', '--json'], { env: { ...process.env, NODE_OPTIONS: '' } });
    assert.deepEqual(JSON.parse(capabilities.stdout), { capabilities: ['oauth.usage.account-file'] });
    await writeFile(file, JSON.stringify({ credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'expired-secret', expiresAt: 1 } }) }));
    await assert.rejects(getAccountCredentials(file), { code: 'token_expired' });
    await writeFile(file, '{"credentials":"invalid-sensitive-content"}');
    await assert.rejects(getAccountCredentials(file), error => error instanceof Error && !error.message.includes('invalid-sensitive-content'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
