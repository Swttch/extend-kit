/**
 * Facts a caller may need to act on, carried as fields rather than folded into
 * the message.
 *
 * A caller that has to recover the retry delay by matching a regular expression
 * against prose is a caller that breaks the next time the prose is reworded. The
 * plugin backend does exactly that today, and every one of these fields exists
 * because something downstream would otherwise have to read the sentence.
 */
export interface CcbErrorDetails {
  /** HTTP status the destination answered with, when there was one. */
  status?: number;
  /** How long to wait before trying again, from a Retry-After header. */
  retryAfterSec?: number;
  /** The proxy the request was routed through, when one applied. */
  proxyUrl?: string;
  /** The status a proxy answered a CONNECT with, when it refused the tunnel. */
  proxyConnectStatus?: number;
  /** Whether the request reached the destination, or stalled before the tunnel opened. */
  reachedDestination?: boolean;
}

export class CcbError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
    public readonly details?: CcbErrorDetails,
  ) {
    super(message);
    this.name = 'CcbError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint && { hint: this.hint }),
        ...(this.details && Object.keys(this.details).length > 0 && { details: this.details }),
      },
    };
  }
}
