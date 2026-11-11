/** What every server action returns: thrown errors are redacted in production builds. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };
