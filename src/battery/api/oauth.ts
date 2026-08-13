import type { ClaudeCodeClient } from './client.js';
import type { UsageResponse, ProfileResponse } from './types.js';
import { CcbError } from '../errors.js';

export class OAuthApi {
  constructor(private readonly client: ClaudeCodeClient) {}

  async getUsage(): Promise<UsageResponse> {
    if (this.client.isApiKeyMode) {
      throw new CcbError(
        'API Key authentication does not support usage/profile queries.',
        'unsupported_auth',
        'Check usage at console.anthropic.com, or use OAuth login (claude login)',
      );
    }
    return this.client._request<UsageResponse>('/api/oauth/usage', {
      'anthropic-beta': 'oauth-2025-04-20',
    });
  }

  async getProfile(): Promise<ProfileResponse> {
    if (this.client.isApiKeyMode) {
      throw new CcbError(
        'API Key authentication does not support usage/profile queries.',
        'unsupported_auth',
        'Check usage at console.anthropic.com, or use OAuth login (claude login)',
      );
    }
    return this.client._request<ProfileResponse>('/api/oauth/profile');
  }
}
