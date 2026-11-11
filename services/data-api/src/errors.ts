// API errors (contract §5) and the mapping from Postgres errors a client can cause.
import { DatabaseError } from 'pg';
import { HTTP_STATUS, type ErrorCode, type ErrorResponse } from '@kelay/contracts';

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): ErrorResponse {
    return { error: { code: this.code, message: this.message } };
  }
}

export const invalid = (message: string): ApiError => new ApiError('invalid_request', message);

/** Messages are fixed strings: Postgres messages can carry SQL fragments and other users' values. */
export function fromDatabaseError(e: unknown): ApiError | undefined {
  if (!(e instanceof DatabaseError) || !e.code) return undefined;
  switch (e.code) {
    case '42501':
      return new ApiError('denied', "not allowed by this app's permissions");
    case '23502':
      return invalid(e.column ? `field "${e.column}" is required` : 'a required field is missing');
    case '23503':
      return invalid('a referenced row does not exist');
    case '23505':
      return invalid('a row with this value already exists');
    case '23514':
      return invalid('a value violates a check constraint');
    case '22007':
    case '22008':
      return invalid('invalid timestamp value');
    case '22P02':
      return invalid('invalid value format');
    case '22003':
      return invalid('number out of range');
  }
  return e.code.startsWith('22') ? invalid('invalid value') : undefined;
}
