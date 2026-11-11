// Token buckets keyed by caller (contract §7: one per sub × app, one per azp × app).
// Buckets start full, hold `perMinute` tokens and refill continuously at `perMinute` per minute.

export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Takes one token from every bucket in `keys`, or from none of them when any bucket is empty. */
  take(keys: string[]): RateVerdict;
}

const PRUNE_ABOVE = 50_000;

export function createRateLimiter(opts: { perMinute: number; now: () => number }): RateLimiter {
  const capacity = opts.perMinute;
  const perMs = opts.perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();

  const level = (key: string, now: number): number => {
    const b = buckets.get(key);
    return b ? Math.min(capacity, b.tokens + (now - b.at) * perMs) : capacity;
  };

  const prune = (now: number): void => {
    for (const key of buckets.keys()) if (level(key, now) >= capacity) buckets.delete(key);
  };

  return {
    take(keys) {
      const now = opts.now();
      const levels = keys.map((key) => level(key, now));
      const short = Math.max(0, ...levels.map((l) => 1 - l));
      if (short > 0) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(short / perMs / 1000)) };
      keys.forEach((key, i) => buckets.set(key, { tokens: levels[i]! - 1, at: now }));
      if (buckets.size > PRUNE_ABOVE) prune(now);
      return { ok: true };
    },
  };
}
