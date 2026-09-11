import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { getAccountCredentials } from './account-credentials.js';
const exec = promisify(execFile);

/**
 * This used to stand up its fake API by overwriting globalThis.fetch through an
 * --import loader. The client no longer uses fetch (it cannot be routed through
 * a proxy — see src/proxy.ts), so that loader silently stopped intercepting
 * anything and the CLI went to the real API. A local server pointed at with
 * ANTHROPIC_BASE_URL replaces it: nothing to keep in sync with the transport,
 * and the request is observed as it actually goes out.
 */
test('saved account CLI reads the requested snapshot, without live auth or token output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccb account '));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;

  const seen: { url: string; auth: string }[] = [];
  const api = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' });
    if (req.url !== '/api/oauth/usage' || req.headers.authorization !== 'Bearer synthetic-selected') {
      res.writeHead(403, 'Wrong account');
      res.end('');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    // extra_provider_field is here to prove the CLI relays the provider's
    // response as-is instead of picking out the fields it currently knows about.
    res.end(JSON.stringify({
      five_hour: { utilization: 100, resets_at: '2030-01-01T00:00:00Z' },
      extra_provider_field: 42,
    }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  try {
    const file = join(dir, 'saved account.json');
    const credentials = { claudeAiOauth: { accessToken: 'synthetic-selected', expiresAt: Date.now() + 3600000 } };
    await writeFile(file, JSON.stringify({ credentials: JSON.stringify(credentials), oauthAccount: { emailAddress: 'selected@mock.invalid' } }));
    assert.equal((await getAccountCredentials(file)).claudeAiOauth.accessToken, 'synthetic-selected');

    // fileURLToPath, not .pathname: on Windows the latter yields "/C:/..." and the
    // leading slash makes node resolve "C:\C:\...", so this test could never have
    // passed there. Nobody had run the suite on Windows until now.
    const cli = fileURLToPath(new URL('./index.js', import.meta.url));
    const env = { ...process.env, NODE_OPTIONS: '', ANTHROPIC_BASE_URL: baseUrl };

    const { stdout, stderr } = await exec(
      process.execPath,
      [cli, 'oauth', 'usage', '--json', `--account-file=${file}`],
      { env },
    );
    assert.equal(JSON.parse(stdout).extra_provider_field, 42);
    assert.equal(stderr, '');
    assert.ok(!stdout.includes('synthetic-selected'));
    // The selected snapshot's token is what went out — not the live login's.
    assert.deepEqual(seen, [{ url: '/api/oauth/usage', auth: 'Bearer synthetic-selected' }]);

    const capabilities = await exec(process.execPath, [cli, '--capabilities', '--json'], { env });
    assert.deepEqual(JSON.parse(capabilities.stdout), { capabilities: ['oauth.usage.account-file'] });

    await writeFile(file, JSON.stringify({ credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'expired-secret', expiresAt: 1 } }) }));
    await assert.rejects(getAccountCredentials(file), { code: 'token_expired' });

    await writeFile(file, '{"credentials":"invalid-sensitive-content"}');
    await assert.rejects(getAccountCredentials(file), error => error instanceof Error && !error.message.includes('invalid-sensitive-content'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await new Promise<void>((r) => api.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
