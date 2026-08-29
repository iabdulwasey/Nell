/**
 * @nell/payments
 *
 * Spending controls that are not enforced by our own code.
 *
 * Every other gate in this system is software checking itself. A single-use card
 * with a network-enforced limit is a different kind of guarantee: if every gate
 * above it failed at once, the charge still cannot exceed what the user
 * approved, because the entity declining it has never heard of us.
 *
 * The issuing adapter is commercial (`/ee/stripe-issuing`). The policy lives
 * here, in the core, so a self-hoster can read exactly what would be authorized
 * on their behalf.
 *
 * Governed by: docs/security-model.md
 */

export {
  authorizeCard,
  describeCard,
  explainCardDenial,
  issueCard,
  markClosed,
  markUsed,
  sweepExpired,
  toleranceFor,
  CARD_TTL_MS,
  TOLERANCE_CAP,
  TOLERANCE_MINIMUM,
  TOLERANCE_PERCENT,
  type CardDecision,
  type CardDenialReason,
  type CardIssuer,
  type CardState,
  type IssueOutcome,
  type IssueRequest,
  type UseCardOptions,
  type VirtualCard,
} from "./virtual-card.js";
