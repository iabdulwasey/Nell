/**
 * @nell/companion
 *
 * The desktop companion: Nell driving the user's own browser, on their own
 * machine, over an authenticated tunnel.
 *
 * The honest answer to CAPTCHAs and residential-IP checks, because it is not an
 * evasion of them — the request really does come from the person's computer.
 * Also the most dangerous thing in the product, which is why the trust direction
 * is inverted here: on someone's own laptop *we* are the outside party, so the
 * companion evaluates requests rather than executing instructions, and refuses
 * on its own authority.
 *
 * Governed by: docs/security-model.md
 */

export {
  beginPairing,
  completePairing,
  confirmPairing,
  explainPairingFailure,
  hashCode,
  isUsable,
  revokeDevice,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_CODE_DIGITS,
  PAIRING_TTL_MS,
  type BeginPairingOptions,
  type BegunPairing,
  type CompletedPairing,
  type CompletePairingOptions,
  type ConfirmOptions,
  type PairedDevice,
  type PairingFailure,
  type PairingRequest,
  type PairingResult,
} from "./pairing.js";

export {
  allowOrigin,
  companionActionSchema,
  defaultPolicy,
  describeActivity,
  evaluate,
  explainLocalRefusal,
  halt,
  resume,
  revokeOrigin,
  setPresence,
  DEFAULT_SESSION_LIMIT_MS,
  type CompanionAction,
  type EvaluateOptions,
  type LocalDecision,
  type LocalPolicy,
  type LocalRefusal,
} from "./local-policy.js";
