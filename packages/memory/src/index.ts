/**
 * @nell/memory
 *
 * Tier 1 (preference profile) and tier 2 (episodic task ledger): the memory that
 * makes the agent feel like it knows you, and the record that makes "book it
 * like last time" possible.
 *
 * Untrusted content can never write a preference — a preference is effectively a
 * standing instruction, so accepting one from a web page would be prompt
 * injection with persistence.
 *
 * Governed by: docs/architecture.md
 */

export {
  DEFAULT_IMPORTANCE,
  forgetPreference,
  liveProfile,
  MAX_IMPORTANCE,
  MAX_VALUE_LENGTH,
  preferenceCategorySchema,
  renderProfile,
  renderProfileDetailed,
  writePreference,
  type Preference,
  type PreferenceCategory,
  type RenderedProfile,
  type WriteOptions,
  type WriteRejection,
  type WriteResult,
} from "./preferences.js";

export {
  lastSuccessAt,
  recall,
  recordTask,
  renderPrecedents,
  sanitizeDetail,
  taskOutcomeSchema,
  type LedgerEntry,
  type RecallQuery,
  type RecordOptions,
  type TaskOutcome,
} from "./ledger.js";

export {
  checkTypeSchema,
  claimDue,
  completeRun,
  decideFire,
  digestOf,
  LEASE_MS,
  MAX_CLAIMS_PER_TICK,
  preChecks,
  runPreCheck,
  type CheckType,
  type FireDecision,
  type Monitor,
  type Observation,
} from "./monitors.js";

export {
  BrainCache,
  memoryVersion,
  renderBrain,
  renderBrainCached,
  type BrainDocument,
  type RenderBrainOptions,
} from "./brain.js";

export {
  addDirective,
  directiveKindSchema,
  liveDirectives,
  MAX_RULE_LENGTH,
  renderDirectives,
  revokeDirective,
  type AddDirectiveOptions,
  type Directive,
  type DirectiveKind,
  type DirectiveRejection,
  type DirectiveResult,
} from "./directives.js";

export {
  exportMemory,
  parseMemoryMarkdown,
  type ExportOptions,
  type MemoryExport,
  type ParsedFact,
} from "./export.js";

export {
  deletionScopeSchema,
  isRebuildable,
  issueReceipt,
  NEVER_DELETED,
  plan,
  receiptDigest,
  SCOPE_CATEGORIES,
  verifyReceipt,
  type DeletedCategory,
  type DeletionReceipt,
  type DeletionRequest,
  type DeletionScope,
} from "./deletion.js";
