import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [entry, ...args], (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
});

// swttch-ext is the one command of this package. `ccb` is the old name of its account half and is kept
// only so that machines that already call it keep working, so everything ccb did must be here.
describe('swttch-ext as the replacement for ccb', () => {
  it('reports the capabilities ccb reported, plus the account calls', async () => {
    const { stdout } = await run(['--capabilities']);
    const caps: string[] = JSON.parse(stdout).capabilities;
    for (const expected of ['stt.stream', 'settings.env', 'api.oauth.usage', 'api.oauth.usage.account-file', 'api.oauth.profile', 'tts']) {
      assert.ok(caps.includes(expected), `${expected} is missing from ${caps.join(', ')}`);
    }
  });

  it('lists the account calls in `api --list`', async () => {
    const { stdout } = await run(['api', '--list']);
    const names = JSON.parse(stdout).calls.map((c: { service: string; name: string }) => `${c.service} ${c.name}`);
    assert.ok(names.includes('oauth usage') && names.includes('oauth profile'));
  });

  it('shows dictation and the account calls in its help, and says ccb is the old name', async () => {
    const { stdout } = await run(['--help']);
    assert.match(stdout, /swttch-ext stt/);
    assert.match(stdout, /api oauth usage/);
    assert.match(stdout, /api oauth profile/);
    assert.match(stdout, /ccb/);
  });

  it('answers `stt --check` as ccb does: one line about whether this machine can dictate', async () => {
    const { code, stdout } = await run(['stt', '--check']);
    assert.equal(code, 0);
    assert.ok(stdout.trim().length > 0);
  });
});
