import { ErrorCode, HTTP_STATUS } from '@kelay/contracts';

/** Contract error codes, plus `network` for requests that never got an HTTP response. */
export type KelayErrorCode = ErrorCode | 'network';

export class KelayError extends Error {
  readonly code: KelayErrorCode;
  /** HTTP status of the response; for errors raised in the SDK, the contract status of `code` (0 for `network`). */
  readonly status: number;

  constructor(code: KelayErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KelayError';
    this.code = code;
    this.status = options?.status ?? (code === 'network' ? 0 : HTTP_STATUS[code]);
  }

  /** The user's role may not do this (RLS refused it, or it changed no row the user can see). */
  isDenied(): boolean {
    return this.code === 'denied';
  }
}

const FALLBACK_BY_STATUS: Record<number, ErrorCode> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'denied',
  404: 'unknown_app',
  409: 'conflict',
  429: 'rate_limited',
};

/** Maps a non-2xx response body (`{ error: { code, message } }` when well-formed) to a KelayError. */
export function errorFromResponse(status: number, body: unknown): KelayError {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const parsed = ErrorCode.safeParse(err?.code);
  const code = parsed.success ? parsed.data : (FALLBACK_BY_STATUS[status] ?? 'internal');
  const message = typeof err?.message === 'string' ? err.message : `request failed with HTTP ${status}`;
  return new KelayError(code, message, { status });
}

/** Anything thrown → KelayError, so callers handle one error type. */
export function toKelayError(e: unknown): KelayError {
  if (e instanceof KelayError) return e;
  return new KelayError('internal', e instanceof Error ? e.message : String(e), { cause: e });
}
