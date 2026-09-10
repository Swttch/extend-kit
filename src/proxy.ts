import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { CcbError } from './battery/errors.js';

/**
 * Proxy support for every outbound connection this package makes.
 *
 * Node does not route outbound requests through a proxy on its own. Its global
 * `fetch` ignores HTTP_PROXY entirely (Node 24 added an opt-in flag for it, but
 * this package supports Node 20+, and that flag does not cover SOCKS at all), and
 * `ws` only proxies when handed an agent. So a user whose machine reaches the
 * internet only through a proxy — a corporate egress proxy, or an `ssh -D`
 * tunnel — got a plain connection failure from `ccb`, while `claude` itself
 * worked because the CLI does its own proxying. That gap is what this module
 * closes: see Swttch/swttch#181.
 *
 * The variables read here are the ones curl and the claude CLI already read, so
 * a machine that is set up for those needs no extra configuration for `ccb`.
 */

/** Proxy URL schemes that mean SOCKS rather than an HTTP CONNECT proxy. */
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

/**
 * Read a proxy variable in either spelling.
 *
 * Both cases are in real use — most tooling documents the uppercase form, while
 * curl has historically honored the lowercase one — and users copy whichever
 * their last set of instructions showed. Reading only one spelling silently
 * ignores a proxy the user believes they configured, which is the whole failure
 * this module exists to prevent, so both are accepted with uppercase winning a
 * conflict.
 */
function readProxyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = env[name.toUpperCase()];
  if (typeof upper === 'string' && upper.trim()) return upper.trim();
  const lower = env[name.toLowerCase()];
  if (typeof lower === 'string' && lower.trim()) return lower.trim();
  return undefined;
}

/**
 * Whether NO_PROXY exempts this host, following the de-facto rules curl uses:
 * a comma-separated list, `*` meaning everything, a leading dot ignored, and a
 * bare entry matching that host plus its subdomains. An entry may pin a port,
 * in which case the port must match too.
 */
export function isProxyBypassed(host: string, port: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const entries = noProxy.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (entries.includes('*')) return true;

  const target = host.toLowerCase();
  return entries.some((entry) => {
    let pattern = entry;
    let entryPort: string | undefined;
    // Only split a port off when it is unambiguous; a bare IPv6 literal is full
    // of colons and must not be chopped at the first one.
    const lastColon = pattern.lastIndexOf(':');
    if (lastColon > 0 && !pattern.slice(lastColon + 1).includes(']') && /^\d+$/.test(pattern.slice(lastColon + 1))) {
      entryPort = pattern.slice(lastColon + 1);
      pattern = pattern.slice(0, lastColon);
    }
    if (entryPort !== undefined && entryPort !== port) return false;
    if (pattern.startsWith('.')) pattern = pattern.slice(1);
    return target === pattern || target.endsWith(`.${pattern}`);
  });
}

/**
 * The proxy URL that applies to `targetUrl`, or undefined for a direct connection.
 *
 * `wss:`/`ws:` are resolved as their HTTP equivalents because that is how the
 * connection is actually made — a WebSocket starts life as an HTTP upgrade, so
 * a user who set HTTPS_PROXY expects `wss://` to go through it.
 */
export function resolveProxyUrl(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const target = new URL(targetUrl);
  const isSecure = target.protocol === 'https:' || target.protocol === 'wss:';
  const port = target.port || (isSecure ? '443' : '80');

  if (isProxyBypassed(target.hostname, port, readProxyEnv(env, 'NO_PROXY'))) return undefined;

  const specific = isSecure ? readProxyEnv(env, 'HTTPS_PROXY') : readProxyEnv(env, 'HTTP_PROXY');
  return specific ?? readProxyEnv(env, 'ALL_PROXY');
}

/**
 * An agent that routes a connection to `targetUrl` through the configured proxy,
 * or undefined when no proxy applies and the connection should go out directly.
 *
 * The result is an `http.Agent`, which is the one shape both callers accept:
 * `https.request` takes it as `agent`, and `ws` takes the same object under the
 * same name. That is why this package talks to the API over `node:https` rather
 * than global `fetch` — `fetch` cannot be handed one of these, so using it would
 * mean two separate proxy implementations for the two transports.
 *
 * A malformed proxy URL throws rather than falling back to a direct connection.
 * On a machine that can only reach the internet through a proxy the direct
 * attempt fails anyway, and it fails with a connection error that says nothing
 * about the real cause; naming the bad setting is far more useful.
 */
export function proxyAgentFor(targetUrl: string, env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  if (!proxyUrl) return undefined;

  let protocol: string;
  try {
    protocol = new URL(proxyUrl).protocol;
  } catch {
    throw new CcbError(
      `Proxy setting is not a valid URL: ${proxyUrl}`,
      'invalid_proxy',
      'Expected something like http://host:port or socks5://host:port',
    );
  }

  if (SOCKS_PROTOCOLS.has(protocol)) return new SocksProxyAgent(proxyUrl);
  if (protocol === 'http:' || protocol === 'https:') {
    // HttpsProxyAgent covers both, because every endpoint this package talks to
    // is https/wss and therefore always reached by a CONNECT tunnel.
    return new HttpsProxyAgent(proxyUrl);
  }

  throw new CcbError(
    `Unsupported proxy scheme "${protocol.replace(':', '')}" in ${proxyUrl}`,
    'invalid_proxy',
    'Supported schemes: http, https, socks, socks4, socks4a, socks5, socks5h',
  );
}
