import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTP_STATUS, type ErrorCode } from '@kelay/contracts';

export type ControlErrorCode = ErrorCode;

export class ApiError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get status(): ContentfulStatusCode {
    return HTTP_STATUS[this.code] as ContentfulStatusCode;
  }
}

export const errorBody = (code: ControlErrorCode, message: string) => ({ error: { code, message } });

export function sendError(c: Context, e: ApiError) {
  return c.json(errorBody(e.code, e.message), e.status);
}

/** Postgres unique_violation, raised directly or wrapped by drizzle. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur && typeof cur === 'object'; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
