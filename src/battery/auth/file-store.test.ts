import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileCredentials } from './file-store.js';

const validCredentials = {
  claudeAiOauth: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: 9999999999,
    scopes: ['read', 'write'],
    subscriptionType: 'pro',
    rateLimitTier: 'standard',
  },
  organizationUuid: 'test-org-uuid',
};

describe('readFileCredentials', () => {
  let tmpDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'claude-battery-test-'));
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env['CLAUDE_CONFIG_DIR'];
    } else {
      process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('when credentials file does not exist', () => {
    it('should throw with a descriptive error message', async () => {
      const nonExistentDir = path.join(tmpDir, 'nonexistent');
      process.env['CLAUDE_CONFIG_DIR'] = nonExistentDir;

      await assert.rejects(
        () => readFileCredentials(),
        (err: Error) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('Failed to read credentials file'),
            `Expected message to contain "Failed to read credentials file", got: ${err.message}`,
          );
          assert.ok(
            err.message.includes(nonExistentDir),
            `Expected message to contain path "${nonExistentDir}", got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });

  describe('when credentials file exists with valid JSON', () => {
    it('should return the parsed ClaudeCredentials object', async () => {
      process.env['CLAUDE_CONFIG_DIR'] = tmpDir;
      const credentialsPath = path.join(tmpDir, '.credentials.json');
      await writeFile(credentialsPath, JSON.stringify(validCredentials), 'utf-8');

      const result = await readFileCredentials();

      assert.deepEqual(result, validCredentials);
    });

    it('should return an object with claudeAiOauth and organizationUuid fields', async () => {
      process.env['CLAUDE_CONFIG_DIR'] = tmpDir;
      const credentialsPath = path.join(tmpDir, '.credentials.json');
      await writeFile(credentialsPath, JSON.stringify(validCredentials), 'utf-8');

      const result = await readFileCredentials();

      assert.equal(result.organizationUuid, 'test-org-uuid');
      assert.equal(result.claudeAiOauth.accessToken, 'test-access-token');
      assert.equal(result.claudeAiOauth.refreshToken, 'test-refresh-token');
      assert.equal(result.claudeAiOauth.expiresAt, 9999999999);
      assert.deepEqual(result.claudeAiOauth.scopes, ['read', 'write']);
      assert.equal(result.claudeAiOauth.subscriptionType, 'pro');
      assert.equal(result.claudeAiOauth.rateLimitTier, 'standard');
    });
  });

  describe('when credentials file contains invalid JSON', () => {
    it('should throw a SyntaxError', async () => {
      process.env['CLAUDE_CONFIG_DIR'] = tmpDir;
      const credentialsPath = path.join(tmpDir, '.credentials.json');
      await writeFile(credentialsPath, '{ invalid json !!!', 'utf-8');

      await assert.rejects(
        () => readFileCredentials(),
        SyntaxError,
      );
    });
  });

  describe('when CLAUDE_CONFIG_DIR is not set', () => {
    it('should fall back to ~/.claude and include that path in error message', async () => {
      delete process.env['CLAUDE_CONFIG_DIR'];

      const expectedDir = path.join(os.homedir(), '.claude');
      const expectedPath = path.join(expectedDir, '.credentials.json');

      // ~/.claude/.credentials.json이 실제로 존재하지 않는다고 가정할 수 없으므로,
      // 오류 발생 시 경로 확인 / 성공 시 객체 반환 확인
      try {
        const result = await readFileCredentials();
        // 파일이 존재하면 객체가 반환되어야 함 (최소한 객체 타입이어야 함)
        assert.equal(typeof result, 'object');
        assert.ok(result !== null);
      } catch (err) {
        // 파일이 없으면 에러 메시지에 올바른 경로가 포함되어야 함
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes(expectedPath),
          `Expected error message to contain "${expectedPath}", got: ${err.message}`,
        );
      }
    });
  });
});
