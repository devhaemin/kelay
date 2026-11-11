import { toKelayError, type KelayError } from './errors.ts';

export type SafeResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'denied'; error: KelayError }
  | { status: 'error'; error: KelayError };

export interface SafeHandlers {
  /** Called when the server refused the action for this user (code `denied`). */
  onDenied?: (error: KelayError) => void;
  /** Called for every other failure. */
  onError?: (error: KelayError) => void;
}

/** Runs a mutation and returns its outcome instead of throwing, so a denied action cannot crash a screen. */
export async function safeMutation<T>(fn: () => T, handlers: SafeHandlers = {}): Promise<SafeResult<Awaited<T>>> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (e) {
    const error = toKelayError(e);
    if (error.isDenied()) {
      handlers.onDenied?.(error);
      return { status: 'denied', error };
    }
    handlers.onError?.(error);
    return { status: 'error', error };
  }
}
