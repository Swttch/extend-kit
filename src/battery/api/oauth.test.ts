import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthApi } from './oauth.js';
import type { ClaudeCodeClient } from './client.js';
import type { UsageResponse, ProfileResponse } from './types.js';

describe('OAuthApi', () => {
  describe('#getUsage', () => {
    it('calls _request with correct path and beta header', async () => {
      const fakeClient = { _request: mock.fn(async () => ({} as UsageResponse)) } as unknown as ClaudeCodeClient;
      const api = new OAuthApi(fakeClient);

      await api.getUsage();

      const calls = (fakeClient._request as unknown as ReturnType<typeof mock.fn>).mock.calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].arguments[0], '/api/oauth/usage');
      assert.deepEqual(calls[0].arguments[1], { 'anthropic-beta': 'oauth-2025-04-20' });
    });

    it('returns the usage response from client', async () => {
      const sampleUsage: UsageResponse = {
        five_hour: { utilization: 0.5, resets_at: '2025-04-20T00:00:00Z' },
        seven_day: null,
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        seven_day_cowork: null,
        iguana_necktie: null,
        extra_usage: null,
      };
      const fakeClient = { _request: mock.fn(async () => sampleUsage) } as unknown as ClaudeCodeClient;
      const api = new OAuthApi(fakeClient);

      const result = await api.getUsage();

      assert.deepEqual(result, sampleUsage);
    });
  });

  describe('#getProfile', () => {
    it('calls _request with correct path', async () => {
      const fakeClient = { _request: mock.fn(async () => ({} as ProfileResponse)) } as unknown as ClaudeCodeClient;
      const api = new OAuthApi(fakeClient);

      await api.getProfile();

      const calls = (fakeClient._request as unknown as ReturnType<typeof mock.fn>).mock.calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].arguments[0], '/api/oauth/profile');
    });

    it('does not send extra headers', async () => {
      const fakeClient = { _request: mock.fn(async () => ({} as ProfileResponse)) } as unknown as ClaudeCodeClient;
      const api = new OAuthApi(fakeClient);

      await api.getProfile();

      const calls = (fakeClient._request as unknown as ReturnType<typeof mock.fn>).mock.calls;
      assert.equal(calls[0].arguments[1], undefined);
    });

    it('returns the profile response from client', async () => {
      const sampleProfile: ProfileResponse = {
        account: {
          uuid: 'acc-uuid',
          full_name: 'Test User',
          display_name: 'testuser',
          email: 'test@example.com',
          has_claude_max: false,
          has_claude_pro: true,
          created_at: '2025-01-01T00:00:00Z',
        },
        organization: {
          uuid: 'org-uuid',
          name: 'Test Org',
          organization_type: 'personal',
          billing_type: 'subscription',
          rate_limit_tier: 'standard',
          has_extra_usage_enabled: false,
          subscription_status: 'active',
          subscription_created_at: '2025-01-01T00:00:00Z',
        },
        application: {
          uuid: 'app-uuid',
          name: 'Claude Code',
          slug: 'claude-code',
        },
      };
      const fakeClient = { _request: mock.fn(async () => sampleProfile) } as unknown as ClaudeCodeClient;
      const api = new OAuthApi(fakeClient);

      const result = await api.getProfile();

      assert.deepEqual(result, sampleProfile);
    });
  });
});
