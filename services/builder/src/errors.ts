import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTP_STATUS, type ErrorCode } from '@kelay/contracts';

export type BuilderErrorCode = ErrorCode;

/** Answered as `{ error: { code, message } }` with the status of contracts §0. */
export class ApiError extends Error {
  constructor(
    readonly code: BuilderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get status(): ContentfulStatusCode {
    return (HTTP_STATUS[this.code] ?? 500) as ContentfulStatusCode;
  }
}

export const errorBody = (code: BuilderErrorCode, message: string) => ({ error: { code, message } });
