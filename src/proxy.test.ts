import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { resolveProxyUrl, isProxyBypassed, proxyAgentFor } from './proxy.js';
import { CcbError } from './battery/errors.js';

const API = 'https://api.anthropic.com/api/oauth/usage';
const WSS = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';

describe('resolveProxyUrl()', () => {
  it('returns undefined when nothing is configured', () => {
    assert.strictEqual(resolveProxyUrl(API, {}), undefined);
  });

  it('uses HTTPS_PROXY for an https target', () => {
    assert.strictEqual(
      resolveProxyUrl(API, { HTTPS_PROXY: 'http://proxy:8080', HTTP_PROXY: 'http://wrong:8080' }),
      'http://proxy:8080',
    );
  });

  it('uses HTTP_PROXY for an http target', () => {
    assert.strictEqual(
      resolveProxyUrl('http://example.com/x', { HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://wrong:8080' }),
      'http://proxy:8080',
    );
  });

  // A WebSocket is an HTTP upgrade, so the user's HTTPS_PROXY has to apply to it.
  it('treats wss:// as https for proxy selection', () => {
    assert.strictEqual(resolveProxyUrl(WSS, { HTTPS_PROXY: 'http://proxy:8080' }), 'http://proxy:8080');
  });

  it('treats ws:// as http for proxy selection', () => {
    assert.strictEqual(
      resolveProxyUrl('ws://example.com/s', { HTTP_PROXY: 'http://proxy:8080' }),
      'http://proxy:8080',
    );
  });

  it('falls back to ALL_PROXY when no scheme-specific variable is set', () => {
    assert.strictEqual(resolveProxyUrl(API, { ALL_PROXY: 'socks5://127.0.0.1:1080' }), 'socks5://127.0.0.1:1080');
  });

  it('prefers the scheme-specific variable over ALL_PROXY', () => {
    assert.strictEqual(
      resolveProxyUrl(API, { HTTPS_PROXY: 'http://specific:8080', ALL_PROXY: 'socks5://generic:1080' }),
      'http://specific:8080',
    );
  });

  // Both spellings circulate in the wild; reading only one silently ignores a
  // proxy the user believes they configured.
  it('reads the lowercase spelling too', () => {
    assert.strictEqual(resolveProxyUrl(API, { https_proxy: 'http://lower:8080' }), 'http://lower:8080');
  });

  it('lets the uppercase spelling win a conflict', () => {
    assert.strictEqual(
      resolveProxyUrl(API, { HTTPS_PROXY: 'http://upper:8080', https_proxy: 'http://lower:8080' }),
      'http://upper:8080',
    );
  });

  it('ignores a variable that is set but empty', () => {
    assert.strictEqual(resolveProxyUrl(API, { HTTPS_PROXY: '   ' }), undefined);
  });

  it('returns undefined when NO_PROXY covers the host', () => {
    assert.strictEqual(
      resolveProxyUrl(API, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'api.anthropic.com' }),
      undefined,
    );
  });
});

describe('isProxyBypassed()', () => {
  it('is false when NO_PROXY is unset', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', undefined), false);
  });

  it('matches an exact host', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'api.anthropic.com'), true);
  });

  it('does not match an unrelated host', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'example.com'), false);
  });

  it('bypasses everything on *', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', '*'), true);
  });

  it('matches subdomains of a bare entry', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'anthropic.com'), true);
  });

  it('ignores a leading dot', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', '.anthropic.com'), true);
  });

  it('does not let a suffix match cut mid-label', () => {
    assert.strictEqual(isProxyBypassed('evil-anthropic.com', '443', 'anthropic.com'), false);
  });

  it('reads a comma-separated list', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'example.com, api.anthropic.com'), true);
  });

  it('honors a port pinned on the entry', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'api.anthropic.com:443'), true);
  });

  it('does not bypass when the pinned port differs', () => {
    assert.strictEqual(isProxyBypassed('api.anthropic.com', '443', 'api.anthropic.com:8080'), false);
  });
});

describe('proxyAgentFor()', () => {
  it('returns undefined for a direct connection', () => {
    assert.strictEqual(proxyAgentFor(API, {}), undefined);
  });

  it('builds an HTTP CONNECT agent for an http:// proxy', () => {
    assert.ok(proxyAgentFor(API, { HTTPS_PROXY: 'http://proxy:8080' }) instanceof HttpsProxyAgent);
  });

  // The reporter on #181 described an ssh tunnel, which is SOCKS — a case the
  // HTTP CONNECT agent cannot serve.
  it('builds a SOCKS agent for a socks5:// proxy', () => {
    assert.ok(proxyAgentFor(API, { ALL_PROXY: 'socks5://127.0.0.1:1080' }) instanceof SocksProxyAgent);
  });

  it('builds a SOCKS agent for socks4:// too', () => {
    assert.ok(proxyAgentFor(API, { ALL_PROXY: 'socks4://127.0.0.1:1080' }) instanceof SocksProxyAgent);
  });

  it('carries credentials embedded in the proxy URL', () => {
    // The reporter on #181 configures exactly this shape: http://user:pass@host:port
    const agent = proxyAgentFor(API, { HTTPS_PROXY: 'http://user:pass@127.0.0.1:8080' });
    assert.ok(agent instanceof HttpsProxyAgent);
    assert.strictEqual(agent.proxy.username, 'user');
    assert.strictEqual(agent.proxy.password, 'pass');
  });

  // Falling back to a direct connection would fail anyway on a machine that can
  // only get out through a proxy, and it would fail without naming the cause.
  it('throws on a proxy URL that cannot be parsed', () => {
    assert.throws(
      () => proxyAgentFor(API, { HTTPS_PROXY: 'not a url' }),
      (err: unknown) => err instanceof CcbError && err.code === 'invalid_proxy',
    );
  });

  it('throws on a scheme it cannot route', () => {
    assert.throws(
      () => proxyAgentFor(API, { HTTPS_PROXY: 'ftp://proxy:21' }),
      (err: unknown) => err instanceof CcbError && err.code === 'invalid_proxy',
    );
  });
});
