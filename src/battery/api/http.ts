import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type Agent } from 'node:http';
import { proxyAgentFor } from '../../proxy.js';
import { CcbError } from '../errors.js';

/** What a caller needs to know about the response, mirroring the shape `fetch` returns. */
export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  statusText: string;
  body: T;
}

/**
 * Global `fetch` cannot be pointed at a proxy — it ignores the proxy environment
 * variables and takes no `agent` — so it is unusable here. `node:https` accepts
 * the very agent `ws` accepts, which lets one proxy implementation serve both
 * transports. See {@link proxyAgentFor}.
 */
const SOCKET_TIMEOUT_MS = 60_000;

/**
 * GET a JSON document, through a proxy when one is configured.
 *
 * A dead or misconfigured proxy fails at connect time, and the raw errno that
 * surfaces ("ECONNREFUSED 127.0.0.1:8080") names the proxy without saying that a
 * proxy is what failed. Since the proxy is invisible in the URL the user asked
 * for, the error says so explicitly.
 */
export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  agentOverride?: Agent,
): Promise<JsonResponse<T>> {
  const agent = agentOverride ?? proxyAgentFor(url);
  const viaProxy = agent !== undefined;
  // The API is always https; plain http is here so tests can run against a local
  // server without a certificate, and it costs one branch.
  const request = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest;

  const { status, statusText, text } = await new Promise<{
    status: number;
    statusText: string;
    text: string;
  }>((resolve, reject) => {
    const req = request(url, { method: 'GET', headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          text: Buffer.concat(chunks).toString('utf-8'),
        }),
      );
      res.on('error', reject);
    });

    // `https.request` waits forever by default; a proxy that accepts the socket
    // and then goes quiet would hang the CLI with no output at all.
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new CcbError(
        `Request to ${url} timed out after ${SOCKET_TIMEOUT_MS / 1000}s`,
        'network_error',
        viaProxy ? 'The configured proxy accepted the connection but never replied.' : undefined,
      ));
    });

    req.on('error', (err) => {
      if (err instanceof CcbError) return reject(err);
      reject(new CcbError(
        `Could not reach ${new URL(url).host}: ${err.message}`,
        'network_error',
        viaProxy
          ? 'This connection went through the proxy from HTTP_PROXY/HTTPS_PROXY/ALL_PROXY. Check that the proxy is running and reachable.'
          : undefined,
      ));
    });

    req.end();
  });

  if (status < 200 || status >= 300) {
    return { ok: false, status, statusText, body: undefined as T };
  }

  try {
    return { ok: true, status, statusText, body: JSON.parse(text) as T };
  } catch {
    throw new CcbError(
      `Expected JSON from ${url} but got something else`,
      'api_error',
      viaProxy ? 'A proxy that returns an error page instead of the response looks like this.' : undefined,
    );
  }
}
