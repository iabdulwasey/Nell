/**
 * @nell/views
 *
 * Presentation logic shared by the web dashboard and the chat channels.
 *
 * It lives in a package rather than inside components because several of these
 * are security properties — an approval card that shows something other than
 * what the token commits to, a vault row that carries a value, an audit panel
 * that renders a broken chain without saying so — and a security property
 * asserted inside a React component is one nobody tests.
 *
 * Governed by: docs/security-model.md, docs/architecture.md
 */

export {
  buildApprovalCard,
  cardMatches,
  explainPriceChange,
  formatAmount,
  renderApprovalCard,
  type ApprovalCard,
  type ApprovalLine,
  type PriceChange,
} from "./approval.js";

export {
  auditView,
  groupTasks,
  machinePanel,
  memoryRow,
  vaultRow,
  type AuditView,
  type MachinePanel,
  type MachineState,
  type MemoryEntryState,
  type MemoryRow,
  type TaskGroups,
  type TaskState,
  type TaskSummary,
  type VaultItemState,
  type VaultKind,
  type VaultRow,
} from "./panels.js";

export {
  describeKey,
  estimateMonthlyCost,
  formatPrice,
  looksLikeKey,
  settingsProblems,
  tierPanel,
  type ModelOption,
  type SettingsProblem,
  type StoredKey,
  type TierPanel,
} from "./models.js";
