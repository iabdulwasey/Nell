/**
 * Rate limiting for code sends.
 *
 * Every OTP send costs real money at a messaging provider, so an unthrottled
 * send endpoint is both an abuse vector and a way to run up someone's bill.
 * Two independent limits apply:
 *
 * - per destination, so one number cannot be spammed (and one attacker cannot
 *   burn budget by hammering a single target)
 * - per origin (IP or account), so one caller cannot fan out across many numbers
 *
 * A fixed window is deliberate: it is trivially auditable and needs a single
 * row, which matters when the limiter itself must survive a restart.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

/** Conservative defaults: enough for a real person, useless for a script. */
export const PER_DESTINATION: RateLimitRule = { limit: 5, windowMs: 60 * 60 * 1000 };
export const PER_ORIGIN: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 };

/** Minimum spacing between sends to the same destination. */
export const RESEND_COOLDOWN_MS = 60 * 1000;

export interface RateLimitState {
  readonly count: number;
  readonly windowStartedAt: number;
  readonly lastSentAt?: number;
}

export type RateLimitDecision =
  | { readonly allowed: true; readonly state: RateLimitState }
  | {
      readonly allowed: false;
      readonly reason: "cooldown" | "limit-reached";
      /** When the caller may try again. */
      readonly retryAfterMs: number;
      readonly state: RateLimitState;
    };

export const FRESH: RateLimitState = { count: 0, windowStartedAt: 0 };

export function checkRateLimit(
  state: RateLimitState,
  rule: RateLimitRule,
  now: number,
  cooldownMs = RESEND_COOLDOWN_MS
): RateLimitDecision {
  // A new window resets the count.
  const windowExpired = now - state.windowStartedAt >= rule.windowMs;
  const current: RateLimitState = windowExpired
    ? { count: 0, windowStartedAt: now, lastSentAt: state.lastSentAt }
    : state;

  if (cooldownMs > 0 && current.lastSentAt !== undefined && now - current.lastSentAt < cooldownMs) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: cooldownMs - (now - current.lastSentAt),
      state: current,
    };
  }

  if (current.count >= rule.limit) {
    return {
      allowed: false,
      reason: "limit-reached",
      retryAfterMs: current.windowStartedAt + rule.windowMs - now,
      state: current,
    };
  }

  return {
    allowed: true,
    state: { count: current.count + 1, windowStartedAt: current.windowStartedAt, lastSentAt: now },
  };
}
