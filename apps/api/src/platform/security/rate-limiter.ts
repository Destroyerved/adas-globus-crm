import { DomainError } from '../errors/index.js';

/**
 * Fixed-window per-actor rate limiter for authenticated API endpoints (PRD §6.7, §9).
 * Evicts expired buckets opportunistically to keep memory bounded.
 */
export class PerUserRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxRequestsPerWindow: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(actorKey: string): { remaining: number; resetSeconds: number } {
    const currentMs = this.now();
    if (this.buckets.size > 2_000) {
      for (const [k, v] of this.buckets) {
        if (v.resetAt <= currentMs) this.buckets.delete(k);
      }
    }

    let bucket = this.buckets.get(actorKey);
    if (!bucket || bucket.resetAt <= currentMs) {
      bucket = { count: 0, resetAt: currentMs + this.windowMs };
      this.buckets.set(actorKey, bucket);
    }

    if (bucket.count >= this.maxRequestsPerWindow) {
      const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentMs) / 1000));
      throw new DomainError({
        status: 429,
        code: 'RATE_LIMITED',
        title: 'Too many requests',
        detail: `API rate limit exceeded (${this.maxRequestsPerWindow} requests per minute). Retry in ${resetSeconds} seconds.`,
      });
    }

    bucket.count += 1;
    return {
      remaining: Math.max(0, this.maxRequestsPerWindow - bucket.count),
      resetSeconds: Math.max(1, Math.ceil((bucket.resetAt - currentMs) / 1000)),
    };
  }
}
