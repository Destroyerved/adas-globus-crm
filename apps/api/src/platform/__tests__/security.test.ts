import { describe, expect, it } from 'vitest';
import { PerUserRateLimiter, resolveRequestId } from '../security/index.js';

describe('Security headers & per-user rate limiter (PRD 6.7, 9)', () => {
  it('validates safe X-Request-Id headers and rejects unsafe characters', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': 'req_valid-1234.56' } } as never)).toBe(
      'req_valid-1234.56',
    );
    expect(
      resolveRequestId({ headers: { 'x-request-id': 'bad\r\nheader-injection' } } as never),
    ).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('enforces per-user window rate limits and resets after window expiry', () => {
    let clock = 1_000_000;
    const limiter = new PerUserRateLimiter(3, 60_000, () => clock);

    expect(limiter.check('usr_1').remaining).toBe(2);
    expect(limiter.check('usr_1').remaining).toBe(1);
    expect(limiter.check('usr_1').remaining).toBe(0);
    expect(() => limiter.check('usr_1')).toThrowError(/rate limit exceeded/i);

    // Another user has an independent bucket
    expect(limiter.check('usr_2').remaining).toBe(2);

    // Advance clock past the 60s window
    clock += 61_000;
    expect(limiter.check('usr_1').remaining).toBe(2);
  });
});
