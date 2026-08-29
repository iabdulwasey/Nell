/**
 * @nell/aegis
 *
 * The policy engine and tool-executor chokepoint. Every consequential tool call
 * passes through here, and the model cannot bypass it because this IS the
 * executor: spend-approval tokens, the provenance/untrusted-content gate, vault
 * origin allowlist checks, the post-autofill taint machine, rate limits.
 *
 * Security is enforced here, not in prompts.
 *
 * Governed by: docs/security-model.md
 */

export { askBeforeSpending, commitsMoney, type MoneyVerdict } from "./commits-money.js";
export {
  authorizeSpend,
  DEFAULT_APPROVAL_TTL_MS,
  explainDenial,
  mintApproval,
  payloadHash,
  purchasePayloadSchema,
  type ApprovalToken,
  type AuthorizeOptions,
  type MintOptions,
  type PurchasePayload,
  type SpendDecision,
  type SpendDenialReason,
} from "./spend.js";

export {
  checkOrigin,
  explainOriginDenial,
  normalizeOrigin,
  type OriginCheck,
  type OriginDecision,
  type OriginDenialReason,
} from "./origin.js";

export {
  afterNavigation,
  authorizeOperation,
  markFilled,
  scrubSecrets,
  UNTAINTED,
  type BrowserOperation,
  type OperationDecision,
  type TaintState,
} from "./taint.js";

export {
  authorizeTool,
  isConsequential,
  type GateDecision,
  type ToolClass,
  type TurnContext,
} from "./provenance-gate.js";

export {
  BrowserExecutor,
  type AuditSink,
  type DriverOptions,
  type DriverResult,
  type ExecuteOutcome,
  type ExecuteRequest,
  type ExecutorOptions,
  type SessionDriver,
} from "./executor.js";

export {
  AGENT_IN_CONTROL,
  DEFAULT_HANDOFF_TTL_MS,
  describeReason,
  explainHandoffDenial,
  handOverControl,
  handoffMessage,
  handoffReasonSchema,
  hashToken,
  markRedeemed,
  mintHandoff,
  redeemHandoff,
  revokeHandoff,
  takeBackControl,
  type ControlHolder,
  type ControlState,
  type HandoffDecision,
  type HandoffDenialReason,
  type HandoffGrant,
  type HandoffReason,
  type MintedHandoff,
  type MintHandoffOptions,
  type RedeemOptions,
} from "./handoff.js";

export {
  explainOtpDenial,
  hashOtpToken,
  markOtpUsed,
  mintOtpGrant,
  otpApprovalPrompt,
  redeemOtpGrant,
  OTP_GRANT_TTL_MS,
  OTP_MESSAGE_WINDOW_MS,
  type CandidateMessage,
  type MintedOtpGrant,
  type MintOtpGrantOptions,
  type OtpDecision,
  type OtpDenialReason,
  type OtpGrant,
  type RedeemOtpOptions,
} from "./otp-grant.js";

export {
  authorizeStanding,
  describeEnvelope,
  envelopeSchema,
  explainStandingDenial,
  hashStandingToken,
  markStandingSpent,
  mintStandingApproval,
  revokeStanding,
  STANDING_APPROVAL_TTL_MS,
  STANDING_CEILING,
  type AuthorizeStandingOptions,
  type Envelope,
  type MintStandingOptions,
  type MintStandingOutcome,
  type StandingApproval,
  type StandingDecision,
  type StandingDenial,
} from "./standing-approval.js";

export {
  canAccess,
  explainAccessRefusal,
  householdRoleSchema,
  removeMember,
  share,
  supervisionNotice,
  unshare,
  visibilitySchema,
  visibleTo,
  DEFAULT_VISIBILITY,
  type AccessDecision,
  type AccessQuestion,
  type AccessRefusal,
  type HouseholdRole,
  type Membership,
  type OwnedThing,
  type ShareDecision,
  type ShareRefusal,
  type Visibility,
} from "./household.js";
