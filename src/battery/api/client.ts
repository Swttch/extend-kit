import { OAuthApi } from './oauth.js';
import { getJson, proxyInUseFor, type JsonResponse } from './http.js';
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

    // getJson rather than fetch: fetch takes no `http.Agent`, and `ws` proxies
    // only when handed one, so a single proxy implementation has to be built on
    // something both transports accept. See src/proxy.ts.
    const url = `${this.baseUrl}${path}`;
    const response = await getJson<T>(url, requestHeaders);

    if (!response.ok) {
      throw describeApiFailure(response, url);
    }

    return response.body;
  }
}

/**
 * Turn an HTTP status into an error a caller can route on and a person can act on.
 *
 * Every non-2xx used to become one `api_error` reading "API error 403: Forbidden",
 * which is the same sentence for an expired login, a rate limit, and a request the
 * gateway blocked. Nothing downstream could tell them apart, so the plugin's usage
 * panel classified all of them as an authentication problem and told people to log
 * in again no matter what had actually happened.
 *
 * The proxy is named whenever one is in play. A refusal that reaches this function
 * came from the destination — {@link getJson} throws before this point when the
 * proxy itself refused the tunnel — but knowing which route the request took is
 * what makes the difference checkable rather than guessable.
 */
function describeApiFailure(response: JsonResponse<unknown>, url: string): CcbError {
  const { status, statusText, retryAfterSec } = response;
  const message = `API error ${status}: ${statusText}`;
  const proxyUrl = proxyInUseFor(url);
  const route = proxyUrl
    ? `The request reached the API through the proxy at ${proxyUrl}.`
    : 'The request went straight to the API, with no proxy configured for this process.';
  // Repeated on every branch so a caller never has to know which code carries
  // which facts. `reachedDestination` is true throughout: getJson throws before
  // this point when a proxy refused the tunnel, so anything here was answered by
  // the destination itself.
  const details = { status, ...(proxyUrl && { proxyUrl }), reachedDestination: true };

  if (status === 401) {
    return new CcbError(message, 'token_expired',
      'The saved login is no longer accepted. Run `claude` once to refresh it.', details);
  }
  if (status === 403) {
    // The case this whole taxonomy came out of: a machine that can only reach
    // Anthropic through a proxy, with the request going direct because the proxy
    // was configured under a variable this tool was not reading. The gateway
    // answers 403, which looks like an account problem and is not one.
    return new CcbError(message, 'forbidden',
      `${route} A 403 here is usually the network refusing the request rather than the account lacking access.`,
      details);
  }
  if (status === 429) {
    return new CcbError(message, 'rate_limited',
      retryAfterSec !== undefined
        ? `Too many requests. The API asked us to wait ${retryAfterSec}s.`
        : 'Too many requests in a short window. Try again shortly.',
      { ...details, ...(retryAfterSec !== undefined && { retryAfterSec }) });
  }
  if (status >= 500) {
    return new CcbError(message, 'server_error', `${route} The API itself reported an error.`, details);
  }
  return new CcbError(message, 'api_error', route, details);
}
