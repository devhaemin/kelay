/** Error shape shared by both ConsoleApi implementations; mirrors contracts `ErrorResponse`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string): ApiError => new ApiError('not_found', `${what} not found`, 404);

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
