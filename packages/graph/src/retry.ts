import type { GraphNode } from '@kelay/contracts';

/** Effective retry settings, shared by the compiler and the local runner so both wait the same way. */
export interface RetryPolicy {
  /** Retries after the first attempt (ASL `MaxAttempts`). */
  maxAttempts: number;
  intervalSeconds: number;
  backoffRate: number;
}

export function retryPolicy(node: GraphNode): RetryPolicy | undefined {
  if (!node.retry) return undefined;
  return {
    maxAttempts: node.retry.maxAttempts,
    // ASL IntervalSeconds must be a positive integer; its default is 1.
    intervalSeconds: Math.max(1, Math.ceil(node.retry.intervalSeconds ?? 1)),
    // ASL BackoffRate defaults to 2.0.
    backoffRate: node.retry.backoffRate ?? 2,
  };
}

/** Delay before retry `n` (1-based), as Step Functions computes it without jitter. */
export function retryDelaySeconds(policy: RetryPolicy, n: number): number {
  return policy.intervalSeconds * policy.backoffRate ** (n - 1);
}
