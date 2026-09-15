/**
 * The HTTP transport for everything this package fetches.
 *
 * Global `fetch` cannot be handed an `http.Agent`, and `ws` proxies only when it
 * is handed one, so routing both transports through a single proxy
 * implementation means using `node:https` here. Proxying `fetch` itself is
 * possible by other means — undici's ProxyAgent with setGlobalDispatcher — but a
 * dispatcher does not cover `ws`, which is why that route was not taken.
 * See {@link proxyAgentFor}.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type Agent, type ClientRequest } from 'node:http';
import { proxyAgentFor, resolveProxyUrl, redactProxyUrl } from '../../proxy.js';
import { CcbError } from '../errors.js';

/** What a caller needs to know about the response, mirroring the shape `fetch` returns. */
export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  statusText: string;
  body: T;
  /**
   * Seconds the destination asked us to wait, parsed from Retry-After.
   *
   * Surfaced as a number because the only alternative is for a caller to find it
   * by matching prose, and a caller that reads prose breaks when the prose changes.
   * Absent when the header was missing or was an HTTP-date rather than a count.
   */
  retryAfterSec?: number;
}

/** Retry-After is either a count of seconds or an HTTP-date; only the former is useful here. */
function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * How long a request may take in total: connecting, opening the tunnel when a
 * proxy is in the way, and reading the response.
 *
 * One budget rather than a socket timeout, because a socket timeout starts when
 * there is a socket. A proxy that is slow to answer CONNECT has not produced one
 * yet, so the guard that was here before did not cover the very case its comment
 * described: a proxy asked to open a tunnel and left to think about it for 70
 * seconds ran to completion, unguarded, while the same 70-second silence after
 * the tunnel opened was cut off at 60. Measured, not reasoned about.
 */
const DEFAULT_DEADLINE_MS = 60_000;

/**
 * How long a request may take in total, before the caller's own option.
 *
 * A spawner with a shorter budget than ours can say so here. The plugin backend
 * gives `ccb` 15 seconds and kills the process at that mark, which produces a
 * dead child and whatever its login shell had printed by then rather than an
 * explanation — the user was shown `(eval):1: can't change option: zle`. Told the
 * budget, `ccb` finishes first and says what actually went wrong.
 */
function defaultDeadlineMs(): number {
  const raw = Number(process.env.CCB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

/** Options that change how a request is made, rather than what is requested. */
export interface GetJsonOptions {
  /** Use this agent instead of resolving one from the proxy environment. */
  agent?: Agent;
  /** Total budget for the request, covering connect, tunnel, and response. */
  deadlineMs?: number;
}

/**
 * How far a request got before it ran out of time. The two phases fail for
 * different reasons and a user can act on the difference: a stall during CONNECT
 * means the proxy never answered, while a stall afterwards means the tunnel
 * opened and the destination went quiet.
 */
type Phase = 'connecting' | 'tunnelled';

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
  options: GetJsonOptions = {},
): Promise<JsonResponse<T>> {
  const { agent: agentOverride, deadlineMs = defaultDeadlineMs() } = options;
  // Built before the agent, because the agent needs it: see the note in
  // proxyAgentFor on why a signal given only to the request cannot end a wait
  // that has not produced a socket yet.
  const abort = new AbortController();
  const agent = agentOverride
    ?? proxyAgentFor(url, process.env, { signal: abort.signal, timeoutMs: deadlineMs });
  const viaProxy = agent !== undefined;
  // Only meaningful for the agent this function built: an override comes from a
  // caller that knows its own routing, and naming an environment proxy it is not
  // using would be worse than saying nothing.
  const proxyUrl = agentOverride ? undefined : redactProxyUrl(resolveProxyUrl(url));
  // The API is always https; plain http is here so tests can run against a local
  // server without a certificate, and it costs one branch.
  const request = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest;

  // Aborting is what actually stops the work, rather than only telling the caller
  // to stop waiting for it. One signal covers both halves: the agent destroys the
  // socket it is reading the CONNECT response from, and the request tears down a
  // socket it has already been handed.
  let socketToKill: { destroy: () => void } | undefined;
  let phase: Phase = 'connecting';
  let proxyConnectStatus: number | undefined;
  let timedOut = false;

  const deadline = setTimeout(() => {
    timedOut = true;
    abort.abort();
    socketToKill?.destroy();
  }, deadlineMs);

  const describeTimeout = () => new CcbError(
    `Request to ${url} timed out after ${Math.round(deadlineMs / 1000)}s`,
    'timeout',
    phase === 'connecting' && viaProxy
      ? `The proxy${proxyUrl ? ` at ${proxyUrl}` : ''} never finished opening the tunnel.`
      : viaProxy
        ? 'The tunnel was open, but the destination never replied.'
        : undefined,
    { ...(proxyUrl && { proxyUrl }), reachedDestination: phase === 'tunnelled' },
  );

  type RawResult = { status: number; statusText: string; text: string; retryAfterSec?: number };
  let result: RawResult;
  try {
    result = await new Promise<RawResult>((resolve, reject) => {
      const req: ClientRequest = request(
        url,
        { method: 'GET', headers, agent, signal: abort.signal },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              text: Buffer.concat(chunks).toString('utf-8'),
              retryAfterSec: parseRetryAfter(res.headers['retry-after']),
            }),
          );
          res.on('error', reject);
        },
      );

      // https-proxy-agent announces the CONNECT response here before it decides
      // what to do with it. Recording the status is what lets a refusal be told
      // apart from an answer by the destination — see the throw below.
      req.on('proxyConnect', (connect: { statusCode?: number }) => {
        proxyConnectStatus = connect.statusCode;
        if (connect.statusCode === 200) phase = 'tunnelled';
      });
      req.on('socket', (socket) => {
        socketToKill = socket;
        // Without a proxy there is no CONNECT step to leave behind: once the
        // socket exists, any further wait is the destination's.
        if (!viaProxy) phase = 'tunnelled';
      });

      req.on('error', (err) => {
        if (timedOut) return reject(describeTimeout());
        if (err instanceof CcbError) return reject(err);
        reject(new CcbError(
          `Could not reach ${new URL(url).host}: ${err.message}`,
          'network_error',
          viaProxy
            ? 'This connection went through the proxy from HTTP_PROXY/HTTPS_PROXY/ALL_PROXY. Check that the proxy is running and reachable.'
            : undefined,
          { ...(proxyUrl && { proxyUrl }), reachedDestination: false },
        ));
      });

      req.end();
    });
  } finally {
    clearTimeout(deadline);
  }

  // A proxy that refuses the CONNECT does not fail the request. https-proxy-agent
  // replays the refusal onto a stand-in socket so node's HTTP parser reads it,
  // which means the proxy's own "403 Forbidden" arrives here shaped exactly like a
  // 403 from the API.
  //
  // That replay is deliberate on the library's part, not something to route around:
  // it destroys the real socket first so the request — Authorization header and all
  // — is never written to a proxy that just declined to carry it (HackerOne
  // #541502). The status is therefore the only thing that survives, and it survives
  // wearing the destination's clothes. Reporting it as an API error sends the user
  // to look at their account when the answer is their proxy, so the two are told
  // apart here rather than left for a person to guess at.
  //
  // Verified against https-proxy-agent 9.1.0 (dist/index.js:104, 134-157): the
  // proxyConnect event fires before the stand-in socket is built.
  if (proxyConnectStatus !== undefined && proxyConnectStatus !== 200) {
    throw new CcbError(
      `The proxy refused to open a tunnel to ${new URL(url).host} (${proxyConnectStatus} ${result.statusText})`,
      'proxy_rejected',
      proxyConnectStatus === 407
        ? `The proxy${proxyUrl ? ` at ${proxyUrl}` : ''} requires authentication. Put the credentials in the proxy URL, as in http://user:pass@host:port.`
        : `This is the proxy${proxyUrl ? ` at ${proxyUrl}` : ''} answering, not the Anthropic API.`,
      { ...(proxyUrl && { proxyUrl }), proxyConnectStatus, reachedDestination: false },
    );
  }

  const { status, statusText, text, retryAfterSec } = result;

  if (status < 200 || status >= 300) {
    return { ok: false, status, statusText, body: undefined as T, ...(retryAfterSec !== undefined && { retryAfterSec }) };
  }

  try {
    return { ok: true, status, statusText, body: JSON.parse(text) as T };
  } catch {
    throw new CcbError(
      `Expected JSON from ${url} but got something else`,
      'api_error',
      viaProxy ? 'A proxy that returns an error page instead of the response looks like this.' : undefined,
      { status, ...(proxyUrl && { proxyUrl }), reachedDestination: true },
    );
  }
}

/**
 * The proxy in play for `url`, safe to print, so a caller can name it in its own
 * errors. Credentials are stripped here rather than at each call site, because a
 * call site that forgets is a call site that prints a password.
 */
export function proxyInUseFor(url: string): string | undefined {
  return redactProxyUrl(resolveProxyUrl(url));
}
