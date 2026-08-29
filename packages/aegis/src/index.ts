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
