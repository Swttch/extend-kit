import { OAuthApi } from './oauth.js';
import { getCredentials, getAccessToken, isApiKeyAuth } from '../auth/index.js';
import type { ClientAuth } from '../auth/index.js';
import { CcbError } from '../errors.js';

const BASE_URL = 'https://api.anthropic.com';

export class ClaudeCodeClient {
  private auth?: ClientAuth;
  private accessToken?: string;
  private _oauth?: OAuthApi;

  constructor(auth?: ClientAuth) {
    this.auth = auth;
    if (typeof auth === 'string') {
      this.accessToken = auth;
    }
  }

  get isApiKeyMode(): boolean {
    return isApiKeyAuth(this.auth as ClientAuth);
  }

  get oauth(): OAuthApi {
    return this._oauth ??= new OAuthApi(this);
  }

  private async resolveToken(): Promise<string> {
    if (!this.accessToken) {
      const credentials = await getCredentials();
      this.accessToken = getAccessToken(credentials);
    }
    return this.accessToken;
  }

  async _request<T>(path: string, headers?: Record<string, string>): Promise<T> {
    let requestHeaders: Record<string, string>;

    if (this.auth !== undefined && isApiKeyAuth(this.auth)) {
      requestHeaders = {
        'x-api-key': this.auth.apiKey,
        'anthropic-version': '2023-06-01',
        ...headers,
      };
    } else {
      const token = await this.resolveToken();
      requestHeaders = {
        Authorization: `Bearer ${token}`,
        ...headers,
      };
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: requestHeaders,
    });

    if (!response.ok) {
      throw new CcbError(`API error ${response.status}: ${response.statusText}`, 'api_error');
    }

    return response.json() as Promise<T>;
  }
}
