import { OAuthApi } from './oauth.js';
import { getJson } from './http.js';
import { getCredentials, getAccessToken, isApiKeyAuth } from '../auth/index.js';
import type { ClientAuth } from '../auth/index.js';
import { CcbError } from '../errors.js';

const BASE_URL = 'https://api.anthropic.com';

/** Options that change where or how requests go out. */
export interface ClaudeCodeClientOptions {
  /**
   * API origin to talk to. Defaults to ANTHROPIC_BASE_URL when set, and to the
   * real API otherwise.
   */
  baseUrl?: string;
}

/**
 * The origin to use, with any trailing slash removed so that joining a path that
 * starts with "/" cannot produce a double slash.
 *
 * ANTHROPIC_BASE_URL is honored because the `claude` CLI honors it: a user
 * behind a corporate gateway points both at the same place, and `ccb` claiming
 * not to know the setting the rest of their toolchain uses would be a gap for no
 * reason. It also lets the tests here talk to a local server over the real
 * request path instead of stubbing the transport.
 */
function resolveBaseUrl(explicit: string | undefined): string {
  const chosen = explicit ?? process.env.ANTHROPIC_BASE_URL?.trim() ?? '';
  return (chosen || BASE_URL).replace(/\/+$/, '');
}

export class ClaudeCodeClient {
  private auth?: ClientAuth;
  private accessToken?: string;
  private _oauth?: OAuthApi;
  private readonly baseUrl: string;

  constructor(auth?: ClientAuth, options: ClaudeCodeClientOptions = {}) {
    this.auth = auth;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
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

    // getJson rather than fetch: fetch cannot be routed through a proxy, and on a
    // machine that only reaches the internet through one, every call here fails.
    // See src/proxy.ts.
    const response = await getJson<T>(`${this.baseUrl}${path}`, requestHeaders);

    if (!response.ok) {
      throw new CcbError(`API error ${response.status}: ${response.statusText}`, 'api_error');
    }

    return response.body;
  }
}
