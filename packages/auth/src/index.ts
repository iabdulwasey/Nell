/**
 * @nell/auth
 *
 * Phone-number sign-in: OTP issuance and verification, recovery codes, and the
 * rate limits that keep a send endpoint from becoming an abuse vector.
 *
 * Delivery is a port, not an implementation — this package never talks to a
 * messaging provider, which is why the entire flow is testable without one and
 * why a self-hoster can plug in whichever provider they already pay for.
 *
 * Governed by: docs/security-model.md
 */

/** Where a code is being sent, and what it is for. */
export interface DeliveryRequest {
  /** Normalized E.164 destination. */
  readonly destination: string;
  readonly code: string;
  /** Rendered message; providers that template their own may ignore it. */
  readonly body: string;
}

/**
 * Implemented per provider (SMS, iMessage gateway, WhatsApp, email). Failures
 * throw; the caller decides whether to surface or retry.
 */
export interface DeliveryProvider {
  readonly name: string;
  send(request: DeliveryRequest): Promise<void>;
}

/** Default copy. Short, no branding games, no links — links train phishing. */
export function renderOtpMessage(code: string): string {
  return `${code} is your Nell verification code. It expires in 5 minutes. If you didn't request it, ignore this message.`;
}

export {
  CODE_LENGTH,
  DEFAULT_TTL_MS,
  explainOtpFailure,
  generateCode,
  hashCode,
  issueOtp,
  MAX_ATTEMPTS,
  verifyOtp,
  type IssuedOtp,
  type IssueOptions,
  type OtpChallenge,
  type OtpFailure,
  type OtpResult,
  type VerifyOptions,
} from "./otp.js";

export {
  generateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
  redeemRecoveryCode,
  type GeneratedRecoveryCodes,
  type RecoveryCodeRecord,
  type RecoveryResult,
} from "./recovery.js";

export {
  checkRateLimit,
  FRESH,
  PER_DESTINATION,
  PER_ORIGIN,
  RESEND_COOLDOWN_MS,
  type RateLimitDecision,
  type RateLimitRule,
  type RateLimitState,
} from "./rate-limit.js";
