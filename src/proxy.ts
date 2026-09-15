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
 * A proxy URL with any username and password taken out, safe to show a person.
 *
 * Proxy credentials live in the URL itself, and the URL is the most useful thing
 * an error about a proxy can name. Those two facts together are how a password
 * ends up in an error message, and from there in the screenshot someone attaches
 * to a bug report. Every message this package writes goes through here first.
 *
 * The reporter on Swttch/swttch#181 configured exactly such a URL, so this is not
 * a hypothetical shape.
 */
export function redactProxyUrl(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    const url = new URL(proxyUrl);
    if (!url.username && !url.password) return proxyUrl;
    url.username = '';
    url.password = '';
    // A URL that carried credentials should still look like it did, so the user
    // recognises which setting is being talked about.
    return url.toString().replace('//', '//***@');
  } catch {
    // Not parseable, so it cannot be picked apart safely. Say nothing rather than
    // risk printing a password that happens to sit in an unparseable string.
    return undefined;
  }
}

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
 *
 * **An https target falls back to HTTP_PROXY, and that is a deliberate departure
 * from curl.** curl reads only the variable matching the target's scheme, so
 * HTTP_PROXY never applies to an https URL there. The `claude` CLI does not
 * follow that rule: given HTTP_PROXY alone, whether exported in the environment
 * or written into settings.json's `env` block, it tunnels api.anthropic.com
 * through it. Both behaviours were measured against a local CONNECT proxy.
 *
 * Matching curl instead of `claude` is what broke Swttch/swttch#432 for the
 * person who reported it: one settings.json, chat working because the CLI
 * honored HTTP_PROXY, and the usage panel going out direct because this function
 * did not. The user writes that file for `claude`, so `claude` is the behaviour
 * to match — the plugin's whole premise is that anything possible from the CLI
 * is possible from the GUI.
 */
export function resolveProxyUrl(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const target = new URL(targetUrl);
  const isSecure = target.protocol === 'https:' || target.protocol === 'wss:';
  const port = target.port || (isSecure ? '443' : '80');

  if (isProxyBypassed(target.hostname, port, readProxyEnv(env, 'NO_PROXY'))) return undefined;

  const specific = isSecure
    ? readProxyEnv(env, 'HTTPS_PROXY') ?? readProxyEnv(env, 'HTTP_PROXY')
    : readProxyEnv(env, 'HTTP_PROXY');
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
export function proxyAgentFor(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Agent | undefined {
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

  // A deadline has to reach the AGENT, not just the request.
  //
  // While an agent is negotiating with the proxy there is no socket on the
  // request yet, so aborting the request reaches nothing: measured against a
  // proxy that accepted a CONNECT and stayed silent, an aborted request produced
  // no 'socket', no 'error' and no 'close', and simply hung. The caller would get
  // its timeout while the connection attempt carried on behind it.
  //
  // The two agents take different instruments for the same job, so each is given
  // the one it honors rather than one being forced on both.
  if (SOCKS_PROTOCOLS.has(protocol)) {
    // socks-proxy-agent hands `timeout` to SocksClient, which applies it to the
    // handshake. It does not read `signal`, and passing one is not merely
    // ignored — its options type has no room for it.
    return new SocksProxyAgent(proxyUrl, options.timeoutMs ? { timeout: options.timeoutMs } : undefined);
  }
  if (protocol === 'http:' || protocol === 'https:') {
    // HttpsProxyAgent covers http: and https: alike, because every endpoint this
    // package talks to is https/wss and therefore always reached by a CONNECT
    // tunnel. Its options are spread into what it passes to net.connect, so a
    // signal here destroys the socket the CONNECT wait is parked on and lets the
    // failure surface. Measured: the error arrived 8ms after the abort.
    return new HttpsProxyAgent(proxyUrl, options.signal ? { signal: options.signal } : undefined);
  }

  throw new CcbError(
    `Unsupported proxy scheme "${protocol.replace(':', '')}" in ${proxyUrl}`,
    'invalid_proxy',
    'Supported schemes: http, https, socks, socks4, socks4a, socks5, socks5h',
  );
}
