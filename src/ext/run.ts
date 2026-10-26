import { getCredentials, getAccessToken } from '../battery/auth/index.js';
import { requestJson, proxyInUseFor } from '../battery/api/http.js';
import { CcbError } from '../battery/errors.js';
import { findOperation, type Operation } from './operations.js';

/** What `swttch-ext api` prints: one object on stdout, whatever happened. */
export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; status?: number; hint?: string } };

const BASE_URL = 'https://api.anthropic.com';
/**
 * Headers the artifact service asks of its callers. Without them its answers are 404 for every
 * path, including ones the account plainly has (measured: the same login lists its artifacts with
 * them and gets "not found" without). They say which kind of client is asking, and Claude Code's
 * own client sends the same set. The version names this tool, not Claude Code: the service has
 * accepted that, and a caller should not claim to be a client it is not.
 */
function frameHeaders(version: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Frame-CP': 'go',
    'X-Frame-Surface': 'code',
    'X-Frame-Platform': 'cli',
    'X-Frame-Client-Version': `swttch-ext/${version}`,
  };
}
/** The same beta flag `ccb oauth` sends; the login is a Claude.ai OAuth token. */
const OAUTH_BETA = 'oauth-2025-04-20';
/** The longest a retry will wait on the server's own Retry-After, as the CLI caps it. */
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

export interface RunOptions {
  /** Confirms a destructive call. */
  yes?: boolean;
  /** Where to send it; defaults to ANTHROPIC_BASE_URL, then the real API. Tests point it at a local server. */
  baseUrl?: string;
  /** A token to use instead of the saved login. Tests only; a caller never passes the user's. */
  token?: string;
  /** This tool's version, sent so the service can tell its callers apart. */
  version?: string;
}

function resolveBaseUrl(explicit: string | undefined): string {
  const chosen = explicit ?? process.env.ANTHROPIC_BASE_URL?.trim() ?? '';
  return (chosen || BASE_URL).replace(/\/+$/, '');
}

function fail(code: string, message: string, extra: { status?: number; hint?: string } = {}): ApiResult {
  return { ok: false, error: { code, message, ...extra } };
}

/** Check the values against the call's parameters, and say what is wrong in a way a caller can show. */
export function checkParams(op: Operation, values: Record<string, string>): ApiResult | undefined {
  const known = new Set(op.params.map((p) => p.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) return fail('invalid_argument', `--${name} is not a parameter of ${op.service} ${op.name}.`);
  }
  for (const param of op.params) {
    const value = values[param.name];
    if (value === undefined) {
      if (param.required) return fail('invalid_argument', `--${param.name} is required for ${op.service} ${op.name}.`);
      continue;
    }
    if (value.trim() === '') return fail('invalid_argument', `--${param.name} must not be empty.`);
    if (value.length > param.maxLength) {
      return fail('invalid_argument', `--${param.name} is longer than ${param.maxLength} characters.`);
    }
    if (param.kind === 'digits' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > (param.max ?? 1000))) {
      return fail('invalid_argument', `--${param.name} must be a whole number from 1 to ${param.max ?? 1000}.`);
    }
    // A path parameter is one segment: letting a slash through would let a value name another path.
    if (param.in === 'path' && !/^[A-Za-z0-9_-]+$/.test(value)) {
      return fail('invalid_argument', `--${param.name} may hold only letters, digits, "-" and "_".`);
    }
  }
  return undefined;
}

function buildRequest(op: Operation, values: Record<string, string>): { path: string; body?: Record<string, string> } {
  let path = op.path;
  const body: Record<string, string> = {};
  const query: string[] = [];
  for (const param of op.params) {
    const value = values[param.name];
    if (value === undefined) continue;
    if (param.in === 'path') path = path.replace(`{${param.name}}`, encodeURIComponent(value));
    else if (param.in === 'query') query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
    else body[param.name] = value;
  }
  if (query.length > 0) path += `?${query.join('&')}`;
  return Object.keys(body).length > 0 ? { path, body } : { path };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Make one call from the table. Never throws for an answer the server gave: a refusal is an
 * `ok: false` result with a code. It throws only {@link CcbError}s for things outside the call
 * (no login, no network), which the entry point turns into the same shape.
 */
export async function runOperation(
  service: string,
  name: string,
  values: Record<string, string>,
  options: RunOptions = {},
): Promise<ApiResult> {
  const op = findOperation(service, name);
  if (!op) return fail('unknown_operation', `There is no call named "${service} ${name}". Run \`swttch-ext api --list\`.`);

  const bad = checkParams(op, values);
  if (bad) return bad;
  if (op.destructive && !options.yes) {
    return fail('confirmation_required', `${op.service} ${op.name} cannot be undone. Run it again with --yes to go ahead.`);
  }

  const token = options.token ?? getAccessToken(await getCredentials());
  const request = buildRequest(op, values);
  const url = `${resolveBaseUrl(options.baseUrl)}${request.path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    ...(op.service === 'frame' ? frameHeaders(options.version ?? 'dev') : {}),
  };

  let response = await requestJson<unknown>(op.method, url, headers, { body: request.body });
  if (!response.ok && op.retryOn?.includes(response.status)) {
    // The server said "not now": wait as long as it asked (capped), then ask once more.
    const waitMs = Math.min(MAX_RETRY_WAIT_MS, (response.retryAfterSec ?? DEFAULT_RETRY_WAIT_MS / 1000) * 1000);
    await sleep(waitMs);
    response = await requestJson<unknown>(op.method, url, headers, { body: request.body });
  }

  if (response.ok) return { ok: true, data: response.body ?? null };

  const rule = op.errors.find((e) => e.status === response.status);
  const proxy = proxyInUseFor(url);
  if (rule) {
    const detail = response.errorText && rule.status !== 404 ? ` (${readableReason(response.errorText)})` : '';
    return fail(rule.code, `${rule.message}${detail}`, { status: response.status });
  }
  if (response.status === 401) {
    return fail('token_expired', 'The saved login is no longer accepted.', {
      status: 401, hint: 'Run `claude` once to refresh it.',
    });
  }
  if (response.status === 403) {
    return fail('forbidden', 'This account may not do that.', {
      status: 403,
      hint: proxy ? `The request went through the proxy at ${proxy}; a refusal can come from the network.` : undefined,
    });
  }
  if (response.status === 429) {
    return fail('rate_limited', 'Too many requests. Try again shortly.', {
      status: 429,
      hint: response.retryAfterSec !== undefined ? `Retry after ${response.retryAfterSec}s.` : undefined,
    });
  }
  return fail(
    'api_error',
    `The server answered ${response.status} ${response.statusText}.`,
    { status: response.status, ...(response.errorText && { hint: readableReason(response.errorText) }) },
  );
}

/** The server's own sentence from an error body shaped `{"error":"..."}` or `{"error":{"message":"..."}}`, else the text itself. */
export function readableReason(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
      return (parsed.error as { message: string }).message;
    }
  } catch {
    // Not JSON: the text is the reason.
  }
  return errorText;
}

export function describeError(err: unknown): ApiResult {
  if (err instanceof CcbError) {
    return fail(err.code, err.message, { ...(err.hint && { hint: err.hint }), ...(err.details?.status && { status: err.details.status }) });
  }
  return fail('unknown_error', err instanceof Error ? err.message : String(err));
}
